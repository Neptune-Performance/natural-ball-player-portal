-- #480: Email Image Library. Staff upload images once and drop them into
-- campaign emails from Compose Message.
--
-- Files live in the PUBLIC `email-images` bucket: an email client fetches the
-- <img src> with no session, so the URL has to work for anyone. Nothing
-- private belongs here (the upload form says so). Writes are staff-only;
-- reading the file is public by bucket, reading the catalogue is staff-only.

CREATE TABLE IF NOT EXISTS public.email_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  storage_path TEXT NOT NULL UNIQUE,
  public_url TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  width INTEGER,
  height INTEGER,
  uploaded_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.email_images ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.email_images TO authenticated;
GRANT ALL ON public.email_images TO service_role;

DROP POLICY IF EXISTS email_images_select_staff ON public.email_images;
CREATE POLICY email_images_select_staff ON public.email_images
  FOR SELECT TO authenticated
  USING (public.get_user_role() IN ('admin', 'coach'));

DROP POLICY IF EXISTS email_images_insert_staff ON public.email_images;
CREATE POLICY email_images_insert_staff ON public.email_images
  FOR INSERT TO authenticated
  WITH CHECK (public.get_user_role() IN ('admin', 'coach'));

DROP POLICY IF EXISTS email_images_update_staff ON public.email_images;
CREATE POLICY email_images_update_staff ON public.email_images
  FOR UPDATE TO authenticated
  USING (public.get_user_role() IN ('admin', 'coach'))
  WITH CHECK (public.get_user_role() IN ('admin', 'coach'));

DROP POLICY IF EXISTS email_images_delete_staff ON public.email_images;
CREATE POLICY email_images_delete_staff ON public.email_images
  FOR DELETE TO authenticated
  USING (public.get_user_role() IN ('admin', 'coach'));

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('email-images', 'email-images', true, 5242880,
        ARRAY['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "email-images staff insert" ON storage.objects;
CREATE POLICY "email-images staff insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'email-images' AND public.get_user_role() IN ('admin', 'coach'));

DROP POLICY IF EXISTS "email-images staff delete" ON storage.objects;
CREATE POLICY "email-images staff delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'email-images' AND public.get_user_role() IN ('admin', 'coach'));

DROP POLICY IF EXISTS "email-images staff select" ON storage.objects;
CREATE POLICY "email-images staff select" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'email-images' AND public.get_user_role() IN ('admin', 'coach'));
