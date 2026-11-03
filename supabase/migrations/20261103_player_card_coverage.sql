-- #476 / #478: Player Card follow-ups.
--
-- #476  Uploaded external (season) stats now count toward Game Play. The
--       upload form reads the numbers out of a CSV / XLSX (or the uploader
--       types them for a screenshot / link) and saves them, confirmed, as
--       external_stats.stat_line. Four new metrics: gp_season_obp,
--       gp_season_ops, gp_season_whip, gp_season_k_pct (graded on absolute
--       scales in src/playerRatings.js).
-- #478  Staff need to see, for EVERY athlete, which card categories have data
--       and when it was last measured. That needs every athlete's metric list
--       at once, so the per-metric value logic moves out of
--       player_rating_inputs into one internal function both read:
--         rating_metric_values()    internal, NOT callable by any client role
--         player_rating_inputs(uuid) unchanged contract (self or staff)
--         player_rating_coverage()  staff only; metric keys + dates, no values
--
-- Applied with execute_sql (apply_migration is unreliable on this project).

-- ---------------------------------------------------------------------------
-- 1. external_stats.stat_line
--    { "batting":  { pa, ab, h, bb, hbp, sf, so, avg, obp, slg, ops },
--      "pitching": { ip, bf, pitches, h, bb, so, er, era, whip },
--      "origin": "file" | "manual", "file_name", "matched_name" }
--    Every field optional. Athlete writes their own row (existing RLS).
-- ---------------------------------------------------------------------------
ALTER TABLE public.external_stats ADD COLUMN IF NOT EXISTS stat_line jsonb;
ALTER TABLE public.external_stats DROP CONSTRAINT IF EXISTS external_stats_stat_line_object;
ALTER TABLE public.external_stats ADD CONSTRAINT external_stats_stat_line_object
  CHECK (stat_line IS NULL OR jsonb_typeof(stat_line) = 'object');

-- Lenient numeric cast for jsonb text: '' / '-' / garbage -> NULL.
CREATE OR REPLACE FUNCTION public.rating_num(t text)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN t ~ '^\s*-?(\d+\.?\d*|\.\d+)\s*$' THEN trim(t)::numeric END
$$;

-- ---------------------------------------------------------------------------
-- 2. rating_metric_values(): every athlete's value per metric. Moved verbatim
--    from 20261029_player_ratings.sql (plus the #476 season metrics). Returns
--    OTHER athletes' numbers, so no client role may call it.
-- ---------------------------------------------------------------------------
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
BEGIN
  RETURN QUERY
  WITH
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

  -- ---- #476 Game play: season stat lines from uploaded external stats ----
  -- external_stats.stat_line is filled by the upload form (read from the
  -- CSV/XLSX, checked by the uploader, or typed in for a screenshot / link).
  -- Rates are combined across uploads weighted by PA / outs / batters faced.
  xs AS (
    SELECT e.player_id,
           e.created_at::date AS d,
           public.rating_num(e.stat_line #>> '{batting,pa}') AS pa,
           public.rating_num(e.stat_line #>> '{batting,obp}') AS obp,
           public.rating_num(e.stat_line #>> '{batting,ops}') AS ops,
           public.rating_num(e.stat_line #>> '{pitching,ip}') AS ip,
           public.rating_num(e.stat_line #>> '{pitching,whip}') AS whip,
           public.rating_num(e.stat_line #>> '{pitching,bf}') AS bf,
           public.rating_num(e.stat_line #>> '{pitching,so}') AS so
      FROM external_stats e
     WHERE jsonb_typeof(e.stat_line) = 'object'
       AND e.created_at >= current_date - c_season_days
  ),
  xso AS (
    SELECT x.*,
           -- innings in baseball notation: 4.2 = 4 innings + 2 outs
           CASE WHEN x.ip IS NOT NULL AND x.ip >= 0
                THEN floor(x.ip) * 3 + round((x.ip - floor(x.ip)) * 10) END AS outs
      FROM xs x
  ),
  xagg AS (
    SELECT player_id,
           sum(pa) FILTER (WHERE obp BETWEEN 0 AND 1) AS pa_obp,
           sum(obp * pa) FILTER (WHERE obp BETWEEN 0 AND 1) AS obp_w,
           sum(pa) FILTER (WHERE ops BETWEEN 0 AND 5) AS pa_ops,
           sum(ops * pa) FILTER (WHERE ops BETWEEN 0 AND 5) AS ops_w,
           sum(outs) FILTER (WHERE whip BETWEEN 0 AND 20) AS outs_whip,
           sum(whip * outs) FILTER (WHERE whip BETWEEN 0 AND 20) AS whip_w,
           sum(bf) FILTER (WHERE so IS NOT NULL AND so <= bf) AS bf_k,
           sum(so) FILTER (WHERE so IS NOT NULL AND so <= bf) AS so_k,
           max(d) AS d
      FROM xso
     WHERE pa > 0 OR outs > 0 OR bf > 0
     GROUP BY player_id
  ),
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

    UNION ALL
    SELECT player_id, 'gp_season_obp', round(obp_w / pa_obp, 3), d FROM xagg WHERE pa_obp >= 15
    UNION ALL
    SELECT player_id, 'gp_season_ops', round(ops_w / pa_ops, 3), d FROM xagg WHERE pa_ops >= 15
    UNION ALL
    SELECT player_id, 'gp_season_whip', round(whip_w / outs_whip, 2), d FROM xagg WHERE outs_whip >= 15
    UNION ALL
    SELECT player_id, 'gp_season_k_pct', round(so_k * 100.0 / bf_k, 1), d FROM xagg WHERE bf_k >= 20
  )
  SELECT a.player_id, a.mkey::text, a.v::numeric, a.d::date FROM allv a WHERE a.v IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.rating_metric_values() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. player_rating_inputs: same contract as before, reads the shared values.
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
  lower_better(mkey) AS (VALUES ('hit_ttc'), ('run_sprint10'), ('gp_whip'), ('gp_season_whip'), ('fld_pop_time')),
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

-- ---------------------------------------------------------------------------
-- 4. player_rating_coverage(): #478, staff only. Which metrics every player
--    has and when each was last measured. No values, no percentiles. The
--    client maps metric_key -> card category via src/playerRatings.js and
--    must page it (readAllPages): one row per player per metric.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.player_rating_coverage()
RETURNS TABLE(player_id uuid, metric_key text, measured_on date)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF coalesce(public.get_user_role(), '') NOT IN ('admin', 'coach') THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT r.player_id, r.metric_key, r.measured_on
    FROM public.rating_metric_values() r
    JOIN users u ON u.id = r.player_id AND u.role = 'player';
END;
$$;

REVOKE ALL ON FUNCTION public.player_rating_coverage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.player_rating_coverage() TO authenticated;
