-- #454: PT Recovery Engine progress checks, stored per athlete.
--
-- One row per check a clinician logs (pain, ROM, strength/hop/heel-raise
-- symmetry, grip, chair stands, gait speed, self-reported function). The
-- grading context (region / nature / age band / sex) is stored on the row
-- because the engine grades against it and it can change between plans.
-- Any metric may be null = not measured that day.
--
-- RLS mirrors pt_visits: staff write, the athlete reads their own.

CREATE TABLE IF NOT EXISTS public.pt_progress_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  program_id uuid REFERENCES public.training_programs(id) ON DELETE SET NULL,
  check_date date NOT NULL DEFAULT CURRENT_DATE,
  region text NOT NULL,
  nature text NOT NULL,
  age_band text,
  sex text,
  week numeric,
  pain numeric CHECK (pain IS NULL OR (pain >= 0 AND pain <= 10)),
  rom numeric,
  lsi numeric,
  hop numeric,
  heel numeric,
  grip numeric,
  chair numeric,
  gait numeric,
  pro numeric,
  notes text,
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pt_progress_checks_player_idx ON public.pt_progress_checks (player_id, check_date);

ALTER TABLE public.pt_progress_checks ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.pt_progress_checks TO authenticated;
GRANT ALL ON public.pt_progress_checks TO service_role;

DROP POLICY IF EXISTS pt_progress_checks_select ON public.pt_progress_checks;
CREATE POLICY pt_progress_checks_select ON public.pt_progress_checks
  FOR SELECT TO authenticated
  USING (player_id = auth.uid() OR public.get_user_role() IN ('admin', 'coach'));

DROP POLICY IF EXISTS pt_progress_checks_insert ON public.pt_progress_checks;
CREATE POLICY pt_progress_checks_insert ON public.pt_progress_checks
  FOR INSERT TO authenticated
  WITH CHECK (public.get_user_role() IN ('admin', 'coach'));

DROP POLICY IF EXISTS pt_progress_checks_update ON public.pt_progress_checks;
CREATE POLICY pt_progress_checks_update ON public.pt_progress_checks
  FOR UPDATE TO authenticated
  USING (public.get_user_role() IN ('admin', 'coach'))
  WITH CHECK (public.get_user_role() IN ('admin', 'coach'));

DROP POLICY IF EXISTS pt_progress_checks_delete ON public.pt_progress_checks;
CREATE POLICY pt_progress_checks_delete ON public.pt_progress_checks
  FOR DELETE TO authenticated
  USING (public.get_user_role() IN ('admin', 'coach'));
