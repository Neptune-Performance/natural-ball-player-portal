-- #492: custom monthly price on the NBP+ Training Agreement.
--
-- Cordell agrees a price per month with some families that is not on the
-- pricing table. The athlete types it in under the 6 / 12 month term; the
-- signed price_cents / monthly_cents are then worked out from it instead of
-- the table. NULL = standard table price (every agreement before this).
--
-- An agreement with a custom price that NBP has not countersigned yet
-- (nbp_signed_at IS NULL) is what the admin bell lists as "to sign off".

ALTER TABLE public.nbp_plus_agreements
  ADD COLUMN IF NOT EXISTS custom_monthly_cents integer
    CHECK (custom_monthly_cents IS NULL OR custom_monthly_cents > 0);

COMMENT ON COLUMN public.nbp_plus_agreements.custom_monthly_cents IS
  '#492: custom pre-tax price per month agreed with NBP and typed by the athlete. NULL = pricing-table price.';
