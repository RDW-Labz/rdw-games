SELECT jsonb_build_object(
  'closing_next_hour', (SELECT count(*) FROM lots WHERE status = 'live' AND close_at < now() + interval '1 hour'),
  'ledger_0382', (SELECT count(*) FROM _schema_migrations WHERE filename = '0382_unstrand_closed_auction_drafts.sql'),
  'ledger_0387', (SELECT count(*) FROM _schema_migrations WHERE filename = '0387_import_rows_external_code_idx.sql')) AS v
