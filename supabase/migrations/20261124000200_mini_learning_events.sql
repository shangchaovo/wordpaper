CREATE TABLE IF NOT EXISTS wordpaper.mini_learning_events (
  user_id BIGINT NOT NULL REFERENCES wordpaper.users(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result_json TEXT,
  owner_token TEXT,
  lease_until BIGINT,
  PRIMARY KEY(user_id, event_id)
);
REVOKE ALL ON wordpaper.mini_learning_events FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON wordpaper.mini_learning_events TO wordpaper_runtime;
