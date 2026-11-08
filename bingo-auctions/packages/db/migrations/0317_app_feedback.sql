-- 0317 — app_feedback: in-app bug reports and suggestions from both apps
--
-- Owner ask 2026-08-13: "Could we make a submit bug or recommendation for my
-- testers somewhere and bidders on their profile."
--
-- Today there is no in-app channel for either audience. Staff TestFlight
-- testers report by text message and bidders have only /dispute/new, which is
-- the wrong shape — a dispute is money-bearing (it attaches to an invoice and
-- a lot, and resolves into a refund decision). "The scan screen freezes when I
-- rotate the phone" has nowhere to go, so it arrives as a screenshot in a
-- thread and is lost.
--
-- WHY A NEW TABLE RATHER THAN REUSING disputes. Different lifecycle, different
-- required context, different reader. A dispute is per-invoice and per-lot,
-- both NOT NULL, and its statuses ('open' → refunded/denied) are about money.
-- Feedback has no lot, no invoice, no money, and its statuses are about
-- engineering triage. Overloading disputes would put non-money rows in the
-- table the settlement and SLA-countdown code reads.
--
-- THE DIAGNOSTIC COLUMNS ARE THE POINT. The version-guard incidents (#248,
-- #249) cost a tester eight days on a stale build precisely because nobody
-- could tell which bundle a device was running. A bug report that doesn't say
-- app_version + update_id is a bug report we can't act on, so the client fills
-- those in automatically rather than asking the human to know them. `screen`
-- is likewise captured, not typed.
--
-- ACCESS MODEL. Follows 0223 (signup_failures): platform telemetry is readable
-- by operator staff. Authors additionally read their own rows so the app can
-- show "you reported this" state later. Writes are author-scoped inserts —
-- there is no author UPDATE policy, so a submission is immutable once filed
-- and the triage columns can only move under staff (admin/manager) or service
-- role. Anonymous clients get nothing: every policy is TO authenticated.
--
-- Idempotent: IF NOT EXISTS everywhere; policies recreated via DROP+CREATE.

BEGIN;

CREATE TABLE IF NOT EXISTS public.app_feedback (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),

  -- auth.users, not bidders — staff submissions come from operator_users, who
  -- have no bidders row. ON DELETE CASCADE so an account deletion (Apple
  -- 5.1.1(v), apps/bidder-app/app/profile/delete-account.tsx) takes the
  -- person's feedback with it rather than leaving orphaned rows.
  author_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Which binary this came from. Drives who triages it and which app.config.ts
  -- the version below should be read against.
  app         text NOT NULL CHECK (app IN ('bidder', 'staff')),

  -- 'bug' = something is broken, 'idea' = a recommendation. Deliberately two
  -- buckets and not a free-form category: a tester picking between two chips
  -- is a decision they can make in half a second, and anything finer is triage
  -- work the reader should do, not the reporter.
  kind        text NOT NULL CHECK (kind IN ('bug', 'idea')),

  -- 10-char floor mirrors the dispute form's reason field. Enforced here as
  -- well as client-side so a rebuilt/older binary can't insert an empty row.
  message     text NOT NULL CHECK (length(btrim(message)) >= 10),

  -- Who actually filed it, when author_id can't say. The staff app signs in
  -- once per device as a shared station account (operator_users) and then
  -- identifies the human by PIN (WorkerContext, 2026-07-21) — so author_id on
  -- a staff row names the iPhone, not the tester. The clocked-in worker's
  -- display name goes here. NULL on bidder rows, where author_id IS the person.
  reporter_label text,

  -- ── captured by the client, never typed by the human ──────────────────────
  screen      text,   -- route the reporter was on when they opened the form
  app_version text,   -- Constants.expoConfig.version
  update_id   text,   -- expo-updates updateId, or 'embedded' for a raw build
  platform    text,   -- 'ios' | 'android'
  os_version  text,
  device_model text,

  -- ── triage ────────────────────────────────────────────────────────────────
  status      text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'triaged', 'planned', 'fixed', 'wont_fix')),
  triage_note text,
  resolved_at timestamptz,

  -- Set for staff submissions (the submitter's operator); NULL for bidders,
  -- who are platform-wide identities and not scoped to one operator.
  operator_id uuid REFERENCES public.operators(id) ON DELETE SET NULL
);

-- The console lists newest-first and filters by status; the author-scoped
-- lookup powers "my reports" in the apps.
CREATE INDEX IF NOT EXISTS app_feedback_created_at_idx
  ON public.app_feedback (created_at DESC);

CREATE INDEX IF NOT EXISTS app_feedback_status_created_at_idx
  ON public.app_feedback (status, created_at DESC);

CREATE INDEX IF NOT EXISTS app_feedback_author_created_at_idx
  ON public.app_feedback (author_id, created_at DESC);

ALTER TABLE public.app_feedback ENABLE ROW LEVEL SECURITY;

-- ── policies ─────────────────────────────────────────────────────────────────
-- auth.uid() wrapped in a scalar subquery per 0133: the planner then evaluates
-- it once per statement instead of once per row.

DROP POLICY IF EXISTS app_feedback_self_insert ON public.app_feedback;
CREATE POLICY app_feedback_self_insert
  ON public.app_feedback
  FOR INSERT
  TO authenticated
  WITH CHECK (author_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS app_feedback_self_read ON public.app_feedback;
CREATE POLICY app_feedback_self_read
  ON public.app_feedback
  FOR SELECT
  TO authenticated
  USING (author_id = (SELECT auth.uid()));

-- Any operator staff can read every submission — same posture as
-- signup_failures (0223). Feedback is about the apps, not about one operator's
-- inventory, so there is no per-tenant slice to enforce here.
DROP POLICY IF EXISTS app_feedback_staff_read ON public.app_feedback;
CREATE POLICY app_feedback_staff_read
  ON public.app_feedback
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.operator_users ou
      WHERE ou.user_id = (SELECT auth.uid())
    )
  );

-- Triage is admin/manager only, matching disputes_staff_update (0133).
DROP POLICY IF EXISTS app_feedback_staff_update ON public.app_feedback;
CREATE POLICY app_feedback_staff_update
  ON public.app_feedback
  FOR UPDATE
  TO authenticated
  USING ((SELECT current_operator_role()) IN ('admin', 'manager'))
  WITH CHECK ((SELECT current_operator_role()) IN ('admin', 'manager'));

GRANT SELECT, INSERT ON public.app_feedback TO authenticated;
GRANT UPDATE ON public.app_feedback TO authenticated;

COMMENT ON TABLE public.app_feedback IS
  'In-app bug reports and suggestions from the bidder and staff apps. '
  'Client fills app_version/update_id/platform/screen automatically so a '
  'report always identifies the exact bundle it came from.';

COMMIT;
