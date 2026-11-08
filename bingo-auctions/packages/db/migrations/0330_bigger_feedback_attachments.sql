-- 0330 — raise the feedback attachment ceiling to fit a real recording.
--
-- Reported 2026-08-20: "I tried to attach this in the suggestion spot, but it
-- was too long." Tammy had filmed the crash — the single most useful artifact
-- anyone has produced about it — and the form refused it.
--
-- Two limits were in the way and both moved:
--   the picker's videoMaxDuration, 60s → 180s (app/(staff)/feedback.tsx)
--   this bucket's file_size_limit, 50 MB → 200 MB
--
-- 200 MB is sized off the artifact, not off a round number: iPhone/iPad screen
-- recording runs roughly 40–60 MB per minute at native resolution, so three
-- minutes lands near 180 MB. A cap that rejects the recording at 2:50 would
-- repeat the same failure, one step later.
--
-- The cost is bounded and one-directional: only staff and bidders can write
-- here, one report carries at most three attachments (UI) or six (0325's
-- CHECK), and these are diagnostic artifacts that exist to be watched once and
-- then age out. Against that, the alternative is what we had for six weeks —
-- prose about a UI nobody watching could see.

BEGIN;

UPDATE storage.buckets
   SET file_size_limit = 209715200
 WHERE id = 'feedback-attachments';

COMMIT;
