-- Apply only to a Supabase project with Storage enabled.
BEGIN;
INSERT INTO storage.buckets (id, name, public)
VALUES ('wordpaper-backgrounds', 'wordpaper-backgrounds', false)
ON CONFLICT (id) DO NOTHING;
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM storage.buckets WHERE id = 'wordpaper-backgrounds' AND public IS FALSE) THEN
    RAISE EXCEPTION 'Expected a private WordPaper bucket';
  END IF;
END $$;

-- WordPaper sessions are validated only by the backend. Even if an unrelated
-- permissive policy is added later, these objects remain backend-only.
DROP POLICY IF EXISTS wordpaper_backend_only ON storage.objects;
CREATE POLICY wordpaper_backend_only ON storage.objects AS RESTRICTIVE
FOR ALL TO anon, authenticated
USING (bucket_id <> 'wordpaper-backgrounds')
WITH CHECK (bucket_id <> 'wordpaper-backgrounds');
COMMIT;
