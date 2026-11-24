-- Optional Supabase operation, run as the database operator when the HTTPS
-- receiver and template are ready, or before rollout after verifying that the
-- eligible queue is empty. Reinstallation preserves retry history and replaces
-- the named cron job for the same operator.
-- Pause (idempotent): SELECT cron.unschedule(jobid) FROM cron.job
--   WHERE jobname='wordpaper-mini-reminder-wake' AND username=current_user;
-- A request already enqueued can complete. The receiver always rechecks consent.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $install$
DECLARE
  net_role name;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname='pg_net') THEN
    CREATE EXTENSION pg_net WITH SCHEMA extensions;
    -- Upstream grants PUBLIC access to both shared tables. Set private defaults
    -- only when creating the extension for the first time on this project.
    REVOKE ALL PRIVILEGES ON net.http_request_queue, net._http_response FROM PUBLIC;
    REVOKE ALL PRIVILEGES ON SCHEMA net FROM PUBLIC;
    -- Some Supabase releases grant schema usage directly in an extension
    -- installation hook (including anon/authenticated). This new dedicated
    -- installation keeps postgres/owner access for the worker and cron.
    FOR net_role IN
      SELECT DISTINCT r.rolname FROM pg_catalog.pg_namespace n,
        LATERAL pg_catalog.aclexplode(n.nspacl) acl
        JOIN pg_catalog.pg_roles r ON r.oid=acl.grantee
      WHERE n.nspname='net' AND r.oid<>n.nspowner AND NOT r.rolsuper
        AND r.rolname NOT IN ('postgres','supabase_admin')
    LOOP
      EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA net FROM %I', net_role);
    END LOOP;
  END IF;
END
$install$;

CREATE SCHEMA IF NOT EXISTS wordpaper_ops;
REVOKE ALL ON SCHEMA wordpaper_ops FROM PUBLIC;

CREATE OR REPLACE FUNCTION wordpaper_ops.check_wake_queue_privileges()
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $fn$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    CROSS JOIN LATERAL (
      SELECT grantee, privilege_type FROM aclexplode(c.relacl)
      UNION ALL
      SELECT g.grantee, g.privilege_type FROM pg_attribute a, LATERAL aclexplode(a.attacl) g
        WHERE a.attrelid = c.oid AND NOT a.attisdropped
    ) acl
    LEFT JOIN pg_roles role ON role.oid = acl.grantee
    WHERE c.oid IN ('net.http_request_queue'::regclass, 'net._http_response'::regclass)
      AND (acl.privilege_type = 'TRIGGER' OR
        (c.oid = 'net.http_request_queue'::regclass AND acl.privilege_type IN ('SELECT','UPDATE','DELETE','TRUNCATE')))
      AND acl.grantee <> c.relowner AND NOT coalesce(role.rolsuper, false)
      AND coalesce(role.rolname, '') NOT IN ('postgres','supabase_admin')
  ) OR EXISTS (
    SELECT 1 FROM pg_trigger WHERE NOT tgisinternal
      AND tgrelid IN ('net.http_request_queue'::regclass,'net._http_response'::regclass)
  ) OR EXISTS (
    -- Never assume an extension-version-specific SECURITY DEFINER routine is
    -- safe to expose. Both schema USAGE and effective EXECUTE (including role
    -- memberships and PUBLIC) must be considered. Check net and any additional
    -- schema used by an actual pg_net member routine.
    SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace
    CROSS JOIN pg_roles r
    WHERE f.prosecdef AND (n.nspname='net' OR EXISTS (
      SELECT 1 FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid
      WHERE d.classid='pg_proc'::regclass AND d.objid=f.oid AND d.deptype='e'
        AND d.refclassid='pg_extension'::regclass AND e.extname='pg_net'))
      -- These predefined database-wide administrator groups intrinsically have
      -- schema USAGE even in a private schema. Ordinary member roles are checked.
      AND NOT r.rolsuper AND r.rolname NOT IN ('postgres','supabase_admin','pg_read_all_data','pg_write_all_data')
      AND r.oid<>n.nspowner
      AND has_schema_privilege(r.oid,n.oid,'USAGE') AND has_function_privilege(r.oid,f.oid,'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'WordPaper wake disabled: pg_net queue privileges, triggers or privileged routines require operator review';
  END IF;
END
$fn$;
REVOKE ALL ON FUNCTION wordpaper_ops.check_wake_queue_privileges() FROM PUBLIC;
-- An existing pg_net installation keeps its ACLs. Abort without scheduling if
-- shared queue contents are exposed. Review other integrations before tightening
-- an existing queue. Never grant new global rights to the WordPaper runtime.
SELECT wordpaper_ops.check_wake_queue_privileges();

CREATE TABLE IF NOT EXISTS wordpaper_ops.mini_reminder_wakes (
  user_id bigint PRIMARY KEY REFERENCES wordpaper.mini_reminders(user_id) ON DELETE CASCADE,
  job_digest bytea NOT NULL,
  deliveries smallint NOT NULL CHECK (deliveries BETWEEN 1 AND 12),
  next_wake_ms bigint NOT NULL
);
REVOKE ALL ON wordpaper_ops.mini_reminder_wakes FROM PUBLIC;

CREATE OR REPLACE FUNCTION wordpaper_ops.wake_due_mini_reminders()
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $fn$
DECLARE
  ts bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
  queued integer := 0;
  job record;
BEGIN
  -- Manual checks and concurrent schedulers cannot enqueue the same batch.
  IF NOT pg_try_advisory_xact_lock(2037800024, 1) THEN RETURN 0; END IF;
  FOR job IN
    SELECT r.user_id, r.job_id, sha256(convert_to(r.job_id,'UTF8')) AS job_digest,
      coalesce(w.deliveries, 0) AS prior_deliveries
    FROM wordpaper.mini_reminders r
    JOIN wordpaper.mini_bindings b ON b.user_id = r.user_id
    JOIN wordpaper.mini_reminder_prefs p ON p.user_id = r.user_id
    LEFT JOIN wordpaper_ops.mini_reminder_wakes w ON w.user_id = r.user_id
      AND w.job_digest = sha256(convert_to(r.job_id,'UTF8'))
    WHERE b.app_id = 'wx16d8cd2cc7c3c566' AND p.enabled = 1 AND p.has_grant = 1
      AND r.state = 'scheduled' AND r.template_id <> '' AND r.template_id = p.template_id
      -- The service writes a compact JSON array of booked word objects.
      AND r.words LIKE '[{%' AND r.job_id ~ '^[A-Za-z0-9_-]{43}$'
      AND r.at_ms <= ts AND r.attempt_at <= ts
      AND (w.user_id IS NULL OR (w.next_wake_ms <= ts AND w.deliveries < 12))
    ORDER BY r.attempt_at, r.user_id LIMIT 20
    FOR UPDATE OF r, b, p SKIP LOCKED
  LOOP
    IF queued = 0 THEN PERFORM wordpaper_ops.check_wake_queue_privileges(); END IF;
    -- pg_net starts this request after COMMIT. Its queue insert and the retry
    -- lease below roll back together on failure. The job capability exists only
    -- in the private request header. Cron history contains only a function call.
    PERFORM net.http_post(
      url := 'https://wordpaper-api.onrender.com/api/mini/reminder/wake',
      headers := jsonb_build_object('Content-Type','application/json',
        'Authorization','WordPaper-Job ' || job.job_id,'X-WordPaper-Account',job.user_id::text),
      body := '{}'::jsonb, timeout_milliseconds := 90000);
    INSERT INTO wordpaper_ops.mini_reminder_wakes(user_id,job_digest,deliveries,next_wake_ms)
      VALUES (job.user_id, job.job_digest, job.prior_deliveries + 1,
        ts + least(3600000, 180000 * (1 << job.prior_deliveries)))
      ON CONFLICT (user_id) DO UPDATE SET job_digest = excluded.job_digest,
        deliveries = excluded.deliveries, next_wake_ms = excluded.next_wake_ms;
    queued := queued + 1;
  END LOOP;
  RETURN queued;
END
$fn$;
REVOKE ALL ON FUNCTION wordpaper_ops.wake_due_mini_reminders() FROM PUBLIC;
SELECT cron.schedule('wordpaper-mini-reminder-wake', '* * * * *',
  'SELECT wordpaper_ops.wake_due_mini_reminders()');
COMMIT;

-- Twelve cold-start deliveries without completion stop that particular job.
-- After fixing the receiver, an operator can delete only the affected account's
-- row in wordpaper_ops.mini_reminder_wakes to rearm it. Each new reservation
-- has a new digest and starts automatically. Removing the cron job does not
-- remove either extension or change other scheduled jobs.
