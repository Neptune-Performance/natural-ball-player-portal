-- #488: the Base Running Assessment grades the Player Card.
--
-- Base Running read only the S&C template's "10 Yard Sprint" box, which
-- nobody fills in, so 50 base running assessments (as of 2026-11-14) showed
-- nothing. rating_metric_values() now also reads the Base Running Assessment:
--   run_home_1st / run_home_2nd / run_home_3rd / run_home_home / run_steal
--     best time in each box, lower is better, age-group percentile
--   run_route_grade
--     mean of the Poor / Avg / Good boxes (0 / 50 / 100), absolute scale
-- Everything else in both functions is unchanged from 20261107 / 20261103.

CREATE OR REPLACE FUNCTION public.rating_metric_values()
RETURNS TABLE(player_id uuid, metric_key text, value numeric, measured_on date)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
#variable_conflict use_column
DECLARE
  c_assess_days constant integer := 548; -- assessments older than ~18 months are ignored
  c_trackman_days constant integer := 365;
  c_whoop_days constant integer := 30;
  c_game_days constant integer := 365;
  c_season_days constant integer := 548; -- #476 uploaded season stats
  c_season_years constant integer := 3;  -- #487 seasons older than this many years are ignored
  v_year integer := extract(year FROM current_date)::int;
BEGIN
  RETURN QUERY
  WITH
  spec(mkey, label_like, label_not_like, lo, hi, lower_better, feet_inches) AS (
    VALUES
      ('hit_ev_tee',     'exit velo tee middle%', NULL,            10::numeric, 130::numeric, false, false),
      ('hit_ev_ft',      'front toss ev%',        NULL,            10, 130, false, false),
      ('hit_batspeed',   'bat speed%',            NULL,            15, 120, false, false),
      ('hit_ttc',        'time to contact%',      NULL,            0.08, 0.5, true, false),
      ('thr_pulldown',   'pulldown velo%',        NULL,            15, 108, false, false),
      ('thr_shuffle',    'shuffle fire velo%',    NULL,            15, 108, false, false),
      ('pit_fb_assess',  '4 seam fb%',            NULL,            15, 108, false, false),
      ('lift_vert',      'vertical jump%',        NULL,            1, 60, false, false),
      ('lift_approach',  'approach vertical jump%', NULL,          1, 70, false, false),
      ('lift_broad',     'broad jump%',           NULL,            12, 200, false, true),
      ('lift_grip',      'grip strength%',        NULL,            3, 300, false, false),
      ('lift_pushups',   'pushups to failure%',   NULL,            0, 150, false, false),
      ('run_sprint10',   '10 yard sprint%',       NULL,            1, 4, true, false),
      -- #488 Base Running Assessment: best (lowest) time typed in each box
      ('run_home_1st',   'home to 1st base time%', NULL,           2.5, 8, true, false),
      ('run_home_2nd',   'home to 2nd base time%', NULL,           5, 15, true, false),
      ('run_home_3rd',   'home to 3rd base time%', NULL,           8, 22, true, false),
      ('run_home_home',  'home to home%',         NULL,            11, 30, true, false),
      ('run_steal',      'straight steal time%',  NULL,            2, 7, true, false)
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
  aval AS (
    SELECT DISTINCT ON (player_id, mkey) player_id, mkey, v, d
      FROM aparsed WHERE v IS NOT NULL
     ORDER BY player_id, mkey, d DESC, created_at DESC
  ),

  -- ---- Trackman (pitcher side). #483: a screenshot summary row stands for
  -- summary_count pitches; max_speed is that line's top velo. -------------
  tmr AS (
    SELECT tp.*,
           coalesce(tp.summary_count, 1)::numeric AS w,
           tp.tagged_pitch_type IN ('Fastball','FB','FourSeamFastBall','Four-Seam','Sinker','SI','TwoSeamFastBall') AS is_fb_any,
           tp.tagged_pitch_type IN ('Fastball','FB','FourSeamFastBall','Four-Seam') AS is_fb4
      FROM trackman_pitches tp
     WHERE tp.pitcher_user_id IS NOT NULL
       AND tp.thrown_date >= current_date - c_trackman_days
  ),
  tm AS (
    SELECT tp.pitcher_user_id AS player_id,
           max(greatest(tp.rel_speed, tp.max_speed)) FILTER (WHERE tp.is_fb_any
                                       AND greatest(tp.rel_speed, tp.max_speed) BETWEEN 30 AND 108) AS fb_max,
           sum(tp.spin_rate * tp.w) FILTER (WHERE tp.is_fb4 AND tp.spin_rate BETWEEN 500 AND 3600)
             / nullif(sum(tp.w) FILTER (WHERE tp.is_fb4 AND tp.spin_rate BETWEEN 500 AND 3600), 0) AS fb_spin,
           coalesce(sum(tp.w) FILTER (WHERE tp.is_fb4 AND tp.spin_rate BETWEEN 500 AND 3600), 0) AS n_spin,
           avg(CASE WHEN abs(tp.plate_loc_side) <= 0.83 AND tp.plate_loc_height BETWEEN 1.5 AND 3.5
                    THEN 100.0 ELSE 0.0 END) FILTER (WHERE tp.plate_loc_side IS NOT NULL AND tp.plate_loc_height IS NOT NULL) AS zone_pct,
           count(*) FILTER (WHERE tp.plate_loc_side IS NOT NULL AND tp.plate_loc_height IS NOT NULL) AS n_loc,
           max(tp.thrown_date) AS d
      FROM tmr tp
     GROUP BY tp.pitcher_user_id
  ),

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
  ws AS (
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

  po AS (
    SELECT o.player_id,
           sum(o.strikes)::numeric AS strikes,
           sum(o.pitches)::numeric AS pitches,
           sum(coalesce(o.walks, 0) + coalesce(o.hits, 0))::numeric AS wh,
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
  pc AS (
    SELECT c.player_id, min(c.pop_time_sec) AS pop, max(c.log_date) AS d
      FROM practice_catching c
     WHERE c.log_date >= current_date - c_game_days AND c.pop_time_sec BETWEEN 1.4 AND 3.5
     GROUP BY c.player_id
  ),

  -- ---- Season stat lines ------------------------------------------------
  -- #476 external_stats.stat_line (weight 1) + #487 external_season_stats
  -- (weight by season age: this year 1, last year 0.7, 2 years 0.45,
  -- 3 years 0.25, older ignored). Rates are combined weighted by
  -- PA / outs / batters faced x recency; the minimum-sample gates use the
  -- raw (unweighted) totals.
  xs AS (
    SELECT e.player_id,
           e.created_at::date AS d,
           1.0::numeric AS w,
           public.rating_num(e.stat_line #>> '{batting,pa}') AS pa,
           public.rating_num(e.stat_line #>> '{batting,obp}') AS obp,
           public.rating_num(e.stat_line #>> '{batting,ops}') AS ops,
           public.rating_num(e.stat_line #>> '{pitching,ip}') AS ip,
           public.rating_num(e.stat_line #>> '{pitching,whip}') AS whip,
           public.rating_num(e.stat_line #>> '{pitching,bf}') AS bf,
           public.rating_num(e.stat_line #>> '{pitching,so}') AS so,
           public.rating_num(e.stat_line #>> '{pitching,era}') AS era
      FROM external_stats e
     WHERE jsonb_typeof(e.stat_line) = 'object'
       AND e.created_at >= current_date - c_season_days
    UNION ALL
    SELECT s.player_id,
           s.created_at::date,
           (CASE v_year - coalesce(s.season_year, extract(year FROM s.created_at)::int)
              WHEN 0 THEN 1.0 WHEN 1 THEN 0.7 WHEN 2 THEN 0.45 WHEN 3 THEN 0.25 ELSE 1.0 END)::numeric,
           CASE WHEN s.category = 'hitting' THEN s.pa END,
           CASE WHEN s.category = 'hitting' THEN s.obp END,
           CASE WHEN s.category = 'hitting' THEN s.ops END,
           CASE WHEN s.category = 'pitching' THEN s.ip END,
           CASE WHEN s.category = 'pitching' THEN s.whip END,
           CASE WHEN s.category = 'pitching' THEN s.bf END,
           CASE WHEN s.category = 'pitching' THEN s.so END,
           CASE WHEN s.category = 'pitching' THEN s.era END
      FROM external_season_stats s
     WHERE s.category IN ('hitting', 'pitching')
       AND coalesce(s.season_year, extract(year FROM s.created_at)::int) BETWEEN v_year - c_season_years AND v_year + 1
  ),
  xso AS (
    SELECT x.*,
           CASE WHEN x.ip IS NOT NULL AND x.ip >= 0
                THEN floor(x.ip) * 3 + round((x.ip - floor(x.ip)) * 10) END AS outs
      FROM xs x
  ),
  xagg AS (
    SELECT player_id,
           sum(pa) FILTER (WHERE obp BETWEEN 0 AND 1) AS pa_obp,
           sum(obp * pa * w) FILTER (WHERE obp BETWEEN 0 AND 1) / nullif(sum(pa * w) FILTER (WHERE obp BETWEEN 0 AND 1), 0) AS obp_v,
           sum(pa) FILTER (WHERE ops BETWEEN 0 AND 5) AS pa_ops,
           sum(ops * pa * w) FILTER (WHERE ops BETWEEN 0 AND 5) / nullif(sum(pa * w) FILTER (WHERE ops BETWEEN 0 AND 5), 0) AS ops_v,
           sum(outs) FILTER (WHERE whip BETWEEN 0 AND 20) AS outs_whip,
           sum(whip * outs * w) FILTER (WHERE whip BETWEEN 0 AND 20) / nullif(sum(outs * w) FILTER (WHERE whip BETWEEN 0 AND 20), 0) AS whip_v,
           sum(outs) FILTER (WHERE era BETWEEN 0 AND 50) AS outs_era,
           sum(era * outs * w) FILTER (WHERE era BETWEEN 0 AND 50) / nullif(sum(outs * w) FILTER (WHERE era BETWEEN 0 AND 50), 0) AS era_v,
           sum(bf) FILTER (WHERE so IS NOT NULL AND so <= bf) AS bf_k,
           sum(so * w) FILTER (WHERE so IS NOT NULL AND so <= bf) / nullif(sum(bf * w) FILTER (WHERE so IS NOT NULL AND so <= bf), 0) AS k_v,
           max(d) AS d
      FROM xso
     WHERE pa > 0 OR outs > 0 OR bf > 0
     GROUP BY player_id
  ),
  -- #487 Fielding %: (PO + A) / (PO + A + E), else FPCT x TC.
  xf AS (
    SELECT s.player_id,
           (CASE v_year - coalesce(s.season_year, extract(year FROM s.created_at)::int)
              WHEN 0 THEN 1.0 WHEN 1 THEN 0.7 WHEN 2 THEN 0.45 WHEN 3 THEN 0.25 ELSE 1.0 END)::numeric AS w,
           CASE WHEN s.po IS NOT NULL AND s.a IS NOT NULL AND s.e IS NOT NULL THEN (s.po + s.a + s.e)
                WHEN s.tc IS NOT NULL AND s.fpct BETWEEN 0 AND 1 THEN s.tc END::numeric AS ch,
           CASE WHEN s.po IS NOT NULL AND s.a IS NOT NULL AND s.e IS NOT NULL THEN (s.po + s.a)
                WHEN s.tc IS NOT NULL AND s.fpct BETWEEN 0 AND 1 THEN s.tc * s.fpct END::numeric AS good,
           s.created_at::date AS d
      FROM external_season_stats s
     WHERE s.category = 'fielding'
       AND coalesce(s.season_year, extract(year FROM s.created_at)::int) BETWEEN v_year - c_season_years AND v_year + 1
  ),
  xfagg AS (
    SELECT player_id, sum(ch) AS ch, sum(good * w) / nullif(sum(ch * w), 0) AS fpct, max(d) AS d
      FROM xf WHERE ch > 0 AND good <= ch
     GROUP BY player_id
  ),
  -- #488 Base Running Assessment "Route / Tracking Efficiency" boxes: the
  -- coach types Poor / Avg / Good (often followed by a comment). First grade
  -- word found counts: poor 0, avg 50, good 100; the metric is the mean of the
  -- graded boxes on the athlete's latest submission (3+ boxes graded).
  gel AS (
    SELECT el.tid, el.eid FROM el
     WHERE el.lbl LIKE 'route efficiency%' OR el.lbl LIKE 'tracking efficiency%'
  ),
  gparsed AS (
    SELECT sub.id, sub.player_id,
           coalesce(sub.assessment_date, sub.created_at::date) AS d,
           sub.created_at,
           avg(CASE substring(lower(sub.responses->>gel.eid) FROM '(poor|avg|average|good)')
                 WHEN 'poor' THEN 0 WHEN 'avg' THEN 50 WHEN 'average' THEN 50 WHEN 'good' THEN 100 END) AS v,
           count(substring(lower(sub.responses->>gel.eid) FROM '(poor|avg|average|good)')) AS n
      FROM assessment_submissions sub
      JOIN gel ON gel.tid = sub.template_id
     WHERE coalesce(sub.assessment_date, sub.created_at::date) >= current_date - c_assess_days
       AND jsonb_typeof(sub.responses) = 'object'
     GROUP BY sub.id, sub.player_id, sub.assessment_date, sub.created_at
  ),
  gval AS (
    SELECT DISTINCT ON (player_id) player_id, v, d
      FROM gparsed WHERE n >= 3
     ORDER BY player_id, d DESC, created_at DESC
  ),
  allv AS (
    SELECT player_id, mkey, v, d FROM aval WHERE mkey <> 'pit_fb_assess'
    UNION ALL
    SELECT player_id, 'run_route_grade', round(v, 1), d FROM gval
    UNION ALL
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
    UNION ALL
    SELECT player_id, 'gp_season_obp', round(obp_v, 3), d FROM xagg WHERE pa_obp >= 15
    UNION ALL
    SELECT player_id, 'gp_season_ops', round(ops_v, 3), d FROM xagg WHERE pa_ops >= 15
    UNION ALL
    SELECT player_id, 'gp_season_whip', round(whip_v, 2), d FROM xagg WHERE outs_whip >= 15
    UNION ALL
    SELECT player_id, 'gp_season_era', round(era_v, 2), d FROM xagg WHERE outs_era >= 15
    UNION ALL
    SELECT player_id, 'gp_season_k_pct', round(k_v * 100.0, 1), d FROM xagg WHERE bf_k >= 20
    UNION ALL
    SELECT player_id, 'fld_season_fpct', round(fpct, 3), d FROM xfagg WHERE ch >= 20
  )
  SELECT a.player_id, a.mkey::text, a.v::numeric, a.d::date FROM allv a WHERE a.v IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.rating_metric_values() FROM PUBLIC, anon, authenticated;

-- lower-is-better list gains the five base running times
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
