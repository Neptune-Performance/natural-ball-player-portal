-- #486: athletes log their own PT notes on their own profile.
-- They can insert rows for themselves and edit/delete only the rows they
-- authored; staff-authored visits stay read-only to them. Staff policies are
-- unchanged.

CREATE POLICY "athlete insert own pt visits" ON public.pt_visits
  FOR INSERT TO authenticated
  WITH CHECK (player_id = auth.uid() AND created_by = auth.uid());

CREATE POLICY "athlete update own pt visits" ON public.pt_visits
  FOR UPDATE TO authenticated
  USING (player_id = auth.uid() AND created_by = auth.uid())
  WITH CHECK (player_id = auth.uid() AND created_by = auth.uid());

CREATE POLICY "athlete delete own pt visits" ON public.pt_visits
  FOR DELETE TO authenticated
  USING (player_id = auth.uid() AND created_by = auth.uid());

GRANT ALL ON public.pt_visits TO authenticated;
