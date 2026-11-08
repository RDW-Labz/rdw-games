# 0382 / 0387 rig proof (2026-10-06)

Fresh copy of `rigbase` per run. `seed.sql` puts the 216 listed ids into a closed
auction: 206 shelved drafts, 9 unshelved drafts, 1 disposed (the GRA4141466 case).
Each file is sent as one query string (`psql -c "$(cat file)"`), the way the
Management API runs a migration.

| Run | Result |
|---|---|
| 0382, 1st | UPDATE 215: 206 `in_inventory` (intake_at set), 9 `pending_intake`; auction/lot_number/close_at cleared; disposed lot untouched |
| 0382, 2nd | NOTICE already applied, UPDATE 0 |
| one shelved draft moved first | ERROR captured 205 + 9, expected 206 + 9; whole file rolled back |
| empty database | NOTICE nothing to fix, UPDATE 0 |
| 0382_ROLLBACK (/tmp, Braden adds it) | UPDATE 215, back to the seeded state exactly |
| 0387 on a 321,228-row, 627 MB import_rows | 0.86 s; rerun is a NOTICE; 0387_ROLLBACK drops it |
