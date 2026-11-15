-- #491: sessions were not coming off numbered lesson packs.
--
-- A session only left a 5 / 10 / 20 pack when the coach marked the athlete
-- Present or Late (src/sessionUsage.js). Coaches rarely mark attendance (week
-- of 2026-11-09: 23 confirmed sessions, 1 marked attended), so packs never
-- moved: Ben Liperi's 10-pack still read 10 after four lessons.
--
-- auto_deduct_ended_sessions() is the catch-all, run hourly by
-- api/session-autodeduct.js. For every CONFIRMED slot_reservations row whose
-- session has ended (facility time), that has no usage row yet and was NOT
-- marked No-show / Cancelled, it takes one session from the athlete's
-- soonest-expiring counted pack, exactly the way applySessionUsage does:
-- a store_session_usage row (source_type 'training_slot', source_id =
-- reservation id) plus remaining_qty - 1.
--
--   - Unmarked attendance counts as attended. Marking No-show / Cancelled
--     afterwards gives the session back (the client releases the usage row);
--     marking Present / Late finds the row and does nothing.
--   - Only a pack that was paid on or before the session date and had not
--     expired by then is charged, so the first run is also the backfill.
--   - Monthly packages (remaining_qty NULL) are never touched.
--   - Cancelled reservations are not confirmed, so they are never charged
--     here; "counts against them" stays a staff decision (CancellationReview).
--
-- The unique index makes a double charge impossible if the job and a coach's
-- tap race each other.

CREATE UNIQUE INDEX IF NOT EXISTS store_session_usage_training_slot_once
  ON public.store_session_usage (source_id)
  WHERE source_type = 'training_slot';

CREATE OR REPLACE FUNCTION public.auto_deduct_ended_sessions(
  p_dry_run boolean DEFAULT false,
  p_player uuid DEFAULT NULL
)
RETURNS TABLE(reservation_id uuid, player_id uuid, slot_date date, purchase_id uuid, product text, remaining_after integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
#variable_conflict use_column
DECLARE
  c_tz constant text := 'America/Los_Angeles';   -- the facility's wall clock
  c_default_minutes constant integer := 60;
  v_now timestamp := now() AT TIME ZONE c_tz;
  v_used jsonb := '{}'::jsonb;                   -- dry run: sessions "taken" so far per pack
  r record;
  p record;
  v_left integer;
BEGIN
  -- API callers must be the service role or staff; a direct database session
  -- (SQL editor, migrations) is not going through PostgREST and is trusted.
  IF session_user = 'authenticator'
     AND coalesce(auth.role(), '') <> 'service_role'
     AND coalesce(public.get_user_role(), '') NOT IN ('admin', 'coach') THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;

  FOR r IN
    SELECT res.id, res.player_id AS pid, res.slot_date AS sd
      FROM slot_reservations res
      JOIN training_slots s ON s.id = res.slot_id
     WHERE res.status = 'confirmed'
       AND (res.attendance IS NULL OR res.attendance IN ('present', 'late'))
       AND (res.slot_date + s.start_time
            + make_interval(mins => coalesce(s.duration_minutes, c_default_minutes))) <= v_now
       AND (p_player IS NULL OR res.player_id = p_player)
       AND NOT EXISTS (
         SELECT 1 FROM store_session_usage u
          WHERE u.source_type = 'training_slot' AND u.source_id = res.id)
     ORDER BY res.slot_date, s.start_time, res.created_at
  LOOP
    SELECT sp.id, sp.remaining_qty, sp.product_name_snapshot
      INTO p
      FROM store_purchases sp
     WHERE sp.user_id = r.pid
       AND sp.product_kind IN ('package', 'bundle', 'lesson')
       AND sp.status IN ('active', 'paid')
       AND sp.remaining_qty - coalesce((v_used ->> sp.id::text)::int, 0) > 0
       AND (coalesce(sp.paid_at, sp.created_at) AT TIME ZONE c_tz)::date <= r.sd
       AND (sp.expires_at IS NULL OR (sp.expires_at AT TIME ZONE c_tz)::date >= r.sd)
     ORDER BY sp.expires_at ASC NULLS LAST, sp.created_at
     LIMIT 1
       FOR UPDATE OF sp;
    CONTINUE WHEN NOT FOUND;

    IF p_dry_run THEN
      v_used := jsonb_set(v_used, ARRAY[p.id::text],
                          to_jsonb(coalesce((v_used ->> p.id::text)::int, 0) + 1));
      v_left := p.remaining_qty - (v_used ->> p.id::text)::int;
    ELSE
      INSERT INTO store_session_usage (purchase_id, user_id, used_on, source_type, source_id, note)
      VALUES (p.id, r.pid, r.sd, 'training_slot', r.id, 'Auto: booked session ended')
      ON CONFLICT DO NOTHING;
      CONTINUE WHEN NOT FOUND;
      UPDATE store_purchases SET remaining_qty = remaining_qty - 1 WHERE id = p.id
      RETURNING remaining_qty INTO v_left;
    END IF;

    reservation_id := r.id;
    player_id := r.pid;
    slot_date := r.sd;
    purchase_id := p.id;
    product := p.product_name_snapshot;
    remaining_after := v_left;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.auto_deduct_ended_sessions(boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.auto_deduct_ended_sessions(boolean, uuid) TO authenticated, service_role;
