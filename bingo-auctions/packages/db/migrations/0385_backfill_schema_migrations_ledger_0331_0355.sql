-- 0385 — ledger backfill: record 0331–0355 in _schema_migrations.
--
-- These 25 files were applied to prod by hand between 2026-08-25 and
-- 2026-09-14 (direct SQL sessions, each dry-run first; see the PR bodies of
-- #280, #282, #294, #297, #304–#310). Only scripts/apply-migrations.js writes
-- _schema_migrations, and it was bypassed for three weeks, so the ledger jumps
-- from 0330 to 0356. Every change is present in prod: verified object by object
-- on 2026-09-30, docs/state/MIGRATION-GAP-2026-09-30.md §1.
--
-- applied_at: 0331 is the moment its step 1 flipped invoice a5c6981d back to
-- refunded (invoice_status_history, 2026-08-25 17:36:45 UTC). The others carry
-- the commit time of the PR that introduced them — an upper bound, since each
-- PR body says the file was already applied. duration_ms is 0 (unknown).
-- checksum: sha256 of the file on master at 0c69344, first 16 hex chars, the
-- same formula the applier uses.
--
-- Idempotent: ON CONFLICT DO NOTHING, so a real ledger row is never overwritten.
-- Data only; touches no application table.

INSERT INTO _schema_migrations (filename, applied_at, applied_by, duration_ms, checksum) VALUES
  ('0331_repair_refunds_clobbered_by_the_payment_webhook.sql', '2026-08-25 17:36:45+00', 'backfill:0385', 0, '70f59863d241fa55'),
  ('0332_charge_attempt_history_and_card_facts.sql', '2026-08-26 19:56:34+00', 'backfill:0385', 0, 'eb77800c465a61c5'),
  ('0333_seed_charge_attempts_from_surviving_codes.sql', '2026-08-26 19:56:34+00', 'backfill:0385', 0, '1313a4e3b9adb883'),
  ('0334_bin_contents_one_row_per_box.sql', '2026-08-26 19:56:34+00', 'backfill:0385', 0, '61bf1a9edb3932d6'),
  ('0335_shelved_drafts_are_sellable_inventory.sql', '2026-08-26 19:56:34+00', 'backfill:0385', 0, '18c5b4e7e7797d30'),
  ('0336_resolved_missing_items_are_refunded.sql', '2026-08-27 21:05:01+00', 'backfill:0385', 0, '16a0447365f4be18'),
  ('0337_checked_in_pickups_can_go_stale.sql', '2026-08-28 02:15:27+00', 'backfill:0385', 0, 'de72750ebfb4f65b'),
  ('0338_who_lotted_this_box.sql', '2026-08-28 15:14:37+00', 'backfill:0385', 0, '30fabb263515756f'),
  ('0339_meta_conversions_outbox.sql', '2026-08-29 19:53:44+00', 'backfill:0385', 0, '8fda48e209e0117b'),
  ('0340_ad_tracking_opt_out.sql', '2026-08-29 20:19:21+00', 'backfill:0385', 0, '521f355413d906fe'),
  ('0341_meta_click_attribution.sql', '2026-08-30 01:57:28+00', 'backfill:0385', 0, 'cb1397e22a446472'),
  ('0342_card_never_bid_segment.sql', '2026-08-30 04:22:39+00', 'backfill:0385', 0, '597b676a883c1bee'),
  ('0343_category_demand_tiers.sql', '2026-08-30 18:11:01+00', 'backfill:0385', 0, '567f8b0046418315'),
  ('0344_disposed_lots_do_not_pin_auctions_open.sql', '2026-09-02 15:28:30+00', 'backfill:0385', 0, '20fbeacafe2e4eb8'),
  ('0345_missing_items_cannot_be_relisted_until_found.sql', '2026-09-02 15:28:30+00', 'backfill:0385', 0, '129cf092eb7f4277'),
  ('0346_worker_productivity_counts_in_the_database.sql', '2026-09-03 16:40:12+00', 'backfill:0385', 0, '1cf8b58d332900c4'),
  ('0347_daily_lotting_report.sql', '2026-09-03 16:59:38+00', 'backfill:0385', 0, 'bfdbba67e7750c24'),
  ('0348_productivity_counts_lotting_not_relisting.sql', '2026-09-08 23:09:09+00', 'backfill:0385', 0, '12740986f323a696'),
  ('0349_mark_human_vs_system_relists.sql', '2026-09-08 23:09:09+00', 'backfill:0385', 0, 'a5597b785c7e2675'),
  ('0350_self_raise_can_only_raise.sql', '2026-09-08 23:09:09+00', 'backfill:0385', 0, '712a759f1bf80d12'),
  ('0351_no_show_sweep_must_not_reclaim_collected_lots.sql', '2026-09-10 14:16:10+00', 'backfill:0385', 0, '1a0f95985baec5c4'),
  ('0352_missing_removal_kind.sql', '2026-09-10 14:16:10+00', 'backfill:0385', 0, 'eec61993f45d23c7'),
  ('0353_relot_never_auto_schedules.sql', '2026-09-10 21:42:19+00', 'backfill:0385', 0, 'b0c224b40281f89a'),
  ('0354_putaway_records_finding_an_item.sql', '2026-09-11 17:03:42+00', 'backfill:0385', 0, '8f2954cbfa5d5be9'),
  ('0355_block_relist_of_collected_item.sql', '2026-09-14 16:34:39+00', 'backfill:0385', 0, '84e1ef8953b70458')
ON CONFLICT (filename) DO NOTHING;
