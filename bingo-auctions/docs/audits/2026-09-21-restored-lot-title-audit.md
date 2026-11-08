# Restored-lot title audit — September 21, 2026

Status: **347 rows reviewed; two title corrections applied and verified in the production database.** The coordinator executed the corrections separately; this report author performed no production writes. Rendered titles on browser and mobile apps remain unverified. The [complete row ledger](2026-09-21-restored-lot-title-audit-rows.json) contains every old title, sticker code, final classification, evidence, source provenance and intended action.

## Result and accepted corrections

Final classifications are **229 supported, 99 partially supported, 18 uncertain and one confirmed mismatch**. These describe the strength of the available title evidence. They do not certify sealed contents, condition, completeness, authenticity or a separately photographed physical unit for each row.

Only these two corrections are accepted:

- **BIN-025206 / BIN:RUG159562:** `Caely Portobello Hand Made Rug` → `Calix by Nikki Chu CNU04 Powerloomed Rug`. The actual rug's sewn label identifies Calix by Nikki Chu and CNU04, and its powerloomed construction contradicts “Hand Made.” The accepted title deliberately omits the worker-transcribed design word “ZIAZAN” and adds no unverified size or color. The attached stock rug image differs from the physical rug and needs a separate image-selection review; this title correction does not change photos.
- **BIN-025221 / BIN:PNK4999298:** `Unbranded Faux Fur Item - Brown - Model RB8856` → `Unbranded Faux Fur Item - Brown - Model RBB856`. Both physical photos show the label `RBB856 / Brown`. Only the model transcription changes. The bagged item's precise type and material remain unverified, so the row remains partially supported.

All other **345 titles remain unchanged**, including uncertain and partially supported titles. Failure to prove a claim is not proof that it is false and does not authorize removing it.

## Evidence acquired and its limits

The restored capture set contains 347 lots for the verified BinGo operator. Their saved records contain 847 photo URLs. The download policy excluded 36 external URLs across 33 lots; all 811 allowed original-photo downloads succeeded. Those 811 files are the reviewed local inputs, not 811 independently verified physical photographs. Stock images, rehosted catalog images, screenshots and actual warehouse photos occur in the same collection. An upload folder, image position or plausible stock-photo match does not establish physical identity.

Workers were instructed to visually inspect every supplied local photo, identify actual warehouse product/packaging evidence and use readable identifiers. Their completed outputs cover all 347 unique IDs exactly once. No supported row has an empty physical-photo list, but that structural check alone cannot verify an image's provenance or the accuracy of its transcription. The coordinator and independent reviewer therefore challenged proposed corrections and overconfident classifications instead of treating completed jobs as factual certification.

Physical packaging can establish a labeled product identity while its contents remain sealed. Reused photographs establish neither unique-unit possession nor duplicate inventory. In particular, both photo pairs for **PNK4822592 / BIN-025239** and **PNK4822593 / BIN-025275** are byte-identical; the physical pallet photo is too blurry to read identifiers. No merge, deletion or identity reassignment follows from that reuse.

The ledger contains local file references and sanitized product observations. It contains no raw photo URLs or shipping-recipient names, addresses or phone numbers. Raw photographs remain local evidence and may contain labels that must not be republished without separate review.

## Manifest provenance is separate from physical identity

Thirteen restored lots have direct reverse links through `import_rows.lot_id`; their saved titles exactly agree with both the normalized manifest title and original source product name. All 13 still have a null forward `lots.import_row_id`. Therefore a missing forward link is **not evidence of an invented title or absent manifest provenance**. The other 334 rows without a discovered direct reverse link remain unproven by this source, not incorrect.

The recorded exact operator-scoped lookups found zero normalized FNSKU matches for 77 distinct keys carried by 129 lots, zero ASIN matches for eight keys, and three UPC rows for one of 13 exact numeric keys. A UPC match is not a unique-unit link. Exact lookup misses do not rule out every historical import, spelling or field mapping. These reads did not establish physical correctness. Existing workflow restrictions prevented plain EXPLAIN; the coordinator authorized bounded indexed reads instead, and the audit does not claim an in-query timeout setting proved enforcement for an already-running statement.

The per-row ledger retains direct source IDs, source filename, original product name and exact title-agreement result where present. Null values mean no direct evidence was found by these reads. Product-catalog confidence and manual-source labels are not independent corroboration when the save path can write AI-origin text back into that catalog.

## Five questioned PNK labels

All five remain **uncertain, with no title edits**:

- **PNK4822591 / BIN-025237:** a carton says “STORAGE CABINET” and depicts a narrow drawer/shelf component. It does not establish the full U-shaped console, complete set or title's features; one component carton does not prove a different item.
- **PNK4822592 / BIN-025239:** blurry pallet cartons have no readable identifiers. The bed-base stock render cannot verify the physical product.
- **PNK4822593 / BIN-025275:** the same stock and blurry physical images are reused. No separate unit identity is established.
- **PNK4822594 / BIN-025277:** a sealed plain carton has no readable product identification. Stock table imagery is insufficient.
- **PNK4822595 / BIN-025294:** visible carton codes do not establish the product type, piece count or material. The patio-set stock image cannot fill that gap.

Four of these five—2591, 2592, 2594 and 2595—have exact reverse-manifest title agreement; 2593 does not. That difference changes recorded provenance, not the unresolved physical verdict. Clear product/model labels and, where relevant, all component cartons are needed for a stronger conclusion.

The five lots without a current sticker are not automatically hallucinations: **BIN-024953** is supported (divider), **BIN-025076** is partial (screen protector), **BIN-025094** is uncertain (rug, with direct manifest title agreement), **BIN-025161** is supported (gift bags), and **BIN-025276** is partial (rug, with direct manifest title agreement). All five titles are preserved.

## Independent adjudication

The raw worker distribution was 244 supported, 84 partial, 17 uncertain and two confirmed mismatches. Eighteen adjudications produce the final distribution:

- Fifteen supported rows become partial because their own evidence admits meaningful claims are unreadable or unresolved: BIN-024910, BIN-024911, BIN-024918, BIN-024929, BIN-024930, BIN-024931, BIN-024955, BIN-025102, BIN-025105, BIN-025119, BIN-025130, BIN-025190, BIN-025191, BIN-025196 and BIN-025201. The ledger records the exact missing claim and rationale for each.
- BIN-024905 stays partial, but its proposed shortened title is rejected. A box labeled Rovista Cellulite Massager Roller does not contradict the original descriptive usage or color claims merely because it does not print them.
- BIN-025232 changes from confirmed mismatch to partial, and its replacement title is rejected. The physical memory-foam lumbar-pillow package matches the saved ASIN. “Hip” versus “lumbar” marketing wording and “dark blue” versus “blue” do not prove a different product. Other features remain unverified; the original title is preserved. The coordinator's second-photo review resolved the brand as MOONYOOY; this does not establish a wrong product or justify a replacement title.
- BIN-025237 changes from partial to uncertain, following the independent native review of the incomplete furniture-carton evidence.

The native reviewer separately inspected all 30 local photos for batch27's 12 lots. Root also recorded direct physical checks of BIN-024888, BIN-024889, BIN-024890, BIN-024891 and BIN-025138, and independently adjudicated the proposed corrections. BIN-024890 remains partial because the jar's product name is readable but its brand is not independently legible. BIN-025138's physical fan label agrees with its already-saved fan title; the historical shoe-title claim does not warrant a correction now.

The independent final consistency pass did **not** reopen all 811 images. It compared explicit worker evidence and uncertainty against the classification contract and the separate native/root physical reviews. Conservative downgrades are not new evidence that the preserved titles are wrong.

## Run accounting and evidence provenance

Successful run `1790019677757-3e3b3efc` completed all 29 jobs from 19:41:17.758Z to 19:48:05.030Z, with **16 observed concurrent external workers**. The provider-reported list-price estimate for completed jobs in this run is **$36.652063**. This excludes earlier failed/cancelled runs, smoke jobs and native-agent usage. It is neither an invoice nor actual billed charges or remaining account quota. Observed concurrency does not establish unlimited capacity or a measured speed improvement.

An earlier image-heavy run failed the retained-log limit and was cancelled; no failed-run output was used. Reviewed toolkit fixes and a successful restricted photo smoke preceded the full retry. The final run's local output validation reported 29 complete jobs, 347 rows and no structural issues. This verifies output coverage, not every visual inference.

The JSON ledger records SHA-256 hashes for its source snapshots. Inputs include local `photo-rows-reviewed.json`, `manifest-provenance-by-lot.json`, `final-review-findings.json`, `native-batch27-review.json`, acquisition summaries, preflight evidence, root physical review, downloaded-photo metadata and the final run state. Their local paths are provenance pointers, not promises that private photos or temporary files are published with this report. Sanitized decisive observations are embedded in every ledger row.

## Three passes and preflight

1. **Scope and impact:** the coordinator bounded the capture to 347 restored IDs, separated manifest lineage from physical identity, and limited photo workers to their single owned JSON output. No worker was authorized to modify inventory or execute a production write. Corrections preserve lot identity and sticker continuity.
2. **Behavior and evidence:** manifest queries, downloaded originals, 29 completed visual-review outputs, native batch27 review and root physical checks supplied the evidence. Structural validation found no missing/duplicate IDs. Failure cases include stock-only inference, unreadable labels, incomplete component cartons, reused photos and unsupported title removal. The failed run supplied no accepted output.
3. **Independent final review:** the bounded consistency audit challenged worker conclusions, recorded 18 adjudications and retained only two coordinator-accepted title corrections. This document and ledger have local reconciliation checks; the coordinator still owns final integration and any production execution review.

Preflight for these audit deliverables:

- [x] Written only to the two audit paths on `braden/restored-lot-title-corrections`, based on `7ae599eb510db302047a48d727dd20e86811169d`; unrelated coordinator script/workflow changes were not edited by the audit author.
- [x] Exactly 347 unique lot IDs and codes reconcile with captured titles, stickers and provenance; final counts reconcile; only two rows carry accepted replacement titles.
- [x] All five questioned PNK rows remain uncertain with no edit; rejected proposals are not accepted actions.
- [x] Original-photo download counts, exclusions, completed-job counts and observed concurrency reconcile with saved evidence. JSON excludes raw HTTP(S) URLs; product evidence excludes shipping-recipient details.
- [x] Successful-run manifest preflight validated 29 jobs and one owned output each. Image-context size warnings were advisory and explicitly reviewed; preflight alone was not a provider-capacity or spend guarantee.
- [x] Supplied rollback-dry-run and live receipts show the two intended titles, preserved identifiers and a fresh two-row post-state; details below.
- [x] Coordinator final document/script integration review passed. Local PostgreSQL checks covered rollback and exact commit, replay refusal, title/photo drift, an unexpected trigger field change, and an AFTER trigger deleting a target row; all passed. Independent review found the missing surviving-row count assertion, which was added and independently rechecked before final approval. Node syntax and whitespace checks passed.
- [x] Separate full-cohort post-check reconciles the same exact 347 IDs, all visible, 342 bound stickers, exactly the two expected title changes and no other changes among compared fields. Every ledger sticker and original title also reconciles against both the captured photo metadata and final pre-correction live snapshot.
- [ ] Applicable PC/mobile browser, Android and iOS rendering checks remain unverified. Database checks alone are not proof of a customer-visible fix.

## Execution record — coordinator-owned

Rollback dry-run **35648577727** captured the original titles, observed both intended replacements inside the rolled-back transaction at **20:02:43Z**, then observed both original titles again at **20:02:45Z**. The cohort remained 347 visible lots with 342 bound stickers.

Live run **35648787939** captured fresh before-images at **20:04:42Z**, rehearsed the correction with rollback, then committed the two accepted titles at **2026-09-21 20:04:45.552082Z (15:04:45 Central)**. Its fresh post-state query at **20:04:46.25509Z** returned both exact accepted titles. For both changed rows, lot ID, code, sticker, operator, inventory status, deletion state and photo URL arrays matched their pre-state values. The post-run aggregate still contained 347 visible lots and 342 bound stickers. Sanitized receipt rows and hashes of the original local receipts are retained in the JSON ledger; no photo URLs are copied into it.

The supplied pre-correction full-cohort comparison, workflow **35646997966** at **19:47:30.670564Z**, had found zero differences from the earlier baselines in title, photo URLs, sticker code, status, deletion state or lot code across all 347 rows. Status counts were 336 pending intake, ten in inventory and one canceled. This earlier comparison is the baseline for the independent post-correction verification. Separate read-only master workflow **35648865745**, observed at **20:05:33.504703Z (15:05:33 Central)**, confirmed the same exact 347 IDs, all visible, 342 bound stickers and exactly the two intended title changes. Photo URLs, stickers, statuses, lot codes and deletion states had zero changes across the cohort, and the other 345 titles were unchanged. This claim is limited to the compared fields, not every database column.

The owner explicitly authorized fixing confirmed titles. The coordinator applied this small, reversible correction during warehouse hours after exact before-state checks and rollback rehearsal. The fixed incident workflow was restored to its original definition after execution; the final branch does not replace the normal migration workflow. The correction script and before-images remain reviewable and refuse replay against changed titles. PC browser, mobile browser, Android and iOS display checks remain outstanding. No catalog rewrite, source-link repair, photo cleanup, deletion or pickup change is part of these two title corrections.
