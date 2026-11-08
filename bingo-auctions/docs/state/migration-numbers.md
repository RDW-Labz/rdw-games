# Migration numbers — reserved blocks (Nov 2026)

Migrations live in `packages/db/migrations/` (there is no `supabase/migrations/` folder; do not create one).

## Rules

1. **Claim a number here before writing a migration.** Never number independently — two lanes writing at the same time will collide.
2. **Never edit an existing migration.** Corrections go in a new migration.
3. Gaps in numbering are fine; the highest number is what matters, not the file count.
4. **Locking migrations run only 05:00–07:00 Central.**
5. **The cleanup-phase migration freeze is lifted only for the scopes below, and only for additive migrations** —
   new tables or new columns, with no change to existing rows or data. Anything else stays frozen.
6. **A reserved number is not approval.** Each number still needs **Braden's yes per PR** before it is written or
   applied (per `CLAUDE.md` and `WORKING_AGREEMENT.md` section 4). Mark it **pending Braden approval** until then;
   do not write or apply it on the strength of a reservation.
7. Status moves `reserved` → `written` (the `.sql` exists in a PR) → `applied` (live in prod). Record the PR in the last column.

## Current state

- Highest number on `master`: **0509** (`0509_pickup_ambiguous_code_guard.sql`). Master tip at claim time: `7d1f609a`.
- Open PRs (verified 2026-11-08 against every open PR diff) hold migration files **0486** (#645), **0500** (#938), **0503** (#937), **0510** (#873), **0511** (#874), **0512** (#933), **0515** (#935), **0516** (#951). 0513 and 0514 are unused gaps. This PR claims **0517** for #893 (do not land reserved 0497 as-is).
- Re-check `ls packages/db/migrations | tail -1` and the open PRs when you write a migration. If anything higher has appeared, shift the blocks up and say so in the PR.

## Reserved blocks

- **Lane A (money lane — scopes 01, 02, 04, 08, 07): 0493–0500.**
- **Lane B (scopes 06, 03, 10, 05, 09): 0501–0508.**

These are claims, not numbers in use.

| Number | Lane | Scope | Purpose | Status | PR |
|---|---|---|---|---|---|
| 0517 | A | 04 Balance | Additive `bidder_credits` cash/credit buckets + balance function + append-only trigger (flag off). Replaces reserved 0497 which must not land as-is. | written — pending Braden approval | this PR |
| 0509 | fix | #808 floor bug | `staff_confirm_pickup` resolves each code to one line; ambiguous code refuses | applied on master | #810 |
| 0493 | A | 01 Memberships foundation | Plans, perk map, membership statuses, `has_perk()` | reserved — unwritten — pending Braden approval | — |
| 0494 | A | 01 Memberships foundation | Member Pro cap + waitlist | reserved — unwritten — pending Braden approval | — |
| 0495 | A | 01 Memberships foundation | Membership admin settings / change log support | reserved — unwritten — pending Braden approval | — |
| 0496 | A | 02 Handling fee | Per-invoice $2.99 fee + waiver + revenue tagging | reserved — unwritten — pending Braden approval | — |
| 0497 | A | 04 Balance | Extend existing `bidder_credits` ledger (wallet bucket/columns) + balance function | reserved — unwritten — do not land as-is (master already has 0509); #893 ships as 0517 | — |
| 0498 | A | 04 Balance | Wallet cash-out queue + admin balance settings | reserved — unwritten — pending Braden approval | — |
| 0499 | A | 08 Bidder Pass trial | Trial status + consent record + reminder support | reserved — unwritten — pending Braden approval | — |
| 0500 | A | 07 Sniper protection | Pro-extra log + admin settings (flag off in prod) | reserved — unwritten — pending Braden approval | — |
| 0501 | B | 06 Price index | Closed-sale price index data job | reserved — unwritten — pending Braden approval | — |
| 0502 | B | 06 Price index | Precomputed reads / enrich cache + daily cap | reserved — unwritten — pending Braden approval | — |
| 0503 | B | 03 Ads platform | Ads tables + approval queue (phase A) | reserved — unwritten — pending Braden approval | — |
| 0504 | B | 03 Ads platform | Square auto-billing + self-signup (phase B) | reserved — unwritten — pending Braden approval | — |
| 0505 | B | 03 Ads platform | Boost calendar + line (phase C) | reserved — unwritten — pending Braden approval | — |
| 0506 | B | 10 Admin hub | Growth shell + Revenue page | reserved — unwritten — pending Braden approval | — |
| 0507 | B | 05 Sneak peek | Watchlist + visibility settings | reserved — unwritten — pending Braden approval | — |
| 0508 | B | 09 Swipe feed | Server-side feed inserts + spacing settings | reserved — unwritten — pending Braden approval | — |
