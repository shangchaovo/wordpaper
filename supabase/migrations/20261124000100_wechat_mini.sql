CREATE TABLE IF NOT EXISTS wordpaper.mini_bindings (
  user_id BIGINT PRIMARY KEY REFERENCES wordpaper.users(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  openid TEXT NOT NULL,
  UNIQUE (app_id, openid)
);
CREATE TABLE IF NOT EXISTS wordpaper.mini_codes (
  code_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL UNIQUE REFERENCES wordpaper.users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS wordpaper.mini_tickets (
  token_hash TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  openid TEXT NOT NULL,
  code_hash TEXT REFERENCES wordpaper.mini_codes(code_hash) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS mini_tickets_expiry ON wordpaper.mini_tickets(expires_at);
CREATE TABLE IF NOT EXISTS wordpaper.mini_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES wordpaper.mini_bindings(user_id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS mini_sessions_expiry ON wordpaper.mini_sessions(expires_at);
CREATE TABLE IF NOT EXISTS wordpaper.mini_attempts (
  bucket TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS mini_attempts_expiry ON wordpaper.mini_attempts(expires_at);
CREATE TABLE IF NOT EXISTS wordpaper.mini_reminders (
  user_id BIGINT PRIMARY KEY REFERENCES wordpaper.mini_bindings(user_id) ON DELETE CASCADE,
  job_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  at_ms BIGINT NOT NULL,
  timezone TEXT NOT NULL,
  words TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt_at BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS mini_reminders_ready ON wordpaper.mini_reminders(state, attempt_at);

CREATE TABLE IF NOT EXISTS wordpaper.mini_reminder_prefs (
  user_id BIGINT PRIMARY KEY REFERENCES wordpaper.mini_bindings(user_id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL,
  has_grant INTEGER NOT NULL,
  template_id TEXT NOT NULL,
  grant_mode TEXT NOT NULL,
  timezone TEXT NOT NULL,
  cursor_ms BIGINT NOT NULL,
  checked_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS mini_prefs_scan ON wordpaper.mini_reminder_prefs(enabled,has_grant,checked_at);

REVOKE ALL ON wordpaper.mini_bindings, wordpaper.mini_codes, wordpaper.mini_tickets, wordpaper.mini_sessions, wordpaper.mini_attempts, wordpaper.mini_reminders, wordpaper.mini_reminder_prefs FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON wordpaper.mini_bindings, wordpaper.mini_codes, wordpaper.mini_tickets, wordpaper.mini_sessions, wordpaper.mini_attempts, wordpaper.mini_reminders, wordpaper.mini_reminder_prefs TO wordpaper_runtime;
