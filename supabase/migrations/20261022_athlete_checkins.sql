-- #462: athletes check in to today's lifts and booked sessions.
--
-- On login an athlete with a workout (schedule_events.event_type='workout')
-- or a booked lesson (slot_reservations pending/confirmed) today is asked
-- "Doing it" / "Not today", and later marks each one Completed. Completion %
-- over the last 30 days is shown next to their age on the profile.
--
-- This is the athlete's OWN report and is deliberately separate from
-- slot_reservations.attendance, which coaches mark.
--
-- item_type 'workout' -> item_id = schedule_events.id
-- item_type 'session' -> item_id = slot_reservations.id (one reservation is
--                        one occurrence, so item_date is that slot_date)

create table if not exists public.athlete_checkins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  item_type text not null check (item_type in ('workout', 'session')),
  item_id uuid not null,
  item_date date not null,
  title text,
  intent text check (intent in ('doing', 'skipping')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, item_type, item_id, item_date)
);

create index if not exists athlete_checkins_user_date_idx
  on public.athlete_checkins (user_id, item_date);

alter table public.athlete_checkins enable row level security;

create policy athlete_checkins_select on public.athlete_checkins
  for select to authenticated
  using (user_id = auth.uid() or public.get_user_role() in ('admin', 'coach'));
create policy athlete_checkins_insert_own on public.athlete_checkins
  for insert to authenticated with check (user_id = auth.uid());
create policy athlete_checkins_update_own on public.athlete_checkins
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy athlete_checkins_delete_own on public.athlete_checkins
  for delete to authenticated using (user_id = auth.uid());

grant all on public.athlete_checkins to authenticated;
grant all on public.athlete_checkins to service_role;
