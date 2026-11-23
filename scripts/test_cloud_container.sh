#!/usr/bin/env bash
# Run the production image against an isolated, TLS-enabled PostgreSQL 17.
set -euo pipefail
root=$(git rev-parse --show-toplevel)
temp=$(mktemp -d)
run_id="wp-smoke-$(openssl rand -hex 6)"
image="$run_id:ci"
cleanup() {
  docker rm -fv "$run_id-api" "$run_id-db" "$run_id-no-dsn" >/dev/null 2>&1 || true
  docker network rm "$run_id" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
  rm -rf "$temp"
}
trap cleanup EXIT

# Seed a throwaway source tree. No developer configuration enters the build.
mkdir -p "$temp/context" "$temp/tls"
git -C "$root" archive HEAD | tar -x -C "$temp/context"
cd "$temp/context"
for file in .env .wordpaper-data/wordpaper.sqlite scripts/dist/backup.json scripts/node-dist/extra.key lib/.env.local data/private.sqlite-wal; do
  mkdir -p "$(dirname "$file")"
  printf 'wordpaper-ci-private-sentinel\n' > "$file"
done
docker build --tag "$image" .
docker run --rm --entrypoint sh "$image" -euc '
  for file in .env .git .wordpaper-data scripts/dist scripts/node-dist/extra.key lib/.env.local data/private.sqlite-wal; do
    test ! -e "/app/$file"
  done
  test -f "/app/scripts/每日壁纸伴侣.zip"
  ! unzip -l "/app/scripts/每日壁纸伴侣.zip" | grep -E "private.sqlite|[.]env[.]local|extra[.]key"
'
# A missing mandatory DSN must produce a startup error. Bound the wait in
# case a regression starts a fallback SQLite service instead.
if timeout 20 docker run --rm --name "$run_id-no-dsn" -e WORDPAPER_STORAGE_BACKEND=postgres "$image" >"$temp/missing.log" 2>&1; then
  echo 'Postgres mode unexpectedly started without a DSN' >&2
  exit 1
fi
grep -Fq '缺少 WORDPAPER_DATABASE_URL' "$temp/missing.log"

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=WordPaper-Test-CA \
  -keyout "$temp/ca.key" -out "$temp/tls/ca.crt" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj /CN=db -keyout "$temp/tls/server.key" -out "$temp/server.csr" 2>/dev/null
printf 'subjectAltName=DNS:db\nextendedKeyUsage=serverAuth\n' > "$temp/extensions"
openssl x509 -req -days 1 -in "$temp/server.csr" -CA "$temp/tls/ca.crt" -CAkey "$temp/ca.key" \
  -CAcreateserial -extfile "$temp/extensions" -out "$temp/tls/server.crt" 2>/dev/null
chmod 755 "$temp/tls"
chmod 644 "$temp/tls/ca.crt" "$temp/tls/server.crt"
docker network create "$run_id" >/dev/null
admin_password=$(openssl rand -hex 24)
api_password=$(openssl rand -hex 24)
docker run -d --name "$run_id-db" --network "$run_id" --network-alias db \
  -e POSTGRES_PASSWORD="$admin_password" -e POSTGRES_DB=wordpaper \
  -v "$temp/tls:/fixture:ro" --entrypoint sh postgres:17 -ec '
  install -m 600 -o postgres -g postgres /fixture/server.key /tmp/pg-server.key
  exec docker-entrypoint.sh postgres -c ssl=on -c ssl_key_file=/tmp/pg-server.key -c ssl_cert_file=/fixture/server.crt
' >/dev/null
for _ in {1..60}; do
  if docker exec "$run_id-db" pg_isready -h 127.0.0.1 -d wordpaper -U postgres >/dev/null; then break; fi
  sleep 1
done
for migration in supabase/migrations/*.sql; do
  docker exec -i "$run_id-db" psql -v ON_ERROR_STOP=1 -U postgres -d wordpaper < "$migration" >/dev/null
done
printf "CREATE ROLE smoke_api LOGIN PASSWORD '%s' IN ROLE wordpaper_runtime;\n" "$api_password" |
  docker exec -i "$run_id-db" psql -v ON_ERROR_STOP=1 -U postgres -d wordpaper >/dev/null

# The image's own HEALTHCHECK must honor a non-default port in production.
docker run -d --name "$run_id-api" --network "$run_id" --health-interval=2s --health-retries=8 \
  -e PORT=19091 -e WORDPAPER_STORAGE_BACKEND=postgres -e WORDPAPER_MODEL_KEY_BASE64="$(openssl rand -base64 32)" \
  -e WORDPAPER_DATABASE_URL="postgresql://smoke_api:$api_password@db:5432/wordpaper?sslmode=verify-full" \
  -e NODE_EXTRA_CA_CERTS=/fixture/ca.crt -v "$temp/tls/ca.crt:/fixture/ca.crt:ro" "$image" >/dev/null
for _ in {1..30}; do
  [[ $(docker inspect -f '{{.State.Health.Status}}' "$run_id-api") == healthy ]] && break
  sleep 1
done
if [[ $(docker inspect -f '{{.State.Health.Status}}' "$run_id-api") != healthy ]]; then
  docker logs --tail=30 "$run_id-api"
  exit 1
fi
docker exec "$run_id-api" node -e '
(async () => {
  const r = await fetch("http://127.0.0.1:19091/healthz"), body = await r.json();
  if (!r.ok || !body.ok || body.mode !== "public" || body.database !== "postgres" ||
      body.schemaVersion !== 2 || body.version !== require("./package.json").version) throw Error("Invalid readiness response");
  if (require("node:fs").existsSync("/data/wordpaper.sqlite")) throw Error("Unexpected SQLite fallback");
})().catch(e => { console.error(e.message); process.exitCode = 1; });
'
echo 'PASS production container, private file exclusions, fail-closed DSN, verified TLS, restricted role, dynamic port and DB readiness'
