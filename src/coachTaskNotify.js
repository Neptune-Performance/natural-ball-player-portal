// #469: tell the coach about a task they've just been given.
//
// Called from Admin Settings → Coach Tasks right after a successful insert
// (or a reassignment). The `coach-task-notify` edge function sends one email
// per task now — and an SMS too once Twilio secrets are configured — and logs
// each send to `coach_task_notifications` (unique per task/coach/channel, so
// a repeat call never double-sends). The daily 7am digest is a separate cron
// (api/coach-task-digest.js).
//
// Never throws: the task is already saved, so a failed notification is only
// worth a small note in the UI, not an error dialog.
import { supabase, supabaseUrl, supabaseAnonKey } from './supabaseClient';

export async function notifyTasksAssigned(taskIds) {
  const ids = (taskIds || []).filter(Boolean);
  if (!ids.length) return { ok: true, sent: 0, failed: 0, skipped: 0 };
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return { ok: false, error: 'Not signed in' };
    const res = await fetch(`${supabaseUrl}/functions/v1/coach-task-notify?action=assigned`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
        apikey: supabaseAnonKey,
      },
      body: JSON.stringify({ task_ids: ids }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
    return { ...body, ok: (body.failed || 0) === 0, error: body.failed ? (body.errors || []).join('; ') : null };
  } catch (e) {
    return { ok: false, error: e.message || 'network error' };
  }
}

// Latest successful notification per task (kind 'assigned') and per coach
// (kind 'daily'), for the "Notified …" line on the Coach Tasks cards.
// Admin-only read (RLS); returns empty maps on any error so the list still
// renders (e.g. before the migration is applied).
export async function fetchLastNotified() {
  const byTask = {};
  const byCoachDaily = {};
  try {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data, error } = await supabase
      .from('coach_task_notifications')
      .select('id, kind, task_id, coach_id, channel, sent_at')
      .eq('status', 'sent')
      .gte('created_at', since)
      .order('sent_at', { ascending: false })
      .order('id')
      .limit(1000);
    if (error) return { byTask, byCoachDaily };
    for (const r of data || []) {
      if (r.kind === 'assigned' && r.task_id && !byTask[r.task_id]) byTask[r.task_id] = r;
      if (r.kind === 'daily' && !byCoachDaily[r.coach_id]) byCoachDaily[r.coach_id] = r;
    }
  } catch {}
  return { byTask, byCoachDaily };
}

export function formatNotifiedAt(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
