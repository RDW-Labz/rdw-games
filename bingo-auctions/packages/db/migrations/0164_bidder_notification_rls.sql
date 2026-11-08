-- 0164: bidder visibility into notification + payment-followup history
--
-- notifications_outbox and payment_followups have RLS enabled but no
-- bidder SELECT policies. Result: bidder app cannot query notification
-- history -> no Alerts screen possible. User report 2026-06-01: card-
-- declined push fired, bidder couldn't find where to retry payment.
--
-- Column names (verified by inspecting create migrations):
--   - notifications_outbox.target_user_id  (FK auth.users.id; 0006_notifications_pickup.sql)
--   - payment_followups.bidder_id          (FK bidders.id == auth.users.id; 0077_disputes_and_dunning.sql)
-- Since bidders.id PK references auth.users(id), auth.uid() matches in both.

ALTER TABLE public.notifications_outbox ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notifications_outbox_self_read ON public.notifications_outbox;
CREATE POLICY notifications_outbox_self_read ON public.notifications_outbox
  FOR SELECT TO authenticated
  USING (target_user_id = (SELECT auth.uid()));

ALTER TABLE public.payment_followups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payment_followups_self_read ON public.payment_followups;
CREATE POLICY payment_followups_self_read ON public.payment_followups
  FOR SELECT TO authenticated
  USING (bidder_id = (SELECT auth.uid()));
