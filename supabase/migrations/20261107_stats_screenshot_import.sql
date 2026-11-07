-- =====================================================================
-- #483 / #487: stats read from screenshots (stats-extract edge function,
-- Claude vision) and reviewed by a person before saving.
--
-- #483  Staff photograph / screenshot past Trackman session screens and
--       import them into the athlete's Trackman tab.
--         trackman_sessions.source = 'screenshot' (FTP imports are 'ftp',
--         BullpenSync 'live').
--         file_path is still the unique key; screenshot sessions use
--         'screenshot/<uuid>', which can never equal an FTP path
--         ('practice/YYYY/MM/DD/...'), so the nightly sync's
--         upsert(onConflict file_path) can't touch them. Their pitches have
--         pitch_uid NULL, so the pitches upsert (onConflict pitch_uid,
--         ignoreDuplicates) can't either.
--         Most Trackman summary screens show one line PER PITCH TYPE
--         (averages), not per pitch. Those are stored as one trackman_pitches
--         row per pitch type with is_summary = true, summary_count = how many
--         pitches the line averages, and max_speed = the screen's max velo.
--         Every reader (the tab, the Player Card) weights by summary_count.
--         Per-pitch screens are stored as normal rows (is_summary false).
--       Screenshots: private bucket 'trackman-screenshots' at
--       {player_id}/{ts}-{name}; staff write, athlete reads own folder.
--
-- #487  external_season_stats: one row per athlete per source per season per
--       category (hitting / pitching / fielding), read from GameChanger (or
--       any) stat screenshots, or typed. Feeds the Player Card: Game Play
--       (OBP / OPS / WHIP / K% / ERA) and Fielding (fielding %), recent
--       seasons weighted more. Screenshots live in the existing
--       'external-stats' bucket under {player_id}/... (existing policies).
--
-- SAFE TO RUN TWICE.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Trackman screenshot sessions
-- ---------------------------------------------------------------------
ALTER TABLE public.trackman_sessions ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'ftp';
ALTER TABLE public.trackman_sessions DROP CONSTRAINT IF EXISTS trackman_sessions_source_check;
ALTER TABLE public.trackman_sessions ADD CONSTRAINT trackman_sessions_source_check
  CHECK (source IN ('ftp', 'live', 'screenshot'));  -- 'live' = BullpenSync
ALTER TABLE public.trackman_sessions ADD COLUMN IF NOT EXISTS player_id uuid REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.trackman_sessions ADD COLUMN IF NOT EXISTS screenshot_paths text[];
-- captured_by already exists live (BullpenSync); a screenshot import stamps the staff member.
ALTER TABLE public.trackman_sessions ADD COLUMN IF NOT EXISTS captured_by uuid REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.trackman_sessions ADD COLUMN IF NOT EXISTS notes text;

-- trackman_pitches.source already exists live ('ftp' | 'live'); screenshot rows write 'screenshot'.
ALTER TABLE public.trackman_pitches ADD COLUMN IF NOT EXISTS source text DEFAULT 'ftp';
ALTER TABLE public.trackman_pitches ADD COLUMN IF NOT EXISTS is_summary boolean NOT NULL DEFAULT false;
ALTER TABLE public.trackman_pitches ADD COLUMN IF NOT EXISTS summary_count integer;
ALTER TABLE public.trackman_pitches ADD COLUMN IF NOT EXISTS max_speed numeric;
ALTER TABLE public.trackman_pitches DROP CONSTRAINT IF EXISTS trackman_pitches_summary_count_check;
ALTER TABLE public.trackman_pitches ADD CONSTRAINT trackman_pitches_summary_count_check
  CHECK (summary_count IS NULL OR summary_count BETWEEN 1 AND 1000);

CREATE INDEX IF NOT EXISTS trackman_sessions_player_idx ON public.trackman_sessions (player_id) WHERE player_id IS NOT NULL;

-- #435's guard lets a pitcher change only tagged_pitch_type; the new columns
-- are covered by it already (it compares every column except that one).

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('trackman-screenshots', 'trackman-screenshots', false, 15728640,
        ARRAY['image/png', 'image/jpeg', 'image/webp'])
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Trackman screenshots read" ON storage.objects;
CREATE POLICY "Trackman screenshots read" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'trackman-screenshots'
    AND (public.get_user_role() IN ('admin', 'coach')
         OR (storage.foldername(name))[1] = (SELECT auth.uid())::text)
  );

DROP POLICY IF EXISTS "Trackman screenshots write" ON storage.objects;
CREATE POLICY "Trackman screenshots write" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'trackman-screenshots' AND public.get_user_role() IN ('admin', 'coach'));

DROP POLICY IF EXISTS "Trackman screenshots delete" ON storage.objects;
CREATE POLICY "Trackman screenshots delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'trackman-screenshots' AND public.get_user_role() IN ('admin', 'coach'));

-- ---------------------------------------------------------------------
-- 2. external_season_stats
--    Shared stat columns; h / bb / so / hbp mean "allowed" on a pitching
--    row. ip is baseball notation (4.2 = 4 innings + 2 outs). Anything the
--    screen shows that has no column goes in extras.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.external_season_stats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('gamechanger', 'perfect_game', 'maxpreps', 'pbr', 'other')),
  season text NOT NULL,
  season_year integer CHECK (season_year IS NULL OR season_year BETWEEN 2000 AND 2100),
  category text NOT NULL CHECK (category IN ('hitting', 'pitching', 'fielding')),
  team text,
  games integer,
  -- hitting (h / bb / so / hbp shared with pitching)
  pa integer, ab integer, r integer, h integer, doubles integer, triples integer, hr integer,
  rbi integer, bb integer, so integer, hbp integer, sf integer, sb integer, cs integer,
  avg numeric, obp numeric, slg numeric, ops numeric,
  -- pitching
  ip numeric, bf integer, pitches integer, er integer, era numeric, whip numeric, baa numeric,
  w integer, l integer, sv integer,
  -- fielding
  tc integer, po integer, a integer, e integer, dp integer, fpct numeric,
  extras jsonb CHECK (extras IS NULL OR jsonb_typeof(extras) = 'object'),
  origin text NOT NULL DEFAULT 'screenshot' CHECK (origin IN ('screenshot', 'manual')),
  screenshot_paths text[],
  external_stats_id uuid REFERENCES public.external_stats(id) ON DELETE SET NULL,
  uploaded_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One line per athlete / source / season / category / team: a re-import of
-- the same season replaces the old line (the client updates the match).
CREATE UNIQUE INDEX IF NOT EXISTS external_season_stats_unique_line
  ON public.external_season_stats (player_id, source, lower(season), category, coalesce(lower(team), ''));
CREATE INDEX IF NOT EXISTS external_season_stats_player_idx
  ON public.external_season_stats (player_id, season_year DESC);

ALTER TABLE public.external_season_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS external_season_stats_select ON public.external_season_stats;
CREATE POLICY external_season_stats_select ON public.external_season_stats
  FOR SELECT TO authenticated
  USING (player_id = (SELECT auth.uid()) OR public.get_user_role() IN ('admin', 'coach'));

DROP POLICY IF EXISTS external_season_stats_insert ON public.external_season_stats;
CREATE POLICY external_season_stats_insert ON public.external_season_stats
  FOR INSERT TO authenticated
  WITH CHECK (
    uploaded_by = (SELECT auth.uid())
    AND (player_id = (SELECT auth.uid()) OR public.get_user_role() IN ('admin', 'coach'))
  );

DROP POLICY IF EXISTS external_season_stats_update ON public.external_season_stats;
CREATE POLICY external_season_stats_update ON public.external_season_stats
  FOR UPDATE TO authenticated
  USING (player_id = (SELECT auth.uid()) OR public.get_user_role() IN ('admin', 'coach'))
  WITH CHECK (player_id = (SELECT auth.uid()) OR public.get_user_role() IN ('admin', 'coach'));

DROP POLICY IF EXISTS external_season_stats_delete ON public.external_season_stats;
CREATE POLICY external_season_stats_delete ON public.external_season_stats
  FOR DELETE TO authenticated
  USING (player_id = (SELECT auth.uid()) OR public.get_user_role() IN ('admin', 'coach'));

GRANT ALL ON public.external_season_stats TO authenticated;
GRANT ALL ON public.external_season_stats TO service_role;

COMMENT ON TABLE public.external_season_stats IS
  '#487: season stat lines (hitting / pitching / fielding) read from external stat screenshots (GameChanger etc.) and reviewed before saving. Feed Player Card Game Play + Fielding.';

-- ---------------------------------------------------------------------
-- 3. rating_metric_values(): 20261103 version plus
--    - Trackman summary rows weighted by summary_count, max_speed counted
--    - external_season_stats folded into the #476 season metrics with a
--      recency weight, plus gp_season_era and fld_season_fpct
-- ---------------------------------------------------------------------
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
  allv AS (
    SELECT player_id, mkey, v, d FROM aval WHERE mkey <> 'pit_fb_assess'
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
