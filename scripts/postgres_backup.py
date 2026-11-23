#!/usr/bin/env python3
"""Snapshot WordPaper's private PG schema or restore into an empty database.

Uses the standard libpq PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSFILE/PGPASSWORD
environment. Credentials never appear in subprocess arguments or the manifest.
"""
import argparse
import hashlib
import json
import re
from contextlib import contextmanager
import os
from pathlib import Path
import shutil
import subprocess
import sys
import backup_backgrounds
from datetime import datetime, timezone


def sha256(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def run(argv):
    try:
        return subprocess.run(argv, check=True, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True).stdout.strip()
    except subprocess.CalledProcessError as err:
        # SQL and client errors can contain role names, socket endpoints, data.
        raise ValueError(f'{argv[0]} failed with status {err.returncode}') from None



@contextmanager
def snapshot():
    # pg_dump and the object reference query must see exactly the same committed state.
    with subprocess.Popen(['psql', '-XqAtw', '-v', 'ON_ERROR_STOP=1'], stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True) as proc:
        try:
            proc.stdin.write("""BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT pg_export_snapshot();
SELECT user_id || ' ' || (value_json::jsonb->>'bgImage') FROM wordpaper.user_state
 WHERE namespace='settings' AND value_json::jsonb->>'bgImage' LIKE 'wp-image:%'
 ORDER BY user_id;
\\echo WORDPAPER_SNAPSHOT_READY
""")
            proc.stdin.flush()
            token = proc.stdout.readline().strip()
            if not re.fullmatch(r'[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+', token):
                raise ValueError('Unable to establish read-only PostgreSQL snapshot.')
            refs = []
            for line in proc.stdout:
                if line.rstrip('\n') == 'WORDPAPER_SNAPSHOT_READY':
                    break
                owner, ref = line.rstrip('\n').split(' ', 1)
                backup_backgrounds.object_parts(owner, ref)
                refs.append((owner, ref))
            else:
                raise ValueError('Unable to enumerate background references from snapshot.')
            yield token, refs
        finally:
            proc.stdin.close()
            proc.wait()


def restore_archive(archive, objects):
    # The same transaction that creates the schema checks that its references
    # match the objects whose contents we have verified in the private bucket.
    refs = {row['ownerId']: row['ref'] for row in objects}
    if len(refs) != len(objects):
        raise ValueError('Expected one current wallpaper per account in the manifest.')
    # owner and ref are strictly validated by backup_backgrounds.restore.
    check = """
DO $wp_check$ BEGIN
 IF (SELECT COALESCE(jsonb_object_agg(user_id::text, value_json::jsonb->>'bgImage'), '{}'::jsonb)
     FROM wordpaper.user_state WHERE namespace='settings' AND value_json::jsonb->>'bgImage' LIKE 'wp-image:%')
     IS DISTINCT FROM $wp_manifest$""" + json.dumps(refs) + """$wp_manifest$::jsonb
 THEN RAISE EXCEPTION 'Background references differ from the verified manifest'; END IF;
END $wp_check$;
COMMIT;
"""
    with subprocess.Popen(['psql', '-Xqw', '-v', 'ON_ERROR_STOP=1', '-f', '-'], stdin=subprocess.PIPE,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) as db:
        try:
            db.stdin.write(b'BEGIN;\n')
            db.stdin.flush()
            sql = subprocess.run(['pg_restore', '--no-owner', '--exit-on-error', '--file=-', str(archive)],
                                 stdout=db.stdin, stderr=subprocess.DEVNULL)
            if sql.returncode:
                raise ValueError('Unable to read complete PostgreSQL archive.')
            db.stdin.write(check.encode('utf8'))
            db.stdin.close()
            if db.wait():
                raise ValueError('Restored schema, role grants or background references could not be verified.')
        finally:
            if not db.stdin.closed:
                db.stdin.close()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('mode', choices=['backup', 'restore'])
    p.add_argument('directory', type=Path)
    args = p.parse_args()
    os.umask(0o077)
    database = os.getenv('PGDATABASE', '')
    if not database or '=' in database or '/' in database or database.startswith('-'):
        raise ValueError('Set PGDATABASE to a database name and use PGHOST, PGUSER and PGPASSFILE for the connection.')
    host = os.getenv('PGHOST', '')
    if host and not host.startswith('/') and host not in ('127.0.0.1', 'localhost', '::1'):
        os.environ['PGSSLMODE'] = 'verify-full'
    base = args.directory
    archive = base / 'wordpaper.dump'
    manifest = base / 'manifest.json'
    if args.mode == 'backup':
        base.mkdir(mode=0o700, parents=False, exist_ok=False)
        try:
            version = run(['pg_dump', '--version'])
            with snapshot() as (token, refs):
                run(['pg_dump', '--no-password', '--snapshot', token, '--schema=wordpaper', '--format=custom', '--file', str(archive)])
            objects = backup_backgrounds.backup(base, refs)
            run(['pg_restore', '--list', str(archive)])
            record = {'format': 2, 'objects': objects, 'schema': 'wordpaper', 'pgDump': version,
                      'createdAt': datetime.now(timezone.utc).isoformat(), 'bytes': archive.stat().st_size,
                      'sha256': sha256(archive)}
            manifest.write_text(json.dumps(record, indent=2) + '\n', encoding='utf8')
        except BaseException:
            shutil.rmtree(base)
            raise
    else:
        record = json.loads(manifest.read_text(encoding='utf8'))
        if (record.get('format') != 2 or not isinstance(record.get('objects'), list) or record.get('schema') != 'wordpaper'
                or archive.stat().st_size != record.get('bytes') or sha256(archive) != record.get('sha256')):
            raise ValueError('Backup integrity check failed.')
        existing = run(['psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-c',
                        "SELECT to_regnamespace('wordpaper') IS NOT NULL"])
        if existing != 'f':
            raise ValueError('Restore requires a database without the wordpaper schema.')
        backup_backgrounds.restore(base, record['objects'])
        restore_archive(archive, record['objects'])
    print(args.mode + ' verified: ' + str(base))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as error:
        sys.exit(str(error))
