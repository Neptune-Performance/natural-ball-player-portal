-- #490: NBP Client Data Privacy Disclosure in every account.
--
-- Cordell uploaded "NBP Client Data Privacy Disclosure" to Documents
-- (staff_documents). Like the Facility Fine policy it is the uploaded file,
-- not copy in the repo, and it must be readable by every signed-in user and
-- acknowledged once per uploaded version (re-uploading resets the prompt).
--
-- The acknowledgement is a typed full name (no drawn signature): the document
-- is a disclosure, not a contract.

CREATE TABLE IF NOT EXISTS public.privacy_disclosure_acknowledgements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.staff_documents(id) ON DELETE CASCADE,
  signature_text text NOT NULL CHECK (length(trim(signature_text)) > 1),
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, document_id)
);

CREATE INDEX IF NOT EXISTS privacy_disclosure_ack_document_idx
  ON public.privacy_disclosure_acknowledgements (document_id, acknowledged_at DESC);

ALTER TABLE public.privacy_disclosure_acknowledgements ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.privacy_disclosure_acknowledgements TO authenticated;

DROP POLICY IF EXISTS "privacy_ack_select_own_or_staff" ON public.privacy_disclosure_acknowledgements;
CREATE POLICY "privacy_ack_select_own_or_staff" ON public.privacy_disclosure_acknowledgements
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.get_user_role() = ANY (ARRAY['admin'::text, 'coach'::text]));

DROP POLICY IF EXISTS "privacy_ack_insert_own" ON public.privacy_disclosure_acknowledgements;
CREATE POLICY "privacy_ack_insert_own" ON public.privacy_disclosure_acknowledgements
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "privacy_ack_delete_admin" ON public.privacy_disclosure_acknowledgements;
CREATE POLICY "privacy_ack_delete_admin" ON public.privacy_disclosure_acknowledgements
  FOR DELETE TO authenticated
  USING (public.get_user_role() = 'admin');

-- Everyone signed in may read ONLY this document's row and file (same shape as
-- the Facility Fine / Training Agreement policies).
DROP POLICY IF EXISTS "staff_documents_select_privacy_disclosure_all" ON public.staff_documents;
CREATE POLICY "staff_documents_select_privacy_disclosure_all" ON public.staff_documents
  FOR SELECT TO authenticated
  USING (title ILIKE '%Privacy Disclosure%');

DROP POLICY IF EXISTS "staff_documents_storage_select_privacy_disclosure_all" ON storage.objects;
CREATE POLICY "staff_documents_storage_select_privacy_disclosure_all" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'staff-documents'
    AND EXISTS (
      SELECT 1 FROM public.staff_documents d
       WHERE d.file_path = storage.objects.name
         AND d.title ILIKE '%Privacy Disclosure%'
    )
  );
