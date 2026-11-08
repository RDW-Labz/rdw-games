-- migration 0251 — normalize newline-joined tracking numbers to spaces
--
-- The ClovrBid→BinGo manifest copy (2026-07-09, copy-manifests.mjs) surfaced
-- 36 pending import_rows whose tracking_number holds two values joined by a
-- newline (e.g. '486575027266\nR0437102' — FedEx tracking + retailer return
-- id from the source spreadsheet). find_import_row_by_scan's token-match
-- (0156/0160) only splits on spaces and commas, so scanning either half of a
-- newline-joined value misses. Normalizing the separator to a space makes the
-- existing matcher cover them — no function change needed.
--
-- Scope: pending rows only (lotted/dropped are history). Collapses any
-- whitespace runs introduced by the replace. Idempotent.

BEGIN;

UPDATE import_rows
SET tracking_number = regexp_replace(
      replace(replace(tracking_number, E'\r', ' '), E'\n', ' '),
      '\s+', ' ', 'g'
    ),
    updated_at = now()
WHERE status = 'pending'
  AND tracking_number ~ E'[\r\n]';

COMMIT;
