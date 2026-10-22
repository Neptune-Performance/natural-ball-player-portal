-- #460: athletes log the weight they used for each movement in a workout.
--
-- One row per athlete per scheduled workout per exercise. exercise_key is the
-- training_exercises.id for program workouts, or "n-<index>" for template
-- workouts whose exercises live in schedule_events.notes. name_key is the
-- normalised exercise name (exerciseVideoMatch.normalizeExerciseName) so the
-- Lift Log can follow one movement across every program and template.
--
-- RLS: athletes manage their own rows; admin + coach read all and may log on
-- an athlete's behalf.

CREATE TABLE IF NOT EXISTS public.exercise_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  schedule_event_id uuid REFERENCES public.schedule_events(id) ON DELETE SET NULL,
  exercise_key text NOT NULL,
  exercise_name text NOT NULL,
  name_key text NOT NULL,
  event_date date NOT NULL,
  weight numeric NOT NULL CHECK (weight >= 0 AND weight < 2000),
  unit text NOT NULL DEFAULT 'lb' CHECK (unit IN ('lb', 'kg')),
  reps_done text,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (schedule_event_id, player_id, exercise_key)
);

CREATE INDEX IF NOT EXISTS exercise_logs_player_name_idx ON public.exercise_logs (player_id, name_key, event_date);

ALTER TABLE public.exercise_logs ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.exercise_logs TO authenticated;
GRANT ALL ON public.exercise_logs TO service_role;

DROP POLICY IF EXISTS exercise_logs_select ON public.exercise_logs;
CREATE POLICY exercise_logs_select ON public.exercise_logs
  FOR SELECT TO authenticated
  USING (player_id = auth.uid() OR public.get_user_role() IN ('admin', 'coach'));

DROP POLICY IF EXISTS exercise_logs_insert ON public.exercise_logs;
CREATE POLICY exercise_logs_insert ON public.exercise_logs
  FOR INSERT TO authenticated
  WITH CHECK (player_id = auth.uid() OR public.get_user_role() IN ('admin', 'coach'));

DROP POLICY IF EXISTS exercise_logs_update ON public.exercise_logs;
CREATE POLICY exercise_logs_update ON public.exercise_logs
  FOR UPDATE TO authenticated
  USING (player_id = auth.uid() OR public.get_user_role() IN ('admin', 'coach'))
  WITH CHECK (player_id = auth.uid() OR public.get_user_role() IN ('admin', 'coach'));

DROP POLICY IF EXISTS exercise_logs_delete ON public.exercise_logs;
CREATE POLICY exercise_logs_delete ON public.exercise_logs
  FOR DELETE TO authenticated
  USING (player_id = auth.uid() OR public.get_user_role() IN ('admin', 'coach'));
