-- #501 — deleting a former coach failed with "Error deleting user: {}".
--
-- Two foreign keys to public.users were declared ON DELETE SET NULL on a
-- column that is also NOT NULL, so Postgres could never carry out its own
-- delete rule: removing any user who had written a player note (or sent a
-- Work Portal message) raised
--   23502 null value in column "created_by" of relation "player_notes"
-- inside auth.admin.deleteUser(), which GoTrue reports as an empty error.
-- Joshua Sale had 26 notes and Micah Yonamine 37, so neither could be deleted.
--
-- The delete rule is the intended behaviour (an athlete's notes and a
-- channel's history must outlive the staff member who wrote them), so the
-- NOT NULL is what goes. The app already renders a missing author
-- (`note.author?.full_name`, `m.sender?.full_name`).
--
-- Every other FK to public.users / auth.users was checked on 2026-11-25:
-- these were the only two SET NULL + NOT NULL pairs, and there are no
-- RESTRICT / NO ACTION ones.

ALTER TABLE public.player_notes ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE public.work_messages ALTER COLUMN sender_id DROP NOT NULL;

COMMENT ON COLUMN public.player_notes.created_by IS
  'Author. NULL once that staff account has been deleted (FK is ON DELETE SET NULL, #501).';
COMMENT ON COLUMN public.work_messages.sender_id IS
  'Sender. NULL once that staff account has been deleted (FK is ON DELETE SET NULL, #501).';

-- facility_events.coach_ids / athlete_ids are uuid[] columns, which cannot
-- carry a foreign key, so a deleted user's id used to stay in them forever
-- (46 events still listed the two coaches above). Scrub them on delete.
CREATE OR REPLACE FUNCTION public.users_scrub_array_refs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.facility_events
     SET coach_ids = array_remove(coach_ids, OLD.id)
   WHERE coach_ids @> ARRAY[OLD.id];
  UPDATE public.facility_events
     SET athlete_ids = array_remove(athlete_ids, OLD.id)
   WHERE athlete_ids @> ARRAY[OLD.id];
  RETURN OLD;
END;
$$;

CREATE OR REPLACE TRIGGER users_scrub_array_refs
  AFTER DELETE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.users_scrub_array_refs();
