-- #489: slot-autoclean now also hides unbooked Assessment / NBP+ hour-block
-- occurrences on the facility calendar (facility_events), 5 hours before
-- start. It writes the same tombstone "Delete → this one" writes
-- (deleteFacilityOccurrence: a child row with is_exception = true, or an
-- existing child flipped to true); these two columns mark the rows the job
-- wrote so they can be told apart from a coach's own delete.
--
-- Restore one occurrence:
--   a tombstone the job inserted   → DELETE the row
--   a child row the job flipped    → UPDATE facility_events
--                                       SET is_exception = false, auto_removed_at = NULL, auto_removed_reason = NULL
--   (an inserted tombstone has created_at ≈ auto_removed_at; a flipped child is older)
--
--   SELECT id, recurrence_parent_id, original_date, title, start_time, created_at, auto_removed_at
--   FROM facility_events WHERE auto_removed_at IS NOT NULL ORDER BY auto_removed_at DESC;

ALTER TABLE public.facility_events
  ADD COLUMN IF NOT EXISTS auto_removed_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_removed_reason text;

COMMENT ON COLUMN public.facility_events.auto_removed_at IS
  '#489: set when slot-autoclean hid this occurrence because nobody was booked on it.';
COMMENT ON COLUMN public.facility_events.auto_removed_reason IS
  '#489: why slot-autoclean hid it (unbooked_5h).';

CREATE INDEX IF NOT EXISTS facility_events_auto_removed_idx
  ON public.facility_events (auto_removed_at)
  WHERE auto_removed_at IS NOT NULL;
