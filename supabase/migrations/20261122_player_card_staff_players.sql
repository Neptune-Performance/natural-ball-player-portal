-- #495: Player Card for staff who are also players.
--
-- Cordell (admin, secondary_role = 'player') enters his own assessment numbers
-- and had no Player Card: the profile tab was limited to users.role = 'player'
-- (fixed in src/Profile.js). This is the grading half. player_rating_inputs()
-- built its age bands from role = 'player' only, so a staff member had no band
-- and fell through to the 'all' cohort, i.e. a 36-year-old ranked against
-- 10-year-olds. The subject of the card is now always given a band.
--
-- Otherwise identical to the definition in 20261114_base_running_ratings.sql.

CREATE OR REPLACE FUNCTION public.player_rating_inputs(p_player uuid)
RETURNS TABLE(metric_key text, value numeric, measured_on date, cohort text, cohort_n integer, percentile numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_sye integer;                       -- calendar year the current school year ends
  c_min_band constant integer := 15;   -- smallest age band we rank inside
  c_min_any  constant integer := 8;    -- below this, no percentile at all
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_player IS DISTINCT FROM auth.uid()
     AND coalesce(public.get_user_role(), '') NOT IN ('admin', 'coach') THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;

  v_sye := extract(year FROM current_date)::int
         + CASE WHEN extract(month FROM current_date) >= 8 THEN 1 ELSE 0 END;

  RETURN QUERY
  WITH
  ath AS (
    SELECT u.id,
           coalesce(pp.grad_year,
             CASE WHEN u.date_of_birth IS NOT NULL THEN
               extract(year FROM u.date_of_birth)::int
               + CASE WHEN extract(month FROM u.date_of_birth) >= 9 THEN 19 ELSE 18 END
             END) AS gy
      FROM users u
      LEFT JOIN LATERAL (
        SELECT p.grad_year FROM player_profiles p WHERE p.user_id = u.id
         ORDER BY p.grad_year IS NULL, p.created_at DESC LIMIT 1
      ) pp ON true
     -- #495: the person being graded always gets an age band, so staff who
     -- also train as players (users.secondary_role = 'player') are ranked by
     -- date of birth like any player without a grad year (adults -> college)
     -- rather than against every athlete. The pool everyone else is ranked
     -- in is still players only: this adds p_player to their OWN card only.
     WHERE u.role = 'player' OR u.id = p_player
  ),
  band AS (
    SELECT a.id,
           CASE WHEN a.gy IS NULL THEN NULL
                WHEN a.gy - v_sye >= 6 THEN '12u'
                WHEN a.gy - v_sye >= 4 THEN 'ms'
                WHEN a.gy - v_sye >= 2 THEN 'hs_under'
                WHEN a.gy - v_sye >= 0 THEN 'hs_upper'
                ELSE 'college' END AS b
      FROM ath a
  ),
  vals AS (
    SELECT r.player_id, r.metric_key AS mkey, r.value AS v, r.measured_on AS d
      FROM public.rating_metric_values() r
  ),
  lower_better(mkey) AS (VALUES ('hit_ttc'), ('run_sprint10'),
    ('run_home_1st'), ('run_home_2nd'), ('run_home_3rd'), ('run_home_home'), ('run_steal'),
    ('gp_whip'), ('gp_season_whip'), ('fld_pop_time')),
  -- players only: coaches who were assessed are not anyone's age group
  pool AS (
    SELECT v.player_id, v.mkey, v.v, v.d, b.b
      FROM vals v JOIN band b ON b.id = v.player_id
     WHERE v.v IS NOT NULL
  ),
  mine AS (
    SELECT v.mkey, v.v, v.d,
           (SELECT b.b FROM band b WHERE b.id = p_player) AS b
      FROM vals v
     WHERE v.player_id = p_player AND v.v IS NOT NULL
  ),
  sized AS (
    SELECT m.*,
           (SELECT count(*) FROM pool p WHERE p.mkey = m.mkey AND p.b = m.b) AS n_band,
           (SELECT count(*) FROM pool p WHERE p.mkey = m.mkey) AS n_all,
           EXISTS (SELECT 1 FROM lower_better l WHERE l.mkey = m.mkey) AS lb
      FROM mine m
  ),
  chosen AS (
    SELECT s.*,
           CASE WHEN s.b IS NOT NULL AND s.n_band >= c_min_band THEN s.b ELSE 'all' END AS cohort_key
      FROM sized s
  )
  SELECT c.mkey::text,
         -- 3 places (was 2) so a .842 OBP is not reported as .84
         round(c.v::numeric, 3),
         c.d::date,
         c.cohort_key::text,
         (CASE WHEN c.cohort_key = 'all' THEN c.n_all ELSE c.n_band END)::integer,
         CASE WHEN (CASE WHEN c.cohort_key = 'all' THEN c.n_all ELSE c.n_band END) < c_min_any THEN NULL
         ELSE (
           -- share of the OTHER athletes in the cohort this one beats; ties half
           SELECT round((count(*) FILTER (WHERE CASE WHEN c.lb THEN p.v > c.v ELSE p.v < c.v END)
                         + 0.5 * count(*) FILTER (WHERE p.v = c.v))
                        * 100.0 / greatest(count(*), 1), 1)
             FROM pool p
            WHERE p.mkey = c.mkey AND (c.cohort_key = 'all' OR p.b = c.cohort_key)
              AND p.player_id <> p_player
         ) END::numeric
    FROM chosen c;
END;
$$;

REVOKE ALL ON FUNCTION public.player_rating_inputs(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.player_rating_inputs(uuid) TO authenticated;
