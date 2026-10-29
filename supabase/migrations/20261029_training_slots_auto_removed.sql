-- =====================================================================
-- #470: auto-remove unbooked coach sessions 6 hours before they start
-- =====================================================================
-- Cordell: "remove those sessions 6 hours before their start time if no one
-- has booked them so they are not hanging onto schedule for a late signup."
--
-- The hourly `slot-autoclean` edge function (Vercel cron → api/slot-autoclean.js)
-- cancels such an occurrence with the SAME per-occurrence exception model the
-- calendar's "Delete → this one" already uses (#279 tombstones, #292 moves):
--
--   * occurrence of a weekly series  → INSERT a tombstone child row
--       (recurrence_parent_id = master, original_date = slot_date = the date,
--        is_exception = true) — byte-for-byte what deleteVirtualOccurrence in
--       Schedule.js writes, plus the two columns below.
--   * one-off slot (repeat_weekly false, no parent) → the same tombstone
--       child keyed on the one-off's own id + date. Every slot reader already
--       runs getSlotDateException on one-off rows too, so this hides it
--       without deleting it. A DELETE would cascade-delete its
--       slot_reservations (FK ON DELETE CASCADE), including declined /
--       cancelled rows whose #306 cancel_reason history matters.
--   * #292 moved child (is_exception = false) → UPDATE that row to
--       is_exception = true. It already IS the exception for its
--       (master, original_date), and the unique index
--       training_slots_one_override_per_date forbids a second one.
--
-- These two columns tell an automatic removal apart from a coach's own
-- delete, and record why.
--
-- RESTORE (no UI yet — tombstones never render anywhere, by design):
--   series / one-off tombstone:  DELETE FROM training_slots WHERE id = '<tombstone id>';
--   converted moved child:       UPDATE training_slots
--                                  SET is_exception = false, auto_removed_at = NULL, auto_removed_reason = NULL
--                                  WHERE id = '<child id>';
-- Find them with:
--   SELECT id, recurrence_parent_id, original_date, slot_date, start_time, coach_id, auto_removed_at
--   FROM training_slots WHERE auto_removed_at IS NOT NULL ORDER BY auto_removed_at DESC;
--
-- No RLS / grant change: training_slots already grants ALL to authenticated
-- and service_role, and the edge function writes with the service role.
--
-- SAFE TO RUN TWICE.
-- =====================================================================

ALTER TABLE public.training_slots
  ADD COLUMN IF NOT EXISTS auto_removed_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_removed_reason text;

COMMENT ON COLUMN public.training_slots.auto_removed_at IS
  '#470: set when the slot-autoclean job tombstoned this occurrence because nobody had booked it 6h before start. NULL = a person made this row.';
COMMENT ON COLUMN public.training_slots.auto_removed_reason IS
  '#470: why slot-autoclean removed it, e.g. ''unbooked_6h''.';

-- The audit / restore query above filters on this.
CREATE INDEX IF NOT EXISTS training_slots_auto_removed_idx
  ON public.training_slots (auto_removed_at)
  WHERE auto_removed_at IS NOT NULL;
