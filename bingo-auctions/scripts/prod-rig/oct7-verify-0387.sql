SELECT jsonb_build_object(
  'index_valid', (SELECT coalesce(bool_and(i.indisvalid AND i.indisready), false) FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'import_rows_external_code_idx'),
  'ledger', (SELECT count(*) FROM _schema_migrations WHERE filename = '0387_import_rows_external_code_idx.sql')) AS v
