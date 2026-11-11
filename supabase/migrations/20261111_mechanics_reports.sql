begin;
create table if not exists public.athlete_reports (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null references public.users(id) on delete cascade,
  source text not null default 'triton-mechanics' check(source='triton-mechanics'),
  delivery_id uuid not null unique,
  source_report_id uuid not null,
  source_session_id uuid not null,
  source_sender_id uuid not null,
  fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$'),
  title text not null,
  capture_date date not null,
  finalized_at timestamptz not null,
  received_at timestamptz not null default now(),
  payload jsonb not null check(payload->>'schema' = 'mechanics-session-report-v1'),
  unique(source,source_session_id,fingerprint,athlete_id)
);
create index if not exists athlete_reports_inbox_idx on public.athlete_reports(athlete_id,received_at desc,id);
alter table public.athlete_reports enable row level security;
revoke all on public.athlete_reports from public,anon,authenticated;
grant select on public.athlete_reports to authenticated;
grant all on public.athlete_reports to service_role;
drop policy if exists "Athlete or staff reads reports" on public.athlete_reports;
create policy "Athlete or staff reads reports" on public.athlete_reports for select to authenticated
  using (athlete_id=auth.uid() or public.get_user_role() in ('admin','coach'));

-- Only the server integration can deliver; browsers cannot create or modify reports.
create or replace function public.receive_mechanics_report(
  p_delivery uuid,p_report uuid,p_athlete uuid,p_sender uuid,p_fingerprint text,p_finalized_at timestamptz,p_payload jsonb
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare existing public.athlete_reports; result uuid;
begin
  if p_payload->>'schema' is distinct from 'mechanics-session-report-v1'
     or p_payload->>'kind' is distinct from 'mechanics-session'
     or jsonb_typeof(p_payload->'groups') is distinct from 'array'
     or coalesce(p_payload->>'athleteName','')='' then raise exception 'Invalid report'; end if;
  perform 1 from public.users where id=p_athlete and role='player' for share;
  if not found then raise exception 'Recipient unavailable' using errcode='P0002'; end if;
  -- Serialize deliveries of this fingerprint/recipient, including retries with a new ID.
  perform pg_advisory_xact_lock(hashtextextended(p_athlete::text || p_fingerprint,0));
  select * into existing from public.athlete_reports where delivery_id=p_delivery;
  if found then
    if existing.athlete_id<>p_athlete or existing.source_report_id<>p_report
      or existing.fingerprint<>p_fingerprint or existing.payload<>p_payload then
      raise exception 'Delivery identity reused' using errcode='23505';
    end if;
    return existing.id;
  end if;
  select * into existing from public.athlete_reports where source_session_id=(p_payload->>'sessionId')::uuid
    and fingerprint=p_fingerprint and athlete_id=p_athlete;
  if found then
    if existing.payload<>p_payload then raise exception 'Report identity reused' using errcode='23505'; end if;
    return existing.id;
  end if;
  insert into public.athlete_reports(athlete_id,delivery_id,source_report_id,source_session_id,source_sender_id,
    fingerprint,title,capture_date,finalized_at,payload)
    values(p_athlete,p_delivery,p_report,(p_payload->>'sessionId')::uuid,p_sender,p_fingerprint,
      (p_payload->>'athleteName') || ' — Mechanics ' || (p_payload->>'captureDate'),
      (p_payload->>'captureDate')::date,p_finalized_at,p_payload) returning id into result;
  return result;
end; $$;
revoke all on function public.receive_mechanics_report(uuid,uuid,uuid,uuid,text,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.receive_mechanics_report(uuid,uuid,uuid,uuid,text,timestamptz,jsonb) to service_role;
commit;
