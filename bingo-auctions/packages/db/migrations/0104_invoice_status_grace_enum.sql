-- ============================================================================
-- Migration 0104 — Add two grace/relisted values to invoice_status enum.
--
-- Why this is its own (tiny) migration:
--   Postgres allows ALTER TYPE ADD VALUE inside a transaction, but the new
--   value cannot be referenced (e.g. in a partial-index WHERE clause) in
--   the SAME transaction it was added. The migration runner wraps each
--   .sql file in its own transaction, so we have to add the enum values in
--   ONE file and use them (in indexes, triggers, etc.) in a SUBSEQUENT
--   file. Migration 0105 picks up from here.
--
-- Values added:
--   payment_failed_grace      — off-session charge declined; bidder has 48h
--                                to update card and retry.
--   payment_failed_relisted   — 48h grace expired; lot was auto-relisted
--                                and the $5 relot fee was applied.
--
-- See 0105 for the columns + table + RPC + trigger that drive the flow.
-- ============================================================================

ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'payment_failed_grace';
ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'payment_failed_relisted';
