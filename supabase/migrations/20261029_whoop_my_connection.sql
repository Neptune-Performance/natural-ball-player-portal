-- #473: the profile header shows a WHOOP heartbeat icon (green = linked and
-- syncing, red = not linked or no recent data). whoop_tokens has no client
-- SELECT policy and whoop_connection_status() is staff-only, so this returns
-- one athlete's status to that athlete or to staff. Never returns a token.
CREATE OR REPLACE FUNCTION public.whoop_connection_for(p_user_id uuid)
RETURNS TABLE(connected_at timestamptz, last_synced_at timestamptz, last_sync_error text, last_cycle_date date)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  select t.created_at, t.last_synced_at, t.last_sync_error,
    (select max(c.cycle_date) from whoop_cycles c where c.athlete_id = t.user_id)
  from whoop_tokens t
  where t.user_id = p_user_id
    and (p_user_id = auth.uid() or public.get_user_role() = any (array['admin','coach']));
$$;

REVOKE ALL ON FUNCTION public.whoop_connection_for(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.whoop_connection_for(uuid) TO authenticated;
