-- Supabase-only. Run as the database operator after configuring the receiver,
-- or after verifying that no real reservations exist yet. Reinstall as the same
-- role to preserve retry history and replace this one named cron job.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE SCHEMA IF NOT EXISTS wordpaper_ops_http;
REVOKE ALL ON SCHEMA wordpaper_ops_http FROM PUBLIC;
CREATE EXTENSION IF NOT EXISTS http WITH SCHEMA wordpaper_ops_http;
CREATE SCHEMA IF NOT EXISTS wordpaper_ops;
REVOKE ALL ON SCHEMA wordpaper_ops FROM PUBLIC;

CREATE OR REPLACE FUNCTION wordpaper_ops.check_wake_http_privileges()
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
    WHERE e.extname='http' AND n.nspname='wordpaper_ops_http'
  ) OR EXISTS (
    SELECT 1 FROM pg_namespace n, LATERAL aclexplode(n.nspacl) acl
    LEFT JOIN pg_roles r ON r.oid=acl.grantee
    WHERE n.nspname IN ('wordpaper_ops_http','wordpaper_ops') AND acl.grantee<>n.nspowner
      AND NOT coalesce(r.rolsuper,false) AND coalesce(r.rolname,'') NOT IN ('postgres','supabase_admin')
  ) OR EXISTS (
    SELECT 1 FROM pg_roles r, pg_namespace n
    WHERE n.nspname IN ('wordpaper_ops_http','wordpaper_ops')
      AND r.rolname IN ('anon','authenticated','service_role','authenticator','wordpaper_runtime')
      AND has_schema_privilege(r.oid,n.oid,'USAGE')
  ) THEN
    RAISE EXCEPTION 'WordPaper wake requires the http extension in its private schema and operator-only access';
  END IF;
END
$fn$;
REVOKE ALL ON FUNCTION wordpaper_ops.check_wake_http_privileges() FROM PUBLIC;
SELECT wordpaper_ops.check_wake_http_privileges();

-- The HTTPS receiver may update/delete the reservation while this transaction
-- waits on the network. Keep the backoff table independent of application rows.
CREATE TABLE IF NOT EXISTS wordpaper_ops.mini_reminder_wakes (
  user_id bigint PRIMARY KEY,
  job_digest bytea NOT NULL,
  deliveries smallint NOT NULL CHECK (deliveries BETWEEN 1 AND 12),
  next_wake_ms bigint NOT NULL
);
REVOKE ALL ON wordpaper_ops.mini_reminder_wakes FROM PUBLIC;

CREATE OR REPLACE VIEW wordpaper_ops.authorized_mini_wakes WITH (security_invoker=true) AS
  SELECT r.user_id,r.job_id,r.attempt_at,r.at_ms
  FROM wordpaper.mini_reminders r
  JOIN wordpaper.mini_bindings b ON b.user_id=r.user_id
  JOIN wordpaper.mini_reminder_prefs p ON p.user_id=r.user_id
  WHERE b.app_id='wx16d8cd2cc7c3c566' AND p.enabled=1 AND p.has_grant=1
    AND r.state='scheduled' AND r.template_id<>'' AND r.template_id=p.template_id
    AND r.words LIKE '[{%' AND r.job_id ~ '^[A-Za-z0-9_-]{43}$';
REVOKE ALL ON wordpaper_ops.authorized_mini_wakes FROM PUBLIC;

CREATE OR REPLACE FUNCTION wordpaper_ops.wake_due_mini_reminders()
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $fn$
DECLARE
  ts bigint := floor(extract(epoch FROM clock_timestamp())*1000);
  attempted integer := 0;
  job record;
BEGIN
  IF NOT pg_try_advisory_xact_lock(2037800024,1) THEN RETURN 0; END IF;
  -- Remove obsolete bookkeeping without locking any application rows.
  DELETE FROM wordpaper_ops.mini_reminder_wakes w WHERE NOT EXISTS (
    SELECT 1 FROM wordpaper.mini_reminders r WHERE r.user_id=w.user_id
  );
  FOR job IN
    SELECT a.user_id,a.job_id,sha256(convert_to(a.job_id,'UTF8')) AS job_digest,
      coalesce(w.deliveries,0) AS deliveries
    FROM wordpaper_ops.authorized_mini_wakes a
    LEFT JOIN wordpaper_ops.mini_reminder_wakes w ON w.user_id=a.user_id AND w.job_digest=sha256(convert_to(a.job_id,'UTF8'))
    WHERE a.at_ms<=ts AND a.attempt_at<=ts AND (w.user_id IS NULL OR (w.next_wake_ms<=ts AND w.deliveries<12))
    ORDER BY a.attempt_at,a.user_id LIMIT 8
  LOOP
    -- Other users can act while a preceding HTTPS call is in flight.
    IF NOT EXISTS (SELECT 1 FROM wordpaper_ops.authorized_mini_wakes a
      WHERE a.user_id=job.user_id AND a.job_id=job.job_id AND a.at_ms<=ts AND a.attempt_at<=ts) THEN CONTINUE; END IF;
    IF attempted=0 THEN
      PERFORM wordpaper_ops.check_wake_http_privileges();
      -- http.timeout_msec is supported throughout 1.6, including builds
      -- predating the per-curl-option GUCs. Settings are local to this call.
      PERFORM set_config('http.timeout_msec','4000',true);
      PERFORM set_config('http.curlopt_timeout_ms','4000',true);
      PERFORM set_config('http.curlopt_connecttimeout_ms','2000',true);
    END IF;
    INSERT INTO wordpaper_ops.mini_reminder_wakes(user_id,job_digest,deliveries,next_wake_ms)
      VALUES (job.user_id,job.job_digest,job.deliveries+1,ts+least(3600000,180000*(1<<job.deliveries)))
      ON CONFLICT(user_id) DO UPDATE SET job_digest=excluded.job_digest,
        deliveries=excluded.deliveries,next_wake_ms=excluded.next_wake_ms;
    attempted := attempted+1;
    BEGIN
      -- A direct synchronous call has no shared header/response queue. A 202
      -- acknowledges only a wake attempt; delivery state stays with the receiver.
      PERFORM wordpaper_ops_http.http(('POST',
        'https://wordpaper-api.onrender.com/api/mini/reminder/wake',
        ARRAY[wordpaper_ops_http.http_header('Authorization','WordPaper-Job '||job.job_id),
              wordpaper_ops_http.http_header('X-WordPaper-Account',job.user_id::text)],
        'application/json','{}')::wordpaper_ops_http.http_request);
    EXCEPTION WHEN OTHERS THEN
      -- Render may be cold. Retain the outer retry record; never log the header,
      -- upstream response, receiver error text, or the reservation token.
      NULL;
    END;
  END LOOP;
  RETURN attempted;
END
$fn$;
REVOKE ALL ON FUNCTION wordpaper_ops.wake_due_mini_reminders() FROM PUBLIC;
SELECT cron.schedule('wordpaper-mini-reminder-wake','* * * * *','SELECT wordpaper_ops.wake_due_mini_reminders()');
COMMIT;

-- Disable only this cron job, including on repeated maintenance runs:
-- SELECT cron.unschedule(jobid) FROM cron.job
-- WHERE jobname='wordpaper-mini-reminder-wake' AND username=current_user;
