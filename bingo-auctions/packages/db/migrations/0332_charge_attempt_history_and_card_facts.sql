-- 0332 — keep the history of every charge attempt, and record what kind of card
-- the bidder actually pays with.
--
-- Why (2026-08-25, Danny Smith / dsmithpb@gmail.com):
--   He reported he can't buy with his prepaid card. He was right — three lots
--   won, ten auto-charge attempts, zero Square payments, and staff took his
--   money at the counter every time. But the REASON was unrecoverable: the
--   only record of a decline is invoices.last_auto_charge_error, a single
--   column that the next attempt overwrites — and `mark-paid` stamps
--   'offline_paid_by_operator' over it, so rescuing a customer at the counter
--   erases the evidence of why their card failed.
--
--   And we can't tell a prepaid card from any other. Square exposes card_type
--   and prepaid_type, but ONLY on Payments API responses (not on CreateCard),
--   and we never read them. The best signal available was his expiry date —
--   02/2035, the only one past 2032 among 715 bidders.
--
-- Two changes:
--   A. charge_attempts — one immutable row per attempt, never overwritten.
--   B. bidders.card_type / prepaid_type — learned from payment responses.

-- ── A. charge attempt history ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.charge_attempts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id     uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  operator_id    uuid NOT NULL REFERENCES public.operators(id) ON DELETE CASCADE,
  bidder_id      uuid REFERENCES public.bidders(id) ON DELETE SET NULL,
  attempted_at   timestamptz NOT NULL DEFAULT now(),
  -- 'auto_charge' | 'manual_retry' | 'offline_mark_paid'
  source         text NOT NULL,
  -- 'succeeded' | 'declined' | 'error' | 'settled_offline'
  outcome        text NOT NULL,
  amount_cents   bigint,
  card_id        text,
  -- The issuer's verdict, kept verbatim. This is the field whose absence made
  -- Danny's case unanswerable.
  square_code    text,
  square_detail  text,
  square_status  text,
  square_payment_id text,
  -- Card facts as reported on THIS payment, so a card that changes behaviour
  -- over time is visible rather than flattened onto the bidder row.
  card_type      text,
  prepaid_type   text,
  attempt_number integer
);

CREATE INDEX IF NOT EXISTS charge_attempts_invoice_idx
  ON public.charge_attempts (invoice_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS charge_attempts_bidder_idx
  ON public.charge_attempts (bidder_id, attempted_at DESC);
-- Supports "show me every decline code this month" without a seq scan.
CREATE INDEX IF NOT EXISTS charge_attempts_operator_outcome_idx
  ON public.charge_attempts (operator_id, outcome, attempted_at DESC);

ALTER TABLE public.charge_attempts ENABLE ROW LEVEL SECURITY;

-- Staff read their own operator's attempts. No client INSERT/UPDATE/DELETE
-- policy: only the service role writes here, and nothing ever rewrites a row —
-- an append-only log is the whole point.
DROP POLICY IF EXISTS charge_attempts_staff_read ON public.charge_attempts;
CREATE POLICY charge_attempts_staff_read
  ON public.charge_attempts FOR SELECT TO authenticated
  USING (operator_id = (SELECT public.current_operator_id()));

COMMENT ON TABLE public.charge_attempts IS
  'Append-only history of every card-charge attempt. Exists because '
  'invoices.last_auto_charge_error is a single overwritten column: a retry, or '
  'an operator settling the invoice offline, destroyed the decline code and '
  'left customer payment failures undiagnosable (Danny Smith, 2026-08-25).';

-- ── B. what kind of card the bidder pays with ────────────────────────────────
ALTER TABLE public.bidders
  ADD COLUMN IF NOT EXISTS card_type text,
  ADD COLUMN IF NOT EXISTS prepaid_type text,
  ADD COLUMN IF NOT EXISTS card_facts_synced_at timestamptz;

COMMENT ON COLUMN public.bidders.prepaid_type IS
  'PREPAID | NOT_PREPAID | UNKNOWN, as reported by Square on a payment. NULL '
  'means we have never completed a charge on this card, so we do not know. '
  'Square omits this from CreateCard, so it can only be learned by charging.';
COMMENT ON COLUMN public.bidders.card_type IS
  'CREDIT | DEBIT | UNKNOWN, as reported by Square on a payment. NULL = unknown.';
