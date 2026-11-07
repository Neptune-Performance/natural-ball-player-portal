-- #484: the daily check-in covers all four things on an athlete's schedule:
-- lifts (workout), practices, games and booked sessions. Practices and games
-- are schedule_events rows like workouts, so item_id is still
-- schedule_events.id; the item_type names the category so the modal, the
-- catch-up list and the completion % can label it without a join.
--
-- Additive: existing 'workout' / 'session' rows are untouched.

alter table public.athlete_checkins
  drop constraint if exists athlete_checkins_item_type_check;
alter table public.athlete_checkins
  add constraint athlete_checkins_item_type_check
  check (item_type in ('workout', 'practice', 'game', 'session'));
