-- #494: athletes could not upload a profile image ("new row violates
-- row-level security policy"). The avatars bucket had INSERT / UPDATE / DELETE
-- policies but no SELECT policy, and the storage API has to read the object
-- row back for an upload (always for `upsert: true`, which Profile.js used).
-- No upload had succeeded since 2026-05-22.
--
-- The bucket is public, so images are still served to anyone by URL without
-- this; the policy only covers API reads (upload read-back, list) and is
-- scoped the same way as the write policies, plus staff.

DROP POLICY IF EXISTS "avatars_select_own_or_staff" ON storage.objects;
CREATE POLICY "avatars_select_own_or_staff" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'avatars'
    AND (
      (storage.foldername(name))[1] = (auth.uid())::text
      OR public.get_user_role() = ANY (ARRAY['admin'::text, 'coach'::text])
    )
  );
