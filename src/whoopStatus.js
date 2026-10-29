import { supabase } from './supabaseClient';

// #473: one athlete's WHOOP link state for the profile header icon. Same
// "stale" rule as the Coach Tools WHOOP roster (#467): linked, but the last
// sync failed or the newest cycle is more than WHOOP_STALE_DAYS old.
export const WHOOP_STALE_DAYS = 3;

const daysSince = (isoDate) =>
  Math.floor((Date.now() - new Date(`${isoDate}T00:00:00`).getTime()) / 86400000);

// 'connected' | 'stale' | 'none', or null when the read failed (show nothing
// rather than a red icon the athlete can't do anything about).
export async function fetchWhoopStatus(userId) {
  const { data, error } = await supabase.rpc('whoop_connection_for', { p_user_id: userId });
  if (error) {
    console.error('Error loading WHOOP status:', error);
    return null;
  }
  const row = (data || [])[0];
  if (!row) return 'none';
  if (row.last_sync_error || !row.last_cycle_date || daysSince(row.last_cycle_date) > WHOOP_STALE_DAYS) return 'stale';
  return 'connected';
}
