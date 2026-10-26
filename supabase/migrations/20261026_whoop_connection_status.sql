-- #467: staff roster of which athletes have linked WHOOP. whoop_tokens holds
-- the encrypted OAuth tokens and has no client SELECT policy, so staff read
-- connection status through this staff-gated SECURITY DEFINER function, which
-- never returns a token column.
CREATE OR REPLACE FUNCTION public.whoop_connection_status()
RETURNS TABLE(user_id uuid, connected_at timestamptz, last_synced_at timestamptz, last_sync_error text, last_cycle_date date)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  select t.user_id, t.created_at, t.last_synced_at, t.last_sync_error,
    (select max(c.cycle_date) from whoop_cycles c where c.athlete_id = t.user_id)
  from whoop_tokens t
  where public.get_user_role() = any (array['admin','coach']);
$$;

REVOKE ALL ON FUNCTION public.whoop_connection_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.whoop_connection_status() TO authenticated;
