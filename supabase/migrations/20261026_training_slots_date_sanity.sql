-- #468: a typo'd 5-digit year (repeat_end_date '20265-09-02') made a weekly
-- series repeat forever in Chrome while iOS Safari could not parse it and
-- dropped it, so a coach showed as bookable on desktop and not on mobile.
-- Keep every slot date inside a plausible window.
ALTER TABLE public.training_slots
  ADD CONSTRAINT training_slots_slot_date_sane
    CHECK (slot_date BETWEEN DATE '2020-01-01' AND DATE '2099-12-31'),
  ADD CONSTRAINT training_slots_repeat_end_date_sane
    CHECK (repeat_end_date IS NULL OR repeat_end_date BETWEEN DATE '2020-01-01' AND DATE '2099-12-31');
