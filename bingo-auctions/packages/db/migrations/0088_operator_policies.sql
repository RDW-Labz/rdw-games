-- 0088_operator_policies.sql
-- Per-operator policy documents (terms, refund, shipping) + operational
-- fields (payment window, pickup window, shipping toggle).
-- Bidders accept these once per operator before their first bid.
-- Re-prompted if the operator publishes a new version.

CREATE TABLE IF NOT EXISTS operator_policies (
  operator_id           UUID         NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  version               INT          NOT NULL,
  terms_md              TEXT         NOT NULL,
  refund_md             TEXT         NOT NULL,
  shipping_md           TEXT         NOT NULL,
  payment_window_hours  INT          NOT NULL DEFAULT 24
                       CHECK (payment_window_hours BETWEEN 0 AND 168),
  pickup_window_days    INT          NOT NULL DEFAULT 7
                       CHECK (pickup_window_days BETWEEN 1 AND 30),
  shipping_offered      BOOLEAN      NOT NULL DEFAULT FALSE,
  refund_window_post_pickup_hours INT NOT NULL DEFAULT 0
                       CHECK (refund_window_post_pickup_hours BETWEEN 0 AND 720),
  effective_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  published             BOOLEAN      NOT NULL DEFAULT FALSE,
  content_hash          TEXT         NOT NULL,
  created_by            UUID         REFERENCES auth.users(id),
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),

  PRIMARY KEY (operator_id, version)
);

CREATE INDEX IF NOT EXISTS operator_policies_lookup_idx
  ON operator_policies (operator_id, published, effective_at DESC);

ALTER TABLE operator_policies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "operator_policies: public read published" ON operator_policies;
CREATE POLICY "operator_policies: public read published"
  ON operator_policies FOR SELECT USING (published = TRUE);

DROP POLICY IF EXISTS "operator_policies: operator-staff read own" ON operator_policies;
CREATE POLICY "operator_policies: operator-staff read own"
  ON operator_policies FOR SELECT
  USING (
    operator_id IN (
      SELECT operator_id FROM operator_users WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "operator_policies: operator-admin write own" ON operator_policies;
CREATE POLICY "operator_policies: operator-admin write own"
  ON operator_policies FOR INSERT
  WITH CHECK (
    operator_id IN (
      SELECT operator_id FROM operator_users
       WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

DROP POLICY IF EXISTS "operator_policies: operator-admin update own" ON operator_policies;
CREATE POLICY "operator_policies: operator-admin update own"
  ON operator_policies FOR UPDATE
  USING (
    operator_id IN (
      SELECT operator_id FROM operator_users
       WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

CREATE TABLE IF NOT EXISTS operator_policy_acceptances (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID         NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  operator_id     UUID         NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  version         INT          NOT NULL,
  accepted_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  ip_address      TEXT,
  user_agent      TEXT,

  FOREIGN KEY (operator_id, version)
    REFERENCES operator_policies (operator_id, version)
);

CREATE INDEX IF NOT EXISTS operator_policy_acceptances_lookup_idx
  ON operator_policy_acceptances (user_id, operator_id, accepted_at DESC);

ALTER TABLE operator_policy_acceptances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "operator_policy_acceptances: bidder reads own" ON operator_policy_acceptances;
CREATE POLICY "operator_policy_acceptances: bidder reads own"
  ON operator_policy_acceptances FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "operator_policy_acceptances: operator reads own" ON operator_policy_acceptances;
CREATE POLICY "operator_policy_acceptances: operator reads own"
  ON operator_policy_acceptances FOR SELECT
  USING (
    operator_id IN (
      SELECT operator_id FROM operator_users WHERE user_id = auth.uid()
    )
  );

CREATE OR REPLACE FUNCTION get_active_operator_policy(p_operator_id UUID)
RETURNS TABLE (
  operator_id UUID,
  version INT,
  terms_md TEXT,
  refund_md TEXT,
  shipping_md TEXT,
  payment_window_hours INT,
  pickup_window_days INT,
  shipping_offered BOOLEAN,
  refund_window_post_pickup_hours INT,
  effective_at TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $func$
  SELECT operator_id, version, terms_md, refund_md, shipping_md,
         payment_window_hours, pickup_window_days, shipping_offered,
         refund_window_post_pickup_hours, effective_at
    FROM operator_policies
   WHERE operator_id = p_operator_id
     AND published = TRUE
   ORDER BY effective_at DESC
   LIMIT 1;
$func$;

GRANT EXECUTE ON FUNCTION get_active_operator_policy(UUID) TO anon, authenticated;

CREATE OR REPLACE FUNCTION record_operator_consent(
  p_operator_id UUID,
  p_version INT
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $func$
DECLARE
  v_user_id UUID;
  v_ip      TEXT;
  v_ua      TEXT;
  v_id      UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'record_operator_consent: caller is not authenticated';
  END IF;

  BEGIN
    v_ip := current_setting('request.headers.x-forwarded-for', true);
  EXCEPTION WHEN OTHERS THEN v_ip := NULL; END;
  BEGIN
    v_ua := current_setting('request.headers.user-agent', true);
  EXCEPTION WHEN OTHERS THEN v_ua := NULL; END;

  INSERT INTO operator_policy_acceptances (user_id, operator_id, version, ip_address, user_agent)
  VALUES (v_user_id, p_operator_id, p_version, v_ip, v_ua)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$func$;

GRANT EXECUTE ON FUNCTION record_operator_consent(UUID, INT) TO authenticated;

-- Seed: every existing operator gets a default v1 published policy.
-- Bingo's intended posture: pay-at-win, 7-day pickup, no shipping,
-- all-sales-final-post-pickup.
INSERT INTO operator_policies
  (operator_id, version, terms_md, refund_md, shipping_md,
   payment_window_hours, pickup_window_days, shipping_offered,
   refund_window_post_pickup_hours, published, content_hash, created_at)
SELECT
  id, 1,
  '# Operator Terms

By placing a bid on an auction operated by ' || COALESCE(business_name, 'this operator') || ', you agree to these terms in addition to the [ClovrBid Terms of Service](/legal/terms) and [Bidder Agreement](/legal/bidder-agreement).

## Payment
Payment is due immediately on winning. Your saved payment method will be charged at auction close.

## Pickup window
You have 7 days from auction close to pick up your won items.

## Inspection
You may inspect items at the pickup counter before accepting them. Refunds for damaged or misdescribed items are issued at the pickup counter only.

## All sales final after pickup
Once items leave our warehouse with you, all sales are final. No returns, no refunds.

## Suspension for non-payment / no-show
Repeated payment failures or pickup no-shows may result in suspension from bidding with this operator.',
  '# Refund Policy

Refunds are issued at the pickup counter for items that materially differ from the listing description, or that are damaged in a way not disclosed in the listing.

To request a refund, decline the item at pickup and present it to the pickup attendant. We will issue a refund to your original payment method within 5 business days.

After items leave the warehouse, refunds are not available. No exceptions.',
  '# Shipping Policy

This operator does not currently offer shipping. All items are pickup-only at our warehouse during posted pickup hours.',
  0, 7, FALSE, 0, TRUE, 'seed-default-v1', now()
FROM operators
ON CONFLICT (operator_id, version) DO NOTHING;
