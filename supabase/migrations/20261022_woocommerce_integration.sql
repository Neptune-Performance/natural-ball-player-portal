-- WooCommerce -> portal purchases.
--
-- The public site (thenaturalballplayer.com, WordPress + WooCommerce, run by
-- the design studio) sells NBP products. Each paid order is POSTed by a native
-- WooCommerce order webhook to the `woocommerce-webhook` edge function, which
-- writes one store_purchases row per line item, so a Woo purchase looks to the
-- rest of the portal exactly like a Square one (booking gate, PackagesModal,
-- session usage, expiry).
--
-- woo_product_map: which store_products row a Woo product (or variation) is.
--   The studio never needs portal IDs; staff own this mapping. A row with
--   woo_variation_id = 0 matches every variation of that product unless a more
--   specific row exists. access_days overrides the expiry the function would
--   otherwise derive (5/10/20 pack rule, or 31 days for a recurring product).
-- woo_orders: one row per Woo order, the last payload and what the function
--   did with it. needs_review flags orders staff must look at (unmapped
--   products, partial refunds, account creation problems).

create table if not exists public.woo_product_map (
  id uuid primary key default gen_random_uuid(),
  woo_product_id bigint not null,
  woo_variation_id bigint not null default 0,
  store_product_id uuid not null references public.store_products(id) on delete cascade,
  access_days integer check (access_days is null or access_days > 0),
  woo_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (woo_product_id, woo_variation_id)
);

create table if not exists public.woo_orders (
  woo_order_id bigint primary key,
  woo_order_number text,
  status text not null,
  billing_email text,
  athlete_email text,
  user_id uuid references public.users(id) on delete set null,
  user_created boolean not null default false,
  needs_review boolean not null default false,
  review_reason text,
  result jsonb not null default '[]'::jsonb,
  last_topic text,
  last_delivery_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.store_purchases
  add column if not exists woo_order_id bigint,
  add column if not exists woo_line_item_id bigint;

-- Plain (non-partial) unique index: NULLs never collide, and PostgREST upsert
-- can target it (partial indexes do not work with ON CONFLICT via PostgREST).
create unique index if not exists store_purchases_woo_line_item_id_key
  on public.store_purchases (woo_line_item_id);
create index if not exists store_purchases_woo_order_id_idx
  on public.store_purchases (woo_order_id);

alter table public.woo_product_map enable row level security;
alter table public.woo_orders enable row level security;

create policy woo_product_map_select_staff on public.woo_product_map
  for select to authenticated using (public.get_user_role() in ('admin', 'coach'));
create policy woo_product_map_insert_staff on public.woo_product_map
  for insert to authenticated with check (public.get_user_role() in ('admin', 'coach'));
create policy woo_product_map_update_staff on public.woo_product_map
  for update to authenticated using (public.get_user_role() in ('admin', 'coach'))
  with check (public.get_user_role() in ('admin', 'coach'));
create policy woo_product_map_delete_staff on public.woo_product_map
  for delete to authenticated using (public.get_user_role() in ('admin', 'coach'));

-- Written only by the edge function (service_role); staff read, and may clear
-- needs_review after looking.
create policy woo_orders_select_staff on public.woo_orders
  for select to authenticated using (public.get_user_role() in ('admin', 'coach'));
create policy woo_orders_update_staff on public.woo_orders
  for update to authenticated using (public.get_user_role() in ('admin', 'coach'))
  with check (public.get_user_role() in ('admin', 'coach'));

grant all on public.woo_product_map to authenticated;
grant all on public.woo_orders to authenticated;
grant all on public.woo_product_map to service_role;
grant all on public.woo_orders to service_role;
