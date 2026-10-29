-- #469: notify coaches of their tasks (Admin Settings → Coach Tasks).
--
-- Cordell wants a coach to hear about a task the moment it's assigned AND get
-- one morning message listing what's on their plate today. Delivered by the
-- `coach-task-notify` edge function: email via Resend now, SMS via Twilio once
-- TWILIO_* secrets exist (an unconfigured channel writes no rows at all).
--
-- One row per (coach, kind, channel, task-or-day). The edge function upserts
-- the row as 'pending' with ignoreDuplicates and only sends rows still
-- 'pending', so a retried cron or a double-clicked Assign can never
-- double-send. `dedupe_key` is a generated column so a single REGULAR unique
-- index covers both kinds (partial indexes don't work with PostgREST upsert —
-- same trick as work_message_reads):
--   kind 'assigned' → task_id   (one per task per coach per channel; a task
--                                 reassigned back to someone who already had
--                                 it is not re-sent)
--   kind 'daily'    → digest_date (one digest per coach per facility day)
--
-- Apply: paste into the SQL editor / `supabase db query --linked -f <this>`.

CREATE TABLE IF NOT EXISTS public.coach_task_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  coach_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('assigned', 'daily')),
  task_id UUID REFERENCES public.coach_tasks(id) ON DELETE CASCADE,
  digest_date DATE,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  destination TEXT,                               -- address / E.164 number used
  task_count INT,                                 -- daily: tasks listed
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  error TEXT,
  provider_id TEXT,                               -- Resend id / Twilio SID
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- date::text is only STABLE (DateStyle), which a generated column rejects;
  -- days-since-2000 is an immutable integer and just as unique.
  dedupe_key TEXT GENERATED ALWAYS AS (
    CASE WHEN kind = 'assigned' THEN task_id::text
         ELSE 'd' || (digest_date - DATE '2000-01-01')::text END
  ) STORED,
  CHECK ((kind = 'assigned' AND task_id IS NOT NULL) OR (kind = 'daily' AND digest_date IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS coach_task_notifications_dedupe
  ON public.coach_task_notifications(coach_id, kind, channel, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_coach_task_notifications_task ON public.coach_task_notifications(task_id);
CREATE INDEX IF NOT EXISTS idx_coach_task_notifications_coach_created ON public.coach_task_notifications(coach_id, created_at DESC);

ALTER TABLE public.coach_task_notifications ENABLE ROW LEVEL SECURITY;

-- Read: admin sees everything, a coach sees their own. Writes are service
-- role only (the edge function), so no INSERT/UPDATE/DELETE policies.
DROP POLICY IF EXISTS coach_task_notifications_select_admin ON public.coach_task_notifications;
CREATE POLICY coach_task_notifications_select_admin ON public.coach_task_notifications
  FOR SELECT TO authenticated
  USING (public.get_user_role() = 'admin');

DROP POLICY IF EXISTS coach_task_notifications_select_own ON public.coach_task_notifications;
CREATE POLICY coach_task_notifications_select_own ON public.coach_task_notifications
  FOR SELECT TO authenticated
  USING (coach_id = (SELECT auth.uid()));

GRANT SELECT ON public.coach_task_notifications TO authenticated;
GRANT ALL ON public.coach_task_notifications TO service_role;
-- The edge function reads tasks + assignee contact info as service_role.
GRANT SELECT ON public.coach_tasks TO service_role;
