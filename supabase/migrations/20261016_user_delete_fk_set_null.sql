-- #453: "Can't delete players".
--
-- delete-user calls auth.admin.deleteUser, which cascades auth.users ->
-- public.users -> every child table. Six foreign keys still had the default
-- NO ACTION rule, so the whole delete was refused (SQLSTATE 23503). The one
-- that bit players was email_campaign_recipients.user_id: anyone who had ever
-- been sent a campaign email could not be deleted (first seen 2026-10-16,
-- user 56df299e…, three attempts).
--
-- SET NULL, not CASCADE, on all six:
--   * email_campaign_recipients keeps its own `email` and `unsubscribe_token`,
--     so the send history and every unsubscribe link already in an inbox keep
--     working after the person is gone.
--   * the five created_by columns are authorship stamps on shared staff
--     content (templates, images, campaigns, assessment templates, Trackman
--     name mappings). Deleting a staff member must not delete their work.
-- All six columns are already nullable.

begin;

alter table public.email_campaign_recipients
  drop constraint email_campaign_recipients_user_id_fkey,
  add constraint email_campaign_recipients_user_id_fkey
    foreign key (user_id) references public.users(id) on delete set null;

alter table public.email_campaigns
  drop constraint email_campaigns_created_by_fkey,
  add constraint email_campaigns_created_by_fkey
    foreign key (created_by) references public.users(id) on delete set null;

alter table public.email_templates
  drop constraint email_templates_created_by_fkey,
  add constraint email_templates_created_by_fkey
    foreign key (created_by) references public.users(id) on delete set null;

alter table public.email_images
  drop constraint email_images_created_by_fkey,
  add constraint email_images_created_by_fkey
    foreign key (created_by) references public.users(id) on delete set null;

alter table public.trackman_player_map
  drop constraint trackman_player_map_created_by_fkey,
  add constraint trackman_player_map_created_by_fkey
    foreign key (created_by) references public.users(id) on delete set null;

alter table public.assessment_templates
  drop constraint assessment_templates_created_by_fkey,
  add constraint assessment_templates_created_by_fkey
    foreign key (created_by) references auth.users(id) on delete set null;

commit;
