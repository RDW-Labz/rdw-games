-- 0327 — let customers file feedback from the website, signed in or not.
--
-- Owner ask 2026-08-19: "add a customer feedback as well."
--
-- 0317 gave both APPS a form. Bidders who never install one — and anyone who
-- hits a problem on the way to signing up, which is exactly the feedback worth
-- the most — still have only support@bingoauctions.com, an inbox nobody
-- triages against a list.
--
-- ── WHY author_id HAS TO BECOME NULLABLE ─────────────────────────────────────
-- 0317 keyed a row to auth.users because both apps require sign-in before the
-- form is reachable. The web does not: a customer whose signup failed has no
-- account BY DEFINITION, and refusing their report is refusing the report we
-- most need. So author_id is optional, and contact_email carries the reply
-- path when they choose to leave one.
--
-- ── THE ANONYMOUS WRITE PATH ─────────────────────────────────────────────────
-- No RLS policy is added for anon. The public form posts to /api/feedback,
-- which validates and inserts with the service-role client. That keeps the
-- table's own policies as strict as 0317 left them and puts the spam controls
-- somewhere they can be reasoned about — length caps, a honeypot, and the
-- throttle below — rather than trying to express them in a policy.
--
-- ip_hash is sha256(ip + a server-side salt), never the address. It exists for
-- exactly one purpose: refusing the sixth submission in an hour from one
-- source. It cannot be reversed into a visitor and is not shown in the console.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Anonymous authorship
-- ---------------------------------------------------------------------------
ALTER TABLE public.app_feedback
  ALTER COLUMN author_id DROP NOT NULL;

COMMENT ON COLUMN public.app_feedback.author_id IS
  '0327: nullable. NULL means the report came from the public website from '
  'someone who was not signed in — including people whose signup failed, whose '
  'reports are the ones we can least afford to refuse. Reply via contact_email.';

-- 'web' joins 'bidder' and 'staff'. Kept as a third value rather than folding
-- into 'bidder' because the triager's first question is which surface broke,
-- and a web report has no build number to answer it with.
ALTER TABLE public.app_feedback
  DROP CONSTRAINT IF EXISTS app_feedback_app_check;
ALTER TABLE public.app_feedback
  ADD CONSTRAINT app_feedback_app_check CHECK (app IN ('bidder', 'staff', 'web'));

-- ---------------------------------------------------------------------------
-- 2. Reply path + throttle key
-- ---------------------------------------------------------------------------
ALTER TABLE public.app_feedback
  ADD COLUMN IF NOT EXISTS contact_email text
    CHECK (contact_email IS NULL OR length(contact_email) BETWEEN 3 AND 254);

COMMENT ON COLUMN public.app_feedback.contact_email IS
  '0327: optional. How to reach a web reporter who has no account. Optional on '
  'purpose — demanding an address to report a broken page loses the report.';

ALTER TABLE public.app_feedback
  ADD COLUMN IF NOT EXISTS ip_hash text;

COMMENT ON COLUMN public.app_feedback.ip_hash IS
  '0327: sha256(ip + FEEDBACK_IP_SALT). Rate limiting only — never displayed, '
  'never joined to a person. Null for app submissions, which are authenticated.';

-- The throttle reads (ip_hash, created_at) on every public submit; without this
-- it is a sequential scan of the whole table on a spam burst, which is when it
-- can least afford one.
CREATE INDEX IF NOT EXISTS app_feedback_ip_hash_recent_idx
  ON public.app_feedback (ip_hash, created_at DESC)
  WHERE ip_hash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Keep the author-scoped policies honest with a nullable column
-- ---------------------------------------------------------------------------
-- `author_id = auth.uid()` is NULL for an anonymous row, so it never satisfies
-- USING/WITH CHECK — anon rows are already invisible to non-staff and
-- uninsertable by clients. Restated explicitly so a future reader does not have
-- to derive three-valued logic to convince themselves.
DROP POLICY IF EXISTS app_feedback_self_read ON public.app_feedback;
CREATE POLICY app_feedback_self_read
  ON public.app_feedback FOR SELECT TO authenticated
  USING (author_id IS NOT NULL AND author_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS app_feedback_self_insert ON public.app_feedback;
CREATE POLICY app_feedback_self_insert
  ON public.app_feedback FOR INSERT TO authenticated
  WITH CHECK (author_id IS NOT NULL AND author_id = (SELECT auth.uid()));

COMMIT;
