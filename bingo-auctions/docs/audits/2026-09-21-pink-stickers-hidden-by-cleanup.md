# Pink lot stickers hidden by cleanup — September 21, 2026

**Restored on the owner's explicit instruction:** [workflow 35639723276](https://github.com/jmacluer-design/bingo-auctions/actions/runs/35639723276) rehearsed the exact captured-ID reversal inside a rolled-back transaction, then committed it at **13:38:59 Central**. An independent post-commit SELECT at **13:39:00** confirmed **347 existing lots, 347 with deleted_at NULL, zero still deleted, 342 sticker bindings**. Only `deleted_at` was explicitly updated; ordinary database update triggers remained active. No titles, statuses or sticker bindings were explicitly changed. The findings below describe the pre-restoration incident.

## Finding and staff impact

**All five reported pink stickers correspond to saved lots that migration 0366 soft-deleted this morning.** They are not missing inserts or unclaimed numbers: the lots still exist, their `BIN:PNK...` sticker bindings are present, and each lot ID is in `public._catalog_misfire_20260921`. Normal scan/lookup paths exclude `deleted_at IS NOT NULL`, explaining why staff cannot resolve the codes.

The user reports the boxes were stickered and physically shelved. The database proves creation, binding and deletion; it does not yet corroborate put-away for these five. All five remain `pending_intake` with no intake-bin reference. Product metadata correctness is a separate question; saved/bound does not establish that a catalog result was correct.

Read-only production evidence: [workflow 35639138285](https://github.com/jmacluer-design/bingo-auctions/actions/runs/35639138285), captured **13:33:41 Central**. Target `npwseclcxcatjhgjrtwe`, BinGo operator `05775af4-adb7-4f0f-943e-94a91e17f60d`. No row or setting was changed.

## Exact records — all times September 21 Central

- **PNK4822591 → BIN-025237**; created **10:16:57**; lot ID `8ca69a23-2828-4e36-b5af-be27b88622c1`.
- **PNK4822592 → BIN-025239**; created **10:17:55**; lot ID `6dcbdfd6-27c2-4dc5-b9ab-6e59d53d2603`.
- **PNK4822593 → BIN-025275**; created **10:20:49**; lot ID `05409abf-94ea-40f2-9623-335927be8970`.
- **PNK4822594 → BIN-025277**; created **10:21:42**; lot ID `9322a4ae-84ad-4d62-9b16-560f3d5dce27`.
- **PNK4822595 → BIN-025294**; created **10:23:21**; lot ID `1b1a6bee-095e-4567-886a-f012123470b5`.

For every record: `status=pending_intake`, pre-cleanup status also `pending_intake`, no auction, no manifest row; **deleted_at and cleanup captured_at = 10:34:11.550152 Central**. The PNK codes are stored as sticker codes; their canonical lot codes are the BIN numbers above.

## Why the cleanup caught them

`0366_softdelete_catalog_misfire_20260921.sql:34` selects BinGo lots created during September 21 with no manifest link, no auction/bids/winner, not scheduled/live, and not already deleted. It does **not** check how the lot was created, whether its sticker was bound/printed, or whether it had been put away. It then sets `deleted_at` on the captured IDs (`:58`).

Thus the migration's “no bidder/money exposure” checks did not protect staff's physical inventory. Its broad assumption that all unlinked lots from the day should disappear is what affected these saved sticker-bound records. The soft delete preserves their rows and bindings; it hides them from normal lookup.

Live wider-scope count: **347 captured, 347 still deleted; 342 have a sticker code, 10 have an intake-bin reference, zero have a pool claim.** This is a potential inventory-reconciliation scope, not proof that 342 boxes are shelved or all 347 have correct product metadata.

## Sticker pool and save/print ordering

No `lot_sticker_pool` row matched these five codes, their claimed lot IDs, or their saved QR tokens. That is not “claimed but missing lot.” Their bindings are in `lots.sticker_code`.

The preprinted-pool machinery creates UUID labels (`0141_lots_sticker_code.sql:303`); canonical generated codes use the operator prefix and sequence. The inspected application does not generate PNK numbers in either lane. PNK stock can be bound as an existing physical label without a pool row: `claim_sticker_code` checks the saved lot, optionally updates a matching pool entry, then writes the sticker binding in one function (`0308_reject_carrier_barcode_stickers.sql:165–228`). An UPDATE matching zero pool entries does not reject the binding.

Current source ordering:

- QuickLot awaits successful lot creation before success/history and then performs the separate sticker bind (`apps/field-mobile/app/(staff)/lotting/quick.tsx:890–1038`). Binding failure can leave a saved BIN lot without its scanned PNK binding, but that is **not these five**, whose bindings are present.
- Photo lotting likewise awaits saved creation before the success/sticker interface (`photo.tsx:911–1031`).
- The legacy web lotting flow reserves a canonical lot code before insertion (`web.tsx:456–494`), so a failed insertion can consume a sequence number. Its success/sticker interface follows the insert. That possibility does not explain these existing bound rows and does not generate these PNK identifiers.
- No inspected path establishes PNK printing before a failed lot write. Physical preprinted stock can exist independently of the database.

Web `findLotsByAnyCode` filters `deleted_at IS NULL` (`apps/operator-web/src/lib/lot-lineage.ts:68–73`). SQL scan resolution also excludes deleted lots (`0316_scan_resolves_to_current_lineage_member.sql:116,180`); the native label screen does likewise (`apps/field-mobile/app/(staff)/worklist/[id]/label.tsx:44–57`). No speculative print failure is needed to explain this incident.

## Read-only conclusion and next decision

Do not recreate these lots to work around failed scans: their original identities and sticker bindings exist. A repair decision should reconcile each physical box/product with its saved row and restore the intended original records, preserving codes; any restoration is a separate authorized production write. A blanket reversal could restore incorrect catalog metadata and is not approved here. Do not rerun 0366 as a diagnostic.

Pass 1: exact-code production lookup and cleanup-set membership. Pass 2: source trace of capture predicate, save/bind sequencing and deleted-row filters. Pass 3: independent review of returned JSON, time-zone conversion and impact qualifications. Investigation preflight was SELECT-only; the subsequent reversal above was separately and explicitly authorized, reviewed, rehearsed and verified. No notifications were sent.

Put-away follow-up: [workflow 35639351084](https://github.com/jmacluer-design/bingo-auctions/actions/runs/35639351084), 13:35:42 Central, found no intake timestamp or bin assignment for the five PNK examples. Their source labels were `Wayfair-D2L`, another reason not to equate every unlinked row with the Amazon-manifest failure. Across the captured set, ten were `in_inventory` with intake bins/timestamps (nine also sticker-bound); 336 were `pending_intake` (333 sticker-bound); one was canceled. No pickup bin-assignment rows matched the set. Physical shelving of the five remains staff-reported; the broader ten have database intake evidence.

What failed was the question set: absence of auction/payment activity was treated as enough to remove a lot. The migration performed its written selection/deletion; the physical consequence was omitted from that selection and review. Tests of the original specification alone would not supply that missing business requirement.

## Restored inventory and product-quality review

[Complete 347-row review file](2026-09-21-restored-lot-review.json), from [workflow 35640029085](https://github.com/jmacluer-design/bingo-auctions/actions/runs/35640029085), records every lot code, sticker, title, source, product identifier and physical-evidence flag. All 347 remained restored in this later read.

**342 have stickers.** The only five without `sticker_code` are:

- `BIN-024953` — Vouken 2PCS Plastic Divider (8 Compartment).
- `BIN-025076` — BossKiss i16 Pro Max Screen Protector; **in inventory at bin 3-02-01**, with intake history. This row demonstrates why sticker-only exclusion is incomplete.
- `BIN-025094` — Assar White Area Rug; canceled.
- `BIN-025161` — MITINU Unicorn Design Gift Bags, 60-Piece Set.
- `BIN-025276` — Shillington Hand-Tufted Wool Floral Area Rug.

343 of 347 have a direct recorded footprint through sticker/intake/location evidence; the remaining four have **no such evidence in this read**, not proof of no physical box. The saved source labels span multiple sources, including 14 Wayfair-D2L rows, six August WayFair rows, two Salina Relot rows and other source labels; these are free text, not authoritative provenance.

**Do not label the whole batch hallucinated.** The known incident identifier `X004Z9D5K5` matches `BIN-025138` / sticker `PPE3846075`, whose current title is **“Piuaeue Small Personal Portable Mini Handheld Fans (3-Pack, Classical)”**, not the wrong New Balance shoe title described in 0366's header. That historic bad lookup is not proof that its saved title is still wrong. No current title has been independently confirmed false by this review yet.

Missing `import_row_id`, AI-call linkage, or catalog-cache agreement cannot supply that proof. AI-call association is time-window-based; candidate persistence can mark a cached candidate `manual/high` even after AI generation. Exact manifest identifier/title matches can guide a review but still need unit/physical confirmation. Correct product metadata on the original restored lot; do not delete it to remove uncertainty.

A broader manifest-identifier comparison ([35640561301](https://github.com/jmacluer-design/bingo-auctions/actions/runs/35640561301)) did not return promptly and was canceled. Its results are not part of the evidence or classification. A narrowly scoped cancellation check was issued only for that diagnostic query, not staff queries. The 347-row restored inventory is complete; the product-identity verification is explicitly incomplete.
