-- #471 / #472 — exercise video links stick.
--
-- Root cause (#472): the Programming → exercise video gaps screen wrote a
-- coach's URL onto the training_exercises rows that existed at that moment and
-- nowhere else. The generators (S&C / throwing / hitting / Auto-Program / PT /
-- Coach Tools) insert NEW training_exercises rows every week with an empty
-- video_url, so the same movements came straight back onto the to-do list.
-- 'goblet squat' on 2026-10-29: 5 linked rows, 24 empty, not in exercise_videos.
--
-- This migration:
--   1. public.exercise_video_key(text) — the library key in SQL.
--   2. A BEFORE INSERT / UPDATE OF name, video_url trigger on training_exercises
--      that fills an empty video_url from exercise_videos. One place catches
--      every generator without touching any of them.
--   3. One-time backfill: (a) seed exercise_videos from links that already
--      exist on program rows and workout-template entries for names the
--      library does not have; (b) fill empty training_exercises.video_url from
--      the library.
--
-- The client half (ExerciseVideoGaps.js) now also inserts into exercise_videos
-- when a coach applies a link, so the next generated row inherits it.
--
-- No RLS/grant changes are needed: exercise_videos already has
-- select-all + staff insert/update/delete policies (get_user_role()) and
-- authenticated has INSERT/SELECT/UPDATE/DELETE. The trigger function is
-- SECURITY DEFINER so a service_role writer (which has NO grant on
-- exercise_videos) never fails an insert because of this lookup.

begin;

-- ---------------------------------------------------------------------------
-- 1. Key function.
--
-- exercise_videos.name_key is NOT generated; the client writes it. Measured on
-- 2026-10-29: all 1,275 rows have name_key = lower(btrim(name)), and every JS
-- reader keys the library the same way — `name.trim().toLowerCase()`
-- (ExerciseNameInput.js, ptExerciseBank.js resolveBankExercise, and now
-- ExerciseVideoGaps.js libraryKey()). This is NOT exerciseVideoMatch.js
-- normalizeExerciseName (singularise + abbreviation expansion); that is only
-- used for fuzzy grouping on the gaps screen and never for the stored key.
--
-- DRIFT RISK: JS String.prototype.trim also strips Unicode spaces such as
-- U+00A0 and U+FEFF, which Postgres `\s` does not. A name padded with a
-- non-breaking space would key differently here and in the browser (the
-- trigger would simply not find it). If the JS key rule ever changes, change
-- this function in the same commit.
-- ---------------------------------------------------------------------------
create or replace function public.exercise_video_key(p_name text)
returns text
language sql
immutable
as $$
  select lower(regexp_replace(coalesce(p_name, ''), '^\s+|\s+$', '', 'g'))
$$;

grant execute on function public.exercise_video_key(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Trigger: fill an empty training_exercises.video_url from the library.
--
-- Never overwrites a non-empty URL. Fires on UPDATE OF name/video_url too, so
-- renaming a row to a library movement picks up its video, and CLEARING a
-- row's URL re-fills it from the library if the name is in there (to really
-- remove a video for a movement, change it on Programming → All videos).
-- ---------------------------------------------------------------------------
create or replace function public.training_exercises_fill_video_url()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url text;
begin
  if coalesce(btrim(new.video_url), '') = '' and coalesce(btrim(new.name), '') <> '' then
    select v.video_url into v_url
      from public.exercise_videos v
     where v.name_key = public.exercise_video_key(new.name)
       and btrim(v.video_url) <> ''
     limit 1;
    if v_url is not null then
      new.video_url := v_url;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists training_exercises_fill_video_url on public.training_exercises;
create trigger training_exercises_fill_video_url
  before insert or update of name, video_url on public.training_exercises
  for each row execute function public.training_exercises_fill_video_url();

-- ---------------------------------------------------------------------------
-- 3a. Seed the library from links that already exist.
--
-- Sources: training_exercises.video_url and workout_templates.exercises[].link.
-- Only names NOT already in the library (existing rows are never touched), and
-- only URLs on the same host allowlist the gaps screen accepts (https
-- YouTube / youtu.be / Vimeo / Loom) — that drops a handful of amzn.to,
-- physitrack, search-engine and scheme-less links.
--
-- Conflicting URLs for one name → a URL used on an assigned PROGRAM row wins
-- over a template-only one, then the most frequent, then the lexically
-- smallest (deterministic). Program first because those links are the recent,
-- deliberate picks made on the gaps screen; template links are older. Example:
-- 'goblet squat' has 5 program rows on youtube.com/shorts/NhIAae_IFoo and 13
-- template entries on an older watch?v=UanKNRvFoJY — the program one wins.
-- Within program rows the conflicts measured (20 names) are almost all the
-- SAME video with a different ?is= / ?si= share token.
-- Display name = the most frequent spelling.
--
-- Measured 2026-10-29 (read-only): 930 names / 4,422 linked entries seed new
-- library rows (library 1,275 → ~2,205).
-- ---------------------------------------------------------------------------
with src as (
  select public.exercise_video_key(te.name)                      as k,
         regexp_replace(te.name, '^\s+|\s+$', '', 'g')           as n,
         btrim(te.video_url)                                     as u,
         true                                                    as from_program
    from public.training_exercises te
   where coalesce(btrim(te.name), '') <> ''
     and coalesce(btrim(te.video_url), '') <> ''
  union all
  select public.exercise_video_key(e->>'name'),
         regexp_replace(e->>'name', '^\s+|\s+$', '', 'g'),
         btrim(e->>'link'),
         false
    from public.workout_templates t
   cross join lateral jsonb_array_elements(
           case when jsonb_typeof(t.exercises) = 'array' then t.exercises else '[]'::jsonb end) e
   where jsonb_typeof(e) = 'object'
     and coalesce(btrim(e->>'name'), '') <> ''
     and coalesce(btrim(e->>'link'), '') <> ''
),
eligible as (
  select *
    from src
   where k <> ''
     and u ~* '^https://(www\.)?(youtube\.com|youtube-nocookie\.com|youtu\.be|vimeo\.com|player\.vimeo\.com|loom\.com)/'
     and not exists (select 1 from public.exercise_videos v where v.name_key = src.k)
),
url_pick as (
  select distinct on (k) k, u
    from (select k, u, count(*) as c, bool_or(from_program) as on_program
            from eligible group by k, u) x
   order by k, on_program desc, c desc, u
),
name_pick as (
  select distinct on (k) k, n
    from (select k, n, count(*) as c from eligible group by k, n) y
   order by k, c desc, n
)
insert into public.exercise_videos (name, name_key, video_url)
select np.n, up.k, up.u
  from url_pick up
  join name_pick np using (k)
on conflict (name_key) do nothing;

-- ---------------------------------------------------------------------------
-- 3b. Fill empty program rows from the (now larger) library.
--
-- Measured 2026-10-29 (read-only): 3,551 of 4,720 empty rows across 51 names
-- (104 from names already in the library, 3,447 from names seeded in 3a).
-- Workout-template entries are NOT rewritten here (JSONB arrays; only 5
-- entries qualify) — the gaps screen offers them as a one-click
-- "fill from library" instead.
-- ---------------------------------------------------------------------------
update public.training_exercises te
   set video_url = v.video_url
  from public.exercise_videos v
 where coalesce(btrim(te.video_url), '') = ''
   and coalesce(btrim(te.name), '') <> ''
   and v.name_key = public.exercise_video_key(te.name);

commit;
