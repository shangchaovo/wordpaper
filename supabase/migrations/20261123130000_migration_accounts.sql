-- Owned by the migration role. Runtime role grants apply only to application tables.
CREATE TABLE IF NOT EXISTS wordpaper.migration_accounts (
  source_instance TEXT NOT NULL,
  source_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL REFERENCES wordpaper.users(id) ON DELETE CASCADE,
  PRIMARY KEY(source_instance, source_id),
  UNIQUE(source_instance, user_id)
);
CREATE TABLE IF NOT EXISTS wordpaper.migration_receipts (
  source_instance TEXT PRIMARY KEY,
  snapshot_hash TEXT NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
REVOKE ALL ON wordpaper.migration_accounts, wordpaper.migration_receipts FROM PUBLIC;
