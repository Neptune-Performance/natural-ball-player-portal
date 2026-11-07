-- #485: when a coach is removed (users.role leaves coach/admin), their lesson
-- slots kept showing on every calendar (Joshua Sale's series ran to Feb 2027).
-- On that role change:
--   * an ongoing weekly series is ended yesterday (history stays),
--   * a slot/series that hasn't started yet is deleted,
-- but ONLY when it has no live (pending/confirmed) booking from today on and no
-- exception children, so a booked athlete never silently loses a session —
-- staff handle those by hand. Never touches past rows (cascade would wipe
-- reservation history).

CREATE OR REPLACE FUNCTION public.end_slots_for_removed_coach()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.role IN ('coach', 'admin') AND NEW.role IS DISTINCT FROM OLD.role
     AND NEW.role NOT IN ('coach', 'admin') THEN

    UPDATE training_slots t
       SET repeat_end_date = current_date - 1
     WHERE t.coach_id = NEW.id
       AND t.repeat_weekly
       AND t.slot_date < current_date
       AND (t.repeat_end_date IS NULL OR t.repeat_end_date >= current_date)
       AND NOT EXISTS (
         SELECT 1 FROM slot_reservations r
          WHERE r.slot_id = t.id AND r.slot_date >= current_date
            AND r.status IN ('pending', 'confirmed'));

    DELETE FROM training_slots t
     WHERE t.coach_id = NEW.id
       AND t.slot_date >= current_date
       AND t.recurrence_parent_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM slot_reservations r WHERE r.slot_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM training_slots c WHERE c.recurrence_parent_id = t.id)
       AND NOT EXISTS (SELECT 1 FROM public_bookings b
                        WHERE b.source_type = 'training_slot' AND b.source_id = t.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_end_slots_for_removed_coach ON public.users;
CREATE TRIGGER users_end_slots_for_removed_coach
  AFTER UPDATE OF role ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.end_slots_for_removed_coach();
