-- #463: pitchers log a whole outing (line score) instead of pitch by pitch.
-- Many athletes (college pitchers especially) only have the box-score numbers,
-- not every pitch. practice_pitches stays for pitch-by-pitch logging; this is
-- the summary alternative. Same access as practice_pitches, plus the athlete
-- may delete their own rows (a typo otherwise needs a coach).

create table if not exists public.practice_pitching_outings (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.users(id) on delete cascade,
  log_date date not null,
  context text not null default 'game',
  opponent text,
  innings_pitched numeric(4,1) check (innings_pitched is null or innings_pitched >= 0),
  pitches integer check (pitches is null or pitches >= 0),
  strikes integer check (strikes is null or strikes >= 0),
  hits integer check (hits is null or hits >= 0),
  runs integer check (runs is null or runs >= 0),
  earned_runs integer check (earned_runs is null or earned_runs >= 0),
  walks integer check (walks is null or walks >= 0),
  strikeouts integer check (strikeouts is null or strikeouts >= 0),
  hit_by_pitch integer check (hit_by_pitch is null or hit_by_pitch >= 0),
  max_velo numeric(5,1),
  avg_velo numeric(5,1),
  notes text,
  logged_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists practice_pitching_outings_player_idx
  on public.practice_pitching_outings (player_id, log_date desc);

alter table public.practice_pitching_outings enable row level security;

create policy practice_pitching_outings_select on public.practice_pitching_outings
  for select to authenticated
  using (player_id = (select auth.uid()) or public.get_user_role() in ('admin', 'coach'));
create policy practice_pitching_outings_insert on public.practice_pitching_outings
  for insert to authenticated
  with check (public.get_user_role() in ('admin', 'coach'));
create policy practice_pitching_outings_insert_own on public.practice_pitching_outings
  for insert to authenticated
  with check (player_id = (select auth.uid()));
create policy practice_pitching_outings_update on public.practice_pitching_outings
  for update to authenticated
  using (public.get_user_role() in ('admin', 'coach'))
  with check (public.get_user_role() in ('admin', 'coach'));
create policy practice_pitching_outings_delete on public.practice_pitching_outings
  for delete to authenticated
  using (player_id = (select auth.uid()) or public.get_user_role() in ('admin', 'coach'));

grant all on public.practice_pitching_outings to authenticated;
grant all on public.practice_pitching_outings to service_role;
