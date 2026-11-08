# Deleted branches — 2026-11-05

Approved by Braden (Nov 5, 4:28 PM and 4:32 PM CT), tracked in #852.

Deleted 198 remote branches with a plain branch delete (no force-push).
The SHA table below is the restore source; see "Restoring a deleted tip" for a
fresh clone that does not already have the object.

## Restoring a deleted tip

A deleted unmerged tip is not in a fresh `master`-only clone. A closed PR keeps
`refs/pull/<n>/head`, and any clone that still has the object can export it.
Rehearse against a disposable remote first.

1. Resolve the branch to its closed PR and exact tip:

   ```sh
   gh pr list --repo RDW-Labz/bingo-auctions --state closed --head <branch> \
     --json number,headRefOid
   ```

2. Retrieve and verify from a fresh clone (never force-push):

   ```sh
   git fetch origin refs/pull/<n>/head
   test "$(git rev-parse FETCH_HEAD)" = "<sha>" || { echo "wrong tip"; exit 1; }
   git show-ref --verify --quiet "refs/heads/<branch>" && {
     echo "destination branch already exists"; exit 1;
   }
   git push origin FETCH_HEAD:refs/heads/<branch>
   ```

3. If the PR ref is unavailable, export the object from a clone that still has
   it, then repeat the exact-SHA and destination-absent checks:

   ```sh
   git bundle create restore.bundle <sha> --not --all
   # fresh clone: git fetch ./restore.bundle <sha>
   ```

If any check fails, stop and inspect the destination instead of overwriting it.

## Skipped (never-delete rule wins)

- `claude/750-rollback-range-check` — matches *rollback* (never-delete rule wins)
- `claude/759-rollback-range-resolve` — matches *rollback* (never-delete rule wins)

## Deleted branches and tip SHAs

| Branch | Tip SHA |
| --- | --- |
| `braden/acct-01-bidder-number` | `af1294615d9446d277bc3a6866456a457f69d0ce` |
| `braden/alert-check` | `a13dda232ab7389460806f02e5d60f168c651efc` |
| `braden/bid-display-consumes-server-truth` | `46f73be313054fb199622867919ffd99dbc1b243` |
| `braden/bidder-ota-rescue-hatch` | `c4872a4289064b1f28673628ed38f1d6b7ace9c0` |
| `braden/bidder-telemetry-binary-version` | `78bb0f54cf84732ce8c033d5eb7ab885525dba15` |
| `braden/build-skew-reload-prompt` | `6c390ed0a982d21b849c1d213bfb7b175d0da643` |
| `braden/builder-hide-collected` | `789a22b349ad937cf3c1b731ec16e5ab432bce24` |
| `braden/builder-skip-missing` | `63c34af6e710619951140af49ccdf9943d91ae13` |
| `braden/collected-item-invariant-monitor` | `3a0cdc0124cc8a8f1bf1fa1345346b152d857c41` |
| `braden/cron-schedule-handler-gate` | `dfd13ae6d2d1266f5965fe31b50a6da4a17af729` |
| `braden/dispose-duplicate-import-batch` | `8e86ad1b8fc6b376b0ed7616b28e324da6d8e0c7` |
| `braden/fix-dead-deep-links` | `d930e83f03f8d2457dd75b1d1431b1734197de49` |
| `braden/fix-local-setup` | `3219065c3e0a142e955b433733a2f9960842e30a` |
| `braden/fix-migration-default-ref` | `fa94e758fddaa7c3de2f6a052bfa4309ddd0cd20` |
| `braden/fix-postgrest-search-injection` | `ab8cd931d046e25f663bc52df4524b8b7f57f19d` |
| `braden/fnsku-miss-no-web-lookup` | `5060e72aa04edbc363af645379d4f26ccff0f43d` |
| `braden/handoff-2026-10-06` | `a9f5fa6e34630b3aeeeb83e7459a9a88222e541d` |
| `braden/import-leaves-intake-at-null` | `9b89a6b843bf3380ed5d733429cd5e9e4ba3fd8a` |
| `braden/import-stages-inventory-pending-intake` | `3449b652b1e74f97b68fc829f59e10ff6aad5eb9` |
| `braden/import-wizard-rejects-link-titles` | `3495bfe50c5a4da116e7f92ca5ca8283f48faeca` |
| `braden/ios-qa-2026-10-07` | `1dbf42a30ade1a94cf43da3caa6cb66d4529d15c` |
| `braden/lightbox-original-fallback` | `55996bf8a847b6f0f80cc6a0925a57e5d5ac4a42` |
| `braden/loads-link` | `9bb60385c429af814ad764bcd2a3a073a8091d0f` |
| `braden/lookup-missing-banner` | `cd9b14f31369a7c1549c3f583a2e2922e110cbac` |
| `braden/lot-code-lookup-index` | `49f84bfc71321b8121ae534b536427b1b0fd3fed` |
| `braden/manifest-path-in-nav` | `4830413463353737a8c602078754e93e63175e33` |
| `braden/migration-footprint-lint` | `bafbf38e59aee3dbadcda6d71b6999a2a774b69a` |
| `braden/missing-items-report` | `ebf7de73d5a8e754a69a49478299de5270e2805c` |
| `braden/mob-01-category-filter` | `de6c89f4ca8cd265653df5e7dbaf4332064be7ba` |
| `braden/ops-alert-recipients` | `5e08f82d3cd8c802cdf87dc6a8f20d4d6d80e304` |
| `braden/ops-alert-verify-workflow` | `ce3cc5b336e51fd7a9d3ccde0bd05e72967becde` |
| `braden/ota-auto-reload` | `779e028b8824ba367738149b5b174959db62b95d` |
| `braden/outbid-copy-says-you-are-not-leading` | `1594ae9b1a8b8bd5a6598cccb1be5e908221c1c6` |
| `braden/phase2-ci-lockdown` | `b6d065c24e2d2de1d65f9c4edb39cc4b0ef68beb` |
| `braden/physical-footprint-guard` | `926786c4c338754d1ae0ba7a68bab66c54ba2af3` |
| `braden/plan-manifest-pending-trim` | `69ed8ac3a0b09f5819acd1417a7da57acd938a27` |
| `braden/play-status-workflow` | `f8354d2d547ced76ab1296cee529e099aae6bb39` |
| `braden/pro-plan-editor` | `f70800ddca6ceb233013727cbbdf14edf49270bc` |
| `braden/pull-url-titled-lots-from-auctions` | `db093789a16970235ddb9f12a280241d82af0267` |
| `braden/reports-needs-action` | `0c7ad0cc97d0db45ab4db62440ba0da39da4be77` |
| `braden/restore-migration-runners` | `2f2582f30f335805afa398427bd4ebc59d89f8ad` |
| `braden/restored-lot-title-corrections` | `cbc89c98cc25b88fcc0aca4e60d85356e8d42c71` |
| `braden/retire-dead-cron-routes` | `055a52a801ff6ebbfabb31750de8b89571c19e6b` |
| `braden/retire-refund-jobs-queue` | `594675fd672171f84137670ac86470ecda415bf6` |
| `braden/revenue-run-phase0` | `e10dc62b7186e24ff125dce6f5ae2e3e30689494` |
| `braden/runbook-observable-signals` | `973cdf12a303f7d8d4e469a7e5cb77d076b37126` |
| `braden/sentry-dsn-to-worker` | `856ef07f1ce12e6fddc8b632658c821086f1be42` |
| `braden/server-refuse-fnsku-catalog` | `c6bd6c606fee9c004ab55886bc195a3771f9ce29` |
| `braden/staff-android-ota-trace` | `5c325e4679d1d064358e571c523e75d21a570af0` |
| `braden/staff-offline-audit` | `111927abec2ac2093770d8fba04111cd27524bc4` |
| `braden/traffic-by-hour-query` | `a66131f635184e1974dc21c81a93214c0d18a526` |
| `braden/upc-12-13-normalize` | `325b0fb0998625e7410ba22646da4cb732a32bba` |
| `braden/wayfair-feed-alert` | `e648a46717d55ef9535bd163f72abd6bb7204ce3` |
| `braden/web-01-browse-tab` | `2465de4e1436d97f5c78a78713c1c18b4528fe1f` |
| `braden/weekly-prod-cost-report` | `ee391a2f722c4fbe685cc4e80c67193994e2dd2b` |
| `braden/0356-collected-item-never-resold` | `a7bbf9f1e935a5de3624b22f6b3c5ff96944eccd` |
| `ci/maestro-smoke` | `06b52e504555627db9c25af8a49df590d4963014` |
| `ci/maestro-smoke-green` | `747182609707951c43bc87a01872a429f86512a3` |
| `claude/admin-cancel-lot` | `c018dca459b37313b3948cdbd617b7758b17523c` |
| `claude/aging-report-and-android-camera` | `ef0695c8fa30f86b57614cca44694197426c2a99` |
| `claude/aging-report-sticker-identity` | `7729e94f4f5ae6984be472bb44705fe42046376e` |
| `claude/ai-mode-draft-persistence` | `2aae0bb335e85bcad2146858f11ddf7e088b3e4e` |
| `claude/ai-photo-cleanup-guard` | `c03d09c56d35785f020609a7a4ad294b67533d0b` |
| `claude/ai-photos-respect-staff` | `8ac692b73f63f9a11f92915acddccded43dc5c3b` |
| `claude/android-crash-reporting` | `41d9215c91f2d9cb72c9e1bf596319d2d754832a` |
| `claude/android-itf14-camera-crash` | `ddfbaeab2ea7f0c6849bf2d90f0a5fe269ee77ab` |
| `claude/app-feedback-inbox` | `86ea2e601304965741de8eda2974f39f8384c61c` |
| `claude/apply-migration-run-name` | `538ce66864b7221545b1fdd2c344a8a5d2a1d355` |
| `claude/auction-times-dst` | `5574a65c1d8ec26c32621a4ca659a25856e88f23` |
| `claude/bid-confirm-autobid-display` | `c4803de7b6ef9f741353edae1a972aea9bd2a7a7` |
| `claude/checkout-manual-entry-parity` | `c4c9ab80c7865ddaa2e262c2ae63f80022f99575` |
| `claude/checkout-original-listing` | `3039a3f9ba2ce1f036c55aedb29615c40619bd15` |
| `claude/connectors-local-setup-lvk8j1` | `c2bf51dfde48172b165aa3539cec2e3c8a13087f` |
| `claude/console-bidder-insights` | `19c98abb8d7983172d71732a817d8fea72aaf8b3` |
| `claude/console-inventory-refunded` | `59e65d9695570aff6edae54936a125eb7da5b853` |
| `claude/console-lot-ownership-display` | `6fabf1e0c454d1433d288ef51d6a61e23dc9eceb` |
| `claude/correct-stale-load-picks` | `5a13c798cd7d0f896ba2451728c20d147a359a66` |
| `claude/cross-warehouse-scan-warning` | `b4da2de3c18aaf8c934f83b4a614310f5dd21f21` |
| `claude/destroy-and-bin-store-removal` | `ac2baaea9add8f33a9517e460b6c6ea4cf8d63cf` |
| `claude/duplicate-lot-inventory-status` | `86a6d8a2f3c3a53d5d3d8b26285d94fbf3ac9170` |
| `claude/e2e-pin-ubuntu-24` | `ddf0a77ea737dbe87d2afb48d49591df98a6ac1f` |
| `claude/eas-diagnose` | `bf513d1b582ff29f718b1b7cff45afaf831cb046` |
| `claude/eas-diagnose-fix` | `961c9e5920b13e798b2dac233a9bb3cc7cc5f17b` |
| `claude/eas-update-message-injection` | `82624ad4b245a49fa2341afc38dff231710bfdc7` |
| `claude/email-quota-saver` | `5e67245b1bdf204340e68f709bd3ac2b2adabf68` |
| `claude/feedback-notify-reply` | `bf6c2c4ca68d89927802b03422db485636c0b6b1` |
| `claude/fetch-play-signing-sha` | `44d7a4e3a3d61929bd120b1b45cfa4e8fcddc1b8` |
| `claude/fix-ci-0475-deferred-trigger` | `d602c4456f7040051ef0cc2f12adc9dd9ec2629d` |
| `claude/fix-meta-feed-auction-status` | `cf8f8c0c981563d85b9aeba5086b3cf4a849e1aa` |
| `claude/hide-member-pro-until-0457` | `cd370412dcb45e302effa593c979b5300e2fbeaa` |
| `claude/hold-sms-consent` | `877db2a27622bc4d1d3dc22aeee4e1db4cb01846` |
| `claude/land-0448-0449` | `3a96aaee7508b66bd1f7d0f9806306a63ce21911` |
| `claude/land-applied-0401` | `30e5c640166bb2d94bab612e8a06bb0fbc77db66` |
| `claude/land-applied-0434-0436` | `a0ac218f7b2a4f8326818089919de70500151492` |
| `claude/launch-readiness-testing-rxo8ut` | `b41e3d4a45c4c770d2e34f2fdf1964d5b2f8a8ba` |
| `claude/location-filter-and-pickup-fixes` | `a593a9a9bcefbb784f305a7d72f7c7bf0edf6bf9` |
| `claude/lot-lookup-removed-not-unlotted` | `4f20d630c7061db41acac885e25416d7e0997812` |
| `claude/lot-warehouse-transfer` | `ba5839f3c89de271fd9bf2e9503cee59b0be1e4e` |
| `claude/lot-warehouse-transfer-redo` | `13830e7ad27c5a9957482c4ee78e5bf58957968e` |
| `claude/lot-withdraw-0471` | `3a987a268b8d3ac43df691fd4d5cf7576de5be92` |
| `claude/lotting-draft-persistence` | `8ca826684298319eff2c44de1d0a4fd241599dea` |
| `claude/mark-paid-audit` | `58af7b8969100718c157f2be207eff99f9fd8cdc` |
| `claude/marketing-catalog-and-app-links` | `0eb28142eee2c85f128693d6ac39008483b012e8` |
| `claude/member-pro-1-settings` | `93427c686b12e6312d03f90b084b0db04f519985` |
| `claude/member-pro-probe-get` | `b729cc02e57bc7d99516ceb8819aa8082d7c17b5` |
| `claude/meta-secrets-deploy` | `79f4cd72ea6e11218151208107068e36689886b7` |
| `claude/missing-putaway-bin-scope` | `6faadd71037762c02c6ee31239b04381ee85d772` |
| `claude/ota-development-channel` | `912c2ff7df027670c7d30ead9b9fd28d65b6d10e` |
| `claude/ota-runtime-override` | `689461ab39ce00d96b5b30ed61d34541dd7f1f0e` |
| `claude/pin-worker-attribution-at-insert` | `0305506a9bb7958faac7b5b8897ffd8d67992516` |
| `claude/putaway-location-sync` | `5b0cda5ce82f3682dcd061ee85a0a13781db81b3` |
| `claude/refund-credit-paid-and-override` | `509883f436b01d53a1afa33d9054da3396263943` |
| `claude/refund-lot-status` | `bdd13ac64c57f4a9264c63c17b2a7e97d721827d` |
| `claude/refuse-cross-warehouse-shelf` | `e3bb9b93f4e79076b659c913add9d45143557d17` |
| `claude/relist-ago-label` | `ff2ed694d90190613d84b5ecb3a98d129be3b7a1` |
| `claude/relist-dedup-root-cause` | `dcf764d4ed36fb9ea5b6776e943c1d2a127242d6` |
| `claude/relist-drift-chain-fixpoint` | `980ae161fdf411dfee5f6769e6c8a02d44f0e1f1` |
| `claude/relist-location-drift-0311` | `43c9936e44c94f39e7cf6f6a45af7198b8414776` |
| `claude/reports-location-sort` | `45f433e342bc762913c81b9586edad565326b7a1` |
| `claude/revert-608` | `708f517b291dbe056bf05eb86849d899dc340bd9` |
| `claude/revoke-cron-writer-functions` | `945376f318ada345639edf5ba3362868cc72e6dc` |
| `claude/set-android-signing-sha` | `58730e278792a5a585e19386bed9c056f19cff57` |
| `claude/social-console-controls` | `81d52acfeaf77353961a05395b8fa144fc2ad594` |
| `claude/social-posting-bot` | `81b1ed82c120d0328b6f3c600af99e1a7c677db1` |
| `claude/social-posting-runner` | `fa1e287a30aa1916965de30b4d74c26be4b3e7f1` |
| `claude/social-posting-worker` | `b7dfcb5b9d5791ba682223b7cfa8bf2416ca5b42` |
| `claude/sqft-1-schema` | `9620905e4beb2bcd1a4040a5601720ef17297fee` |
| `claude/sqft-3-engine` | `88af38eab83d35795113d4729c3931abd98487e6` |
| `claude/sqft-4-guards` | `5fad852e70d86ef286f52852aabf92bc21714226` |
| `claude/staff-bin-code-warehouse-scope` | `19bf4217f5c34ac16bf57ccfa6f9827617585b3b` |
| `claude/staff-feedback-ack` | `c9fdb2d713e9d2a586470cac79e7fa8464c65f35` |
| `claude/staff-lookup-relist-chain` | `1d26050c811b35ef143fdce36c18c53a8c51035f` |
| `claude/staff-relot-refunded` | `1440cae34a98febe65e60aba7168d679a421fa5c` |
| `claude/staff-tester-build` | `57a35cec86f826f8d4758ec346a5bea50c4d29fc` |
| `claude/sticker-codes-bidder-surfaces` | `e7789030aab59166f9a62c5fbaaac9c056dcbe59` |
| `claude/wayfair-catalog-dedup-s0ot6q` | `22ce5f4d6127b52b04d7f28b3815e9ddefab7e37` |
| `claude/worker-pin-productivity` | `0a864c7d98e1641652641299e0c4cfb3c8173462` |
| `claude/zip-required-optional-fields` | `fd53d32572ac77b15c4475e7f9e4c8f067eb8112` |
| `claude/0432-archive-empty-loads` | `75c2cf62e2587a58e59e0292977db2a0c6ea19df` |
| `claude/0438-zip-city` | `dce45e3c7b990b88fdb406a57d007b98c05598d9` |
| `claude/0439-lock-backup-tables` | `fd6db1e73f615008c4d558605a5a540325f7af69` |
| `claude/0440-tighten-public-grants` | `84197ccaab5ef584363cece51b0f983c47675be2` |
| `claude/0441-draft-edit-lane` | `7f9fad67c5576604ca2f2e100e5125caed1b192a` |
| `claude/0442-recover-identity-code-twin` | `10887c17a6db4756feaac62f88f17a8d9a36fc8e` |
| `claude/0444-undo-forfeit` | `d0f910b86d3de345c697f12c48b8def11dc452e4` |
| `claude/0445-missing-found-relist` | `59a6b68746adfb63a582248d5132c5a918039ef4` |
| `claude/0447-builder-hide-collected` | `25d98931c38c023669d6c53f83e5ccf578655b13` |
| `claude/0458-enqueue-server-only` | `ff7f8bd4114129a060819e06c36f186384cea65e` |
| `claude/0460-allowlist-proof` | `a43552c20e790d685380756365eb3f61be001326` |
| `claude/0487-restore-0304-code-match` | `540ac3bf452f76d01a0f3c73c4fdc1885589aa91` |
| `claude/0487-undo-pickup` | `31714ed6c69f245efbdcb317fa54066a7123a91e` |
| `claude/700-staff-refunded-access` | `301249908cbcf822c032f7914e7151f2169ff8ff` |
| `claude/720-red-team-guardrails` | `bb2ef518989724b9cda2a41d40256c62be6fe31e` |
| `claude/724-bots-refresh` | `49dfff571d6802ff77287a1c1c46ea199699482b` |
| `claude/726-closing-soon-watchlist` | `a23e858b2a7c9f283752a514fc56e6de38b0f4ac` |
| `claude/731-stranded-drafts-rls` | `358c0284d0c6e93cd053b6705128c8544557ce75` |
| `claude/732-guard-hardening` | `516b98e7fb3048dc7288a168a748abd01eefc9ec` |
| `claude/735-736-sql-test-paths` | `b204dfb44aefe33adac8c2eafa8a2703f66c8c3c` |
| `claude/737-stranded-drafts-role-test` | `e6e3a7fa7eb9b5e0328178540a5e186f529ea74b` |
| `claude/738-preflight-catalog` | `70e05259ed37f91f0a867239852d8fade8e131f5` |
| `claude/740-preflight-reader-identity` | `53bc539c5fb35d764c355c1d571bfcb7fc8b7164` |
| `claude/741-preflight-array-test` | `16e4f2ec51a8500d0bde50b9ac76e322857b8ef3` |
| `claude/747-photo-recovery-skip` | `0e9a2113377069051edffcf889ac501f0ede3dc2` |
| `claude/749-preflight-toast-filter` | `99ed2949cd27d62f35fa0dded73ddeecc7b1327e` |
| `claude/752-blocked-skip-reopen` | `8833a36c0d07952552dcb30ddce7420bd394156b` |
| `claude/767-backslash-literal` | `c6b0b410fc31aa4e34c26ac2e66486a3cc9e4fb8` |
| `claude/775-lot-lookup-followups` | `296ed5f439fbaa66a4558ecd607561b45078ebbd` |
| `claude/777-lot-finder-followups` | `495b34c4ff59842db8d2aaa03af7221b0f277852` |
| `claude/781-scopes-docs` | `fc943fd721845919fd96094dad817fe809f08a6a` |
| `claude/796-undo-pickup-followups` | `d73f8aceb675f316379288d7da28d5c7cc5c8083` |
| `claude/834-stalled-alert-followups` | `3dcc91f42aa6d7efcb8b7351309906fab2d7186f` |
| `codex/store-submission-readiness` | `a5a5979f460e9bedf1eab90182c63729771d850d` |
| `design/console-v2-bidder-detail` | `61ffbe4ff8a8b913f6e9073b9a7df18fc9e04bb6` |
| `design/console-v2-inventory-table` | `2f021f6120701ad64edf4709f5de1e138cdd39c7` |
| `design/console-v2-list-rows-88` | `c901f2070204dbf4dca43af3ea1c71fa427f4ad6` |
| `design/console-v2-three-refs` | `1843b2815727303cf058ae4551daaf76fea593bf` |
| `design/console-v2-three-refs-dashboard` | `0fe12b2edbab3efadc47d8ae225f613cf6dcf35e` |
| `design/console-v2-type-followups` | `c43007c78af18a04e8ad8187650df20ced44c7dd` |
| `design/console-v2-warehouses-table` | `282658c1b3d3886a00aac2ba9fcdc872da2d3e96` |
| `design/2026-10-console-v2` | `e412acdcb12c72a3e0a6ce24662f2f574a7e6cd1` |
| `docs/live-edit-spec-and-sqft-prs` | `777a282d7169adf3b7e8b58cfee94ff4d1889834` |
| `docs/sqft-bidding-spec` | `faa7645a0443e5140315b302efc7993e3d54d8a1` |
| `docs/supabase-advisors` | `073c5e4367e8574b97441e36b2bf021d642804ce` |
| `docs/688-bots-roster` | `60748ad1ec5eeba43f815724d05411c0f92b0b54` |
| `feat/lotting-url-fallback` | `e67561316d5192413bf5c4835e9e3590ea1eb156` |
| `feat/native-square-card` | `ab1fb53fa6bdeac1aac66dc6c4da48c757f26f82` |
| `feat/pending-lot-retry-queue` | `99833d4e0f136a60164f0724d67a92d5033216b7` |
| `feat/773-lot-title-lookup` | `8c834286310a42477fda6de14dad745fc1969b96` |
| `fix/bidder-detail-bids-invoices` | `56bdb867fe855d0cfa8c1eadca64970b70e3b748` |
| `fix/bidder-detail-number-phone` | `f2a91edbf74ec5f2a3d01ddb421f8114d0f4c81c` |
| `fix/pickup-status-to-one-embed` | `19d42f29d6a3f66b38bfaeb041ae98a4e776413c` |
| `fix/reports-db-sums` | `606e5237533b5d0b3e30f8ca2d96d171f46121a6` |
| `fix/round4-tester` | `4141be2c1080bd7d373eb78843c9534891098dd9` |
| `fix/staff-draft-survives-background` | `6dc122e97ac75cf3114f95a9c0cdb9bb134dc826` |
| `fix/staff-scan-extract-dependency` | `9c6d24303436f833cb8938be8fd232227513a279` |
| `fix/win-paid-email-details` | `a85c937ba9cb243412c259feb6a110964a987da5` |
| `fix/770-role-retry-lot-lookup` | `00ffc3c0cacd955abcb186d005ca94dfb554bfb9` |
| `port/brightdata-scrape` | `3e6fabad5a6c5ebf09749812990f089ef8900d5b` |
