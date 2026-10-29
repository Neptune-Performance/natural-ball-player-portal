-- #474: Player Card ratings (MLB The Show style, 0-99 per skill category).
--
-- Two pieces:
--
--   1. player_rating_overrides  — a coach's rating for a category (or the
--      overall Potential letter). Staff write; the athlete reads their own.
--
--   2. player_rating_inputs(uuid) — SECURITY DEFINER. Grading an athlete
--      "against their age group" needs every other athlete's numbers, which
--      the athlete cannot read under RLS. This function reads them on the
--      server and returns ONLY the requested athlete's own values, plus their
--      percentile inside the cohort and the cohort size. No other athlete's
--      value, id or name ever leaves the function.
--      Gate: an athlete may only ask about themself; admin/coach about anyone.
--
-- WHAT IS MEASURED lives here (the metric catalogue below: which assessment
-- question / Trackman column / WHOOP field feeds which metric_key, and how a
-- free-text answer is parsed). HOW IT IS GRADED (which metrics count toward
-- which category, weights, percentile -> 0-99 curve, absolute scales) lives in
-- ONE place on the client: src/playerRatings.js. Adding a new metric_key here
-- does nothing until it is listed there.
--
-- COHORT ("age group"). Every player gets an effective HS graduation year:
-- player_profiles.grad_year when set (578 players, 2026-10-29), else derived
-- from date_of_birth with the 1 September school cutoff (born Jan-Aug of Y ->
-- class of Y+18, Sep-Dec -> Y+19). Offset = grad year - the school year now
-- ending (rolls over 1 August, same rule as src/gradYear.js). Bands:
--     offset >= 6  '12u'       6th grade and younger
--     4..5         'ms'        7th-8th grade
--     2..3         'hs_under'  9th-10th grade
--     0..1         'hs_upper'  11th-12th grade
--     <= -1        'college'   college / pro
-- Two-year bands instead of single classes because single classes are too thin
-- (11-34 assessed athletes per class) to rank fairly. When the athlete's band
-- has fewer than 15 athletes with that metric, or the athlete has no grad year
-- and no DOB, the comparison widens to all players (cohort 'all'). Under 8
-- athletes with the metric at all -> no percentile (the client then shows the
-- metric as not graded unless it uses an absolute scale).

-- ---------------------------------------------------------------------------
-- 1. Overrides
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.player_rating_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- 'overall' carries the Potential letter and, optionally, an Overall override.
  category text NOT NULL CHECK (category IN (
    'hitting', 'fielding', 'throwing', 'pitching', 'base_running',
    'lifting', 'whoop', 'game_play', 'overall')),
  rating integer CHECK (rating IS NULL OR (rating BETWEEN 0 AND 99)),
  potential text CHECK (potential IS NULL OR potential IN ('A', 'B', 'C', 'D')),
  note text,
  set_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, category)
);

ALTER TABLE public.player_rating_overrides ENABLE ROW LEVEL SECURITY;

GRANT ALL ON public.player_rating_overrides TO authenticated;
GRANT ALL ON public.player_rating_overrides TO service_role;

DROP POLICY IF EXISTS player_rating_overrides_select ON public.player_rating_overrides;
CREATE POLICY player_rating_overrides_select ON public.player_rating_overrides
  FOR SELECT TO authenticated
  USING (player_id = auth.uid() OR public.get_user_role() IN ('admin', 'coach'));

DROP POLICY IF EXISTS player_rating_overrides_insert ON public.player_rating_overrides;
CREATE POLICY player_rating_overrides_insert ON public.player_rating_overrides
  FOR INSERT TO authenticated
  WITH CHECK (public.get_user_role() IN ('admin', 'coach'));

DROP POLICY IF EXISTS player_rating_overrides_update ON public.player_rating_overrides;
CREATE POLICY player_rating_overrides_update ON public.player_rating_overrides
  FOR UPDATE TO authenticated
  USING (public.get_user_role() IN ('admin', 'coach'))
  WITH CHECK (public.get_user_role() IN ('admin', 'coach'));

DROP POLICY IF EXISTS player_rating_overrides_delete ON public.player_rating_overrides;
CREATE POLICY player_rating_overrides_delete ON public.player_rating_overrides
  FOR DELETE TO authenticated
  USING (public.get_user_role() IN ('admin', 'coach'));

-- ---------------------------------------------------------------------------
-- 2. Free-text number parser — a port of parseMetricValue() in
--    src/assessmentMetrics.js (BEST-TRIAL policy, #351). Keep them in step.
--    Coaches type several trials / an R-L pair into one box ("82, 84",
--    "R-35.2, L-38.4", "(12/2/2025): 58.2 / 57.7mph", "6'8 / 6'7"):
--      * an explicit calendar date (19xx/20xx year) is removed first;
--      * a number followed by '%' is commentary and dropped;
--      * tokens outside [lo, hi] are dropped (garbage filter, e.g. a spin axis
--        "12:30" or "1145" in a velocity box);
--      * best trial = max, or min when lower_better;
--      * feet_inches: "6'8" / "5ft" read as inches (broad jump).
--    Nothing plausible -> NULL (not measured), never a guess.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rating_best_number(
  raw text, lo numeric, hi numeric, lower_better boolean DEFAULT false, feet_inches boolean DEFAULT false)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO 'public'
AS $$
DECLARE
  s text := raw;
  vals numeric[];
BEGIN
  IF s IS NULL OR s !~ '\d' THEN RETURN NULL; END IF;

  IF feet_inches AND s ~* '\d\s*([''’′]|f(ee)?t)' THEN
    SELECT array_agg(m[1]::numeric * 12 + coalesce(nullif(m[2], '')::numeric, 0))
      INTO vals
      FROM regexp_matches(s, '(\d{1,2})\s*(?:[''’′]|f(?:ee)?t)\s*(\d{1,2}(?:\.\d+)?)?', 'gi') AS m;
  ELSE
    s := regexp_replace(s,
      '\d{1,2}\s*[/.-]\s*\d{1,2}\s*[/.-]\s*(?:19|20)\d{2}|(?:19|20)\d{2}\s*-\s*\d{1,2}\s*-\s*\d{1,2}',
      ' ', 'g');
    SELECT array_agg(m[1]::numeric)
      INTO vals
      FROM regexp_matches(s, '(\d+(?:\.\d+)?|\.\d+)(\s*%)?', 'g') AS m
     WHERE m[2] IS NULL;
  END IF;

  IF vals IS NULL THEN RETURN NULL; END IF;
  IF lower_better THEN
    RETURN (SELECT min(v) FROM unnest(vals) v WHERE v BETWEEN lo AND hi);
  END IF;
  RETURN (SELECT max(v) FROM unnest(vals) v WHERE v BETWEEN lo AND hi);
END;
$$;

REVOKE ALL ON FUNCTION public.rating_best_number(text, numeric, numeric, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rating_best_number(text, numeric, numeric, boolean, boolean) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. player_rating_inputs
--
-- Returns one row per metric the athlete HAS a value for:
--   metric_key   stable id, graded by src/playerRatings.js
--   value        the athlete's own number (units in playerRatings.js)
--   measured_on  newest date behind the value
--   cohort       '12u' | 'ms' | 'hs_under' | 'hs_upper' | 'college' | 'all'
--   cohort_n     athletes in that cohort with this metric (incl. this one)
--   percentile   0-100, share of the cohort this athlete is BETTER than
--                (ties count half), already flipped for lower-is-better
--                metrics. NULL when fewer than 8 athletes have the metric.
-- ---------------------------------------------------------------------------
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
  c_assess_days constant integer := 548; -- assessments older than ~18 months are ignored
  c_trackman_days constant integer := 365;
  c_whoop_days constant integer := 30;
  c_game_days constant integer := 365;
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
     WHERE u.role = 'player'
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

  -- ---- Metric catalogue: assessment questions ------------------------------
  -- label_like / label_not_like match the lower-cased template element label.
  -- lo/hi = plausible range (garbage filter, NOT a benchmark).
  spec(mkey, label_like, label_not_like, lo, hi, lower_better, feet_inches) AS (
    VALUES
      -- Hitting assessment
      ('hit_ev_tee',     'exit velo tee middle%', NULL,            10::numeric, 130::numeric, false, false),
      ('hit_ev_ft',      'front toss ev%',        NULL,            10, 130, false, false),
      ('hit_batspeed',   'bat speed%',            NULL,            15, 120, false, false),
      ('hit_ttc',        'time to contact%',      NULL,            0.08, 0.5, true, false),
      -- Pitching / Throwing assessment
      ('thr_pulldown',   'pulldown velo%',        NULL,            15, 108, false, false),
      ('thr_shuffle',    'shuffle fire velo%',    NULL,            15, 108, false, false),
      ('pit_fb_assess',  '4 seam fb%',            NULL,            15, 108, false, false),
      -- Strength & Conditioning assessment
      ('lift_vert',      'vertical jump%',        NULL,            1, 60, false, false),
      ('lift_approach',  'approach vertical jump%', NULL,          1, 70, false, false),
      ('lift_broad',     'broad jump%',           NULL,            12, 200, false, true),
      ('lift_grip',      'grip strength%',        NULL,            3, 300, false, false),
      ('lift_pushups',   'pushups to failure%',   NULL,            0, 150, false, false),
      ('run_sprint10',   '10 yard sprint%',       NULL,            1, 4, true, false)
  ),
  el AS (
    SELECT t.id AS tid, e->>'id' AS eid, lower(trim(e->>'label')) AS lbl
      FROM assessment_templates t
     CROSS JOIN LATERAL jsonb_array_elements(
       CASE WHEN jsonb_typeof(t.schema) = 'array' THEN t.schema ELSE '[]'::jsonb END) e
  ),
  amatch AS (
    SELECT s.*, el.tid, el.eid
      FROM spec s
      JOIN el ON el.lbl LIKE s.label_like
             AND (s.label_not_like IS NULL OR el.lbl NOT LIKE s.label_not_like)
  ),
  aparsed AS (
    SELECT sub.player_id, m.mkey,
           public.rating_best_number(sub.responses->>m.eid, m.lo, m.hi, m.lower_better, m.feet_inches) AS v,
           coalesce(sub.assessment_date, sub.created_at::date) AS d,
           sub.created_at
      FROM assessment_submissions sub
      JOIN amatch m ON m.tid = sub.template_id
     WHERE coalesce(sub.assessment_date, sub.created_at::date) >= current_date - c_assess_days
       AND jsonb_typeof(sub.responses) = 'object'
  ),
  aval AS (   -- newest submission that actually measured it
    SELECT DISTINCT ON (player_id, mkey) player_id, mkey, v, d
      FROM aparsed WHERE v IS NOT NULL
     ORDER BY player_id, mkey, d DESC, created_at DESC
  ),

  -- ---- Trackman (pitcher side; batted-ball columns are empty today) --------
  tm AS (
    SELECT tp.pitcher_user_id AS player_id,
           max(tp.rel_speed) FILTER (WHERE tp.tagged_pitch_type IN ('Fastball','FB','FourSeamFastBall','Four-Seam','Sinker','SI','TwoSeamFastBall')
                                       AND tp.rel_speed BETWEEN 30 AND 108) AS fb_max,
           avg(tp.spin_rate) FILTER (WHERE tp.tagged_pitch_type IN ('Fastball','FB','FourSeamFastBall','Four-Seam')
                                       AND tp.spin_rate BETWEEN 500 AND 3600) AS fb_spin,
           count(*) FILTER (WHERE tp.tagged_pitch_type IN ('Fastball','FB','FourSeamFastBall','Four-Seam')
                              AND tp.spin_rate BETWEEN 500 AND 3600) AS n_spin,
           avg(CASE WHEN abs(tp.plate_loc_side) <= 0.83 AND tp.plate_loc_height BETWEEN 1.5 AND 3.5
                    THEN 100.0 ELSE 0.0 END) FILTER (WHERE tp.plate_loc_side IS NOT NULL AND tp.plate_loc_height IS NOT NULL) AS zone_pct,
           count(*) FILTER (WHERE tp.plate_loc_side IS NOT NULL AND tp.plate_loc_height IS NOT NULL) AS n_loc,
           max(tp.thrown_date) AS d
      FROM trackman_pitches tp
     WHERE tp.pitcher_user_id IS NOT NULL
       AND tp.thrown_date >= current_date - c_trackman_days
     GROUP BY tp.pitcher_user_id
  ),

  -- ---- WHOOP, last 30 days -------------------------------------------------
  wc AS (
    SELECT c.athlete_id AS player_id,
           avg(c.recovery_score) AS recovery,
           count(c.recovery_score) AS n_rec,
           count(DISTINCT c.cycle_date) AS days,
           max(c.cycle_date) AS d
      FROM whoop_cycles c
     WHERE c.cycle_date > current_date - c_whoop_days
     GROUP BY c.athlete_id
  ),
  ws AS (     -- one figure per night: the longest sleep (naps are separate rows)
    SELECT player_id, avg(hrs) AS sleep_hrs, count(*) AS nights, max(sleep_date) AS d
      FROM (
        SELECT s.athlete_id AS player_id, s.sleep_date,
               max((coalesce(s.total_duration_ms, 0) - coalesce(s.awake_duration_ms, 0)) / 3600000.0) AS hrs
          FROM whoop_sleep s
         WHERE s.sleep_date > current_date - c_whoop_days AND s.total_duration_ms > 0
         GROUP BY s.athlete_id, s.sleep_date
      ) n
     GROUP BY player_id
  ),

  -- ---- Game play: practice / scrimmage / lives logs ------------------------
  po AS (
    SELECT o.player_id,
           sum(o.strikes)::numeric AS strikes,
           sum(o.pitches)::numeric AS pitches,
           sum(coalesce(o.walks, 0) + coalesce(o.hits, 0))::numeric AS wh,
           -- innings in baseball notation: 4.2 = 4 innings + 2 outs
           sum(floor(coalesce(o.innings_pitched, 0)) * 3
               + round((coalesce(o.innings_pitched, 0) - floor(coalesce(o.innings_pitched, 0))) * 10)) AS outs,
           max(o.log_date) AS d
      FROM practice_pitching_outings o
     WHERE o.log_date >= current_date - c_game_days
     GROUP BY o.player_id
  ),
  pab AS (
    SELECT b.player_id,
           count(*) FILTER (WHERE upper(trim(b.result)) IN ('1B','2B','3B','HR','BB','HBP','SINGLE','DOUBLE','TRIPLE','WALK')) AS on_base,
           count(*) FILTER (WHERE b.result IS NOT NULL AND trim(b.result) <> '') AS pa,
           max(b.ab_date) AS d
      FROM practice_at_bats b
     WHERE b.ab_date >= current_date - c_game_days
     GROUP BY b.player_id
  ),
  pc AS (     -- catchers: best pop time
    SELECT c.player_id, min(c.pop_time_sec) AS pop, max(c.log_date) AS d
      FROM practice_catching c
     WHERE c.log_date >= current_date - c_game_days AND c.pop_time_sec BETWEEN 1.4 AND 3.5
     GROUP BY c.player_id
  ),

  -- ---- Every athlete's value per metric -----------------------------------
  allv AS (
    SELECT player_id, mkey, v, d FROM aval WHERE mkey <> 'pit_fb_assess'
    UNION ALL
    -- Fastball velo: the better of the assessment reading and Trackman.
    SELECT coalesce(a.player_id, t.player_id), 'pit_fb_velo',
           greatest(a.v, t.fb_max), greatest(a.d, t.d)
      FROM (SELECT * FROM aval WHERE mkey = 'pit_fb_assess') a
      FULL JOIN (SELECT * FROM tm WHERE fb_max IS NOT NULL) t ON t.player_id = a.player_id
    UNION ALL
    SELECT player_id, 'pit_fb_spin', round(fb_spin), d FROM tm WHERE n_spin >= 5
    UNION ALL
    SELECT player_id, 'pit_zone_pct', round(zone_pct, 1), d FROM tm WHERE n_loc >= 30
    UNION ALL
    SELECT player_id, 'whoop_recovery', round(recovery, 1), d FROM wc WHERE n_rec >= 7
    UNION ALL
    SELECT player_id, 'whoop_wear_pct', round(least(days, c_whoop_days) * 100.0 / c_whoop_days, 1), d FROM wc
    UNION ALL
    SELECT player_id, 'whoop_sleep_hrs', round(sleep_hrs, 2), d FROM ws WHERE nights >= 7
    UNION ALL
    SELECT player_id, 'gp_strike_pct', round(strikes * 100 / pitches, 1), d FROM po WHERE pitches >= 50 AND strikes IS NOT NULL
    UNION ALL
    SELECT player_id, 'gp_whip', round(wh * 3 / outs, 2), d FROM po WHERE outs >= 9
    UNION ALL
    SELECT player_id, 'gp_on_base_pct', round(on_base * 100.0 / pa, 1), d FROM pab WHERE pa >= 10
    UNION ALL
    SELECT player_id, 'fld_pop_time', pop, d FROM pc
  ),
  lower_better(mkey) AS (VALUES ('hit_ttc'), ('run_sprint10'), ('gp_whip'), ('fld_pop_time')),
  -- players only: coaches who were assessed are not anyone's age group
  pool AS (
    SELECT v.player_id, v.mkey, v.v, v.d, b.b
      FROM allv v JOIN band b ON b.id = v.player_id
     WHERE v.v IS NOT NULL
  ),
  mine AS (
    SELECT v.mkey, v.v, v.d,
           (SELECT b.b FROM band b WHERE b.id = p_player) AS b
      FROM allv v
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
         round(c.v::numeric, 2),
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
