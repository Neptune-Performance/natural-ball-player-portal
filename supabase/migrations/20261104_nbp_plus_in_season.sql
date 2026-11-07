-- #482: NBP+ agreements gain an in-season clause the athlete initials: the
-- training price is cut 50% for the months the athlete is in a high school,
-- college or pro season. Nullable because agreements signed before
-- 2026-11-04 never showed the clause. Staff apply the discount month by
-- month; nothing here computes it.
ALTER TABLE public.nbp_plus_agreements ADD COLUMN IF NOT EXISTS initials_in_season TEXT;
