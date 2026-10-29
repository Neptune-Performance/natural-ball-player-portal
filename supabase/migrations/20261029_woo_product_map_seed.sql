-- Seed woo_product_map from the studio's product list (NBP-PRODUCTS-ID.csv,
-- 54 WooCommerce products). Decisions (Trevor, 2026-10-29):
--  * Woo subscriptions map to the portal's recurring rows (31-day access via
--    `recurring`), not the same-named one-off rows. #986 is the three-program
--    product: Woo's $506 is the monthly price of the $250 biweekly plan.
--  * The four "NBP Select" products are new store_products rows.
--  * Kaden Kirshenbaum packs get bundle_qty 5/10/20 like the Josh Sale packs.
--  * One-time monthly program fees get access_days = 31.

begin;

update public.store_products set bundle_qty = 5  where id = 'bff9efc4-e0e0-49df-8c16-63bc251d5523';
update public.store_products set bundle_qty = 10 where id = '57a6b173-9a0a-43b0-a28b-74ab16f8a921';
update public.store_products set bundle_qty = 20 where id = 'b4a9268b-a663-4227-911f-f53bcf423c0b';

insert into public.store_products (name, kind, price_cents, recurring, active)
select v.name, 'lesson', v.price_cents, false, true
from (values
  ('NBP Select 8-9U', 250000),
  ('NBP Select 10-13u', 300000),
  ('NBP Select 14U', 325000),
  ('NBP Select 15-18U', 400000)
) as v(name, price_cents)
where not exists (select 1 from public.store_products p where p.name = v.name);

insert into public.woo_product_map (woo_product_id, store_product_id, access_days, woo_name)
select m.woo_id, coalesce(m.store_id, (select id from public.store_products where name = m.woo_name)), m.access_days, m.woo_name
from (values
  (292,  null::uuid, null::int, 'NBP Select 8-9U'),
  (293,  null, null, 'NBP Select 10-13u'),
  (294,  null, null, 'NBP Select 14U'),
  (295,  null, null, 'NBP Select 15-18U'),
  (953,  '2a808c07-a5ee-4f78-a8ac-cac3a8a214a4', null, '10 Pack of Cage Rentals'),
  (954,  '546d3968-3b79-47fb-9b69-58d6bd851523', null, '10 Pack of One on One Lessons'),
  (955,  '26699fd2-70db-4471-b578-8b52ca9985b8', null, '10 Pack of Small Group Training'),
  (956,  '8503fe47-8882-4644-91bf-54f48eb30c85', null, '20 Pack of One on One Private Lessons'),
  (957,  '917a11f2-e697-4faf-bd29-b68817542d1b', null, '20 Pack of Small Group Training'),
  (958,  'a8c97869-fe5a-4125-8775-209edae3292c', null, '5 Pack of Cage Rentals'),
  (959,  'f1aa1445-16a2-43e7-a9b1-f72155672367', null, '5 Pack of One on One Lessons'),
  (960,  'c720dcf6-084a-4e2f-a37d-93daf770604a', null, '5 Pack of Small Group Training'),
  (961,  'a2830274-74ca-4c53-ad2c-eab57d493a09', null, '50 Pack of One on One Lessons'),
  (962,  'e1b2d07a-7b89-4229-a1b2-f4ce6d702a19', null, 'Adam Cimber Submarine Academy Remote'),
  (964,  '422c3e58-c1c3-45b3-a7de-092157c88cc0', null, 'Biolab Motion Capture Assessment'),
  (965,  '94e54b83-6449-4d96-bed4-056228718d71', null, 'Equipment / Clean Up Fine'),
  (967,  'b448d6e0-8696-4970-a390-11c5268eaaa2', null, 'IP'),
  (968,  '57a6b173-9a0a-43b0-a28b-74ab16f8a921', null, 'Kaden Kirshenbaum 10 Pack of One on One Lessons.'),
  (969,  'b4a9268b-a663-4227-911f-f53bcf423c0b', null, 'Kaden Kirshenbaum 20 Pack of One on One Lessons.'),
  (970,  'bff9efc4-e0e0-49df-8c16-63bc251d5523', null, 'Kaden Kirshenbaum 5 Pack of One on One Lessons'),
  (972,  '5b1005e1-c0ec-49f6-b965-fd2d1414b803', 31, 'NBP 1-2x A Week Training'),
  (974,  '55d2bbc0-22d9-4e3e-b3b8-c260ba3ba809', null, 'NBP 2x A Week Training'),
  (975,  '7ecb1a96-fb40-4a18-9c07-b2adce8a96be', null, 'NBP 3x A Week Training'),
  (976,  'd7fc99fa-c2fc-451e-a89d-a83a85dbb7b5', null, 'NBP College Training'),
  (977,  '495ea230-c04a-455e-b4c3-e1e9ed685cff', null, 'NBP Gym Membership'),
  (978,  '57c5ba04-2d28-45db-b527-937c93078f0c', 31, 'NBP Hitting / Fielding / Base Running Program'),
  (979,  '8cc336cb-54fa-4202-87dc-3e5d61e49eb0', 31, 'NBP Once A Week Training'),
  (980,  '16cb7fae-a9c6-466d-8281-f490811b8f78', 31, 'NBP Pitching / Throwing Program'),
  (981,  '58bfdd36-93ed-4611-9fce-d16926615951', 31, 'NBP Remote'),
  (983,  'f935b617-3083-4320-8a9b-89bc3fa1969b', null, 'NBP Strength & Conditioning Program'),
  (984,  '969a8b37-3873-4f3f-9a0b-2c4910f283c9', 31, 'NBP Strength & Conditioning and Hitting / Fielding / Base Running Program'),
  (985,  'eff36b2b-c292-496d-87f6-442bdeefe68a', 31, 'NBP Strength & Conditioning and Pitching / Throwing Program'),
  (986,  'abb51c34-6119-4e75-a332-b585ca229779', null, 'NBP Strength & Conditioning, Pitching / Throwing Program and Hitting / Fielding / Base Running Program'),
  (987,  '3ccc19a8-467e-433b-88d4-02f18b319616', null, 'NBP Training'),
  (988,  '5355648e-3a95-4e8e-be4e-8e739baabfcf', null, 'Naturals 10u Team Deposit'),
  (989,  '2aaceaf9-1e7c-4388-986c-52d68827c078', null, 'Naturals 11u Team Deposit'),
  (990,  '61a94652-7fbd-4daa-b793-5e0e0d7c641a', null, 'Naturals 12u Team Deposit'),
  (991,  'bfa09a88-7095-40d9-9492-cedbe63e171c', null, 'Naturals 13u Team Deposit'),
  (992,  'a3d704e0-e4e3-446b-952f-330e4a11299a', null, 'Naturals 14u Team Deposit'),
  (993,  '56426448-ac63-4358-997f-2fe26983a947', null, 'Naturals 15u Team Deposit'),
  (994,  '81da8aaf-eeba-4dde-bc30-0eb7a29fb50c', null, 'Naturals 16u Team Deposit'),
  (995,  '64081fa0-6617-46bc-9b1a-0ed91f876a75', null, 'Naturals 17u Team Deposit'),
  (997,  '5ac09d23-68bf-4bd9-8270-601a4c387c9e', null, 'Naturals 18u Team Deposit'),
  (998,  '0e8f2872-1284-4438-9aea-7550d17226d0', null, 'Naturals 8u Team Deposit'),
  (999,  '6402aaa6-e759-4da3-82cf-7308e30afee4', null, 'Naturals 9u Team Deposit'),
  (1000, '524cb112-6d40-4f1c-942a-caeb8cf6d1fb', null, 'Naturals Monthly Team'),
  (1001, 'dfd6b205-19d9-41cd-b646-a8a34cf7074f', null, 'Naturals Second Half Team Fee'),
  (1002, '2f943535-1120-42d9-8929-28b5d71b67ae', null, 'Naturals Team Deposit'),
  (1003, '6607651f-bbfb-46dd-b5a1-478b3b0555d8', null, 'No School Day Camp'),
  (1004, '8b640397-5a3d-44d6-bc0c-be9aa9140662', null, 'One Assessment Session'),
  (1005, '37fce869-f6ec-45ae-9daa-a5899207e973', null, 'Submarine Academy'),
  (1006, '1ca6d879-89d2-4a6e-b002-d60621d9b734', null, 'The Naturals Team Payment'),
  (1007, 'a2abe8cd-fada-46ec-9234-536fb02a41f4', null, 'Trevor May Pitching Academy'),
  (1013, '0a9dd126-2cdc-4473-b18f-1cbebaa93d48', null, 'Indoor Lanes Rental (Complete)')
) as m(woo_id, store_id, access_days, woo_name)
on conflict (woo_product_id, woo_variation_id) do update
  set store_product_id = excluded.store_product_id,
      access_days = excluded.access_days,
      woo_name = excluded.woo_name,
      updated_at = now();

commit;
