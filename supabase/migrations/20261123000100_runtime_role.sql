-- Apply as the schema owner. Each deployment grants this group to its own
-- server login; database passwords are provisioned outside version control.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'wordpaper_runtime') THEN
    CREATE ROLE wordpaper_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

CREATE OR REPLACE VIEW wordpaper.api_schema AS SELECT 1 AS version;
REVOKE ALL ON wordpaper.api_schema FROM PUBLIC;
GRANT USAGE ON SCHEMA wordpaper TO wordpaper_runtime;
GRANT SELECT ON wordpaper.api_schema TO wordpaper_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  wordpaper.users, wordpaper.password_credentials, wordpaper.sessions, wordpaper.auth_identities,
  wordpaper.oauth_flows, wordpaper.device_flows, wordpaper.email_verifications,
  wordpaper.user_state, wordpaper.user_models, wordpaper.user_speech, wordpaper.app_meta
  TO wordpaper_runtime;
GRANT USAGE ON SEQUENCE wordpaper.users_id_seq TO wordpaper_runtime;
