CREATE TABLE IF NOT EXISTS wordpaper.auth_rate_limits (
  client_hash TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_rate_limits_expires_at ON wordpaper.auth_rate_limits(expires_at);
REVOKE ALL ON wordpaper.auth_rate_limits FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON wordpaper.auth_rate_limits TO wordpaper_runtime;
CREATE OR REPLACE VIEW wordpaper.api_schema AS SELECT 2 AS version;
