# Why these three drafts are retired, not filed

All three were sitting in the daily brief's "FILING QUEUE … 3 report(s) complete" line as if they were
ready to paste. Measured 2026-11-04 against the provider's own namespace API — not DNS — every one is
unfiliable. Filing any of them would be a false positive and would burn programme credibility.

| Draft | Claim asserted | Verdict (provider API, 2026-11-04) |
|---|---|---|
| `epam-bugcrowd-submission.md` | `donauchemie-dev.azurewebsites.net` is released and claimable | **`nameAvailable: false — AlreadyExists`**. The app survives with its traffic pointed elsewhere, so the 13-host EPAM/emakina cluster reads dead in DNS but is not takeable. Evidence only. |
| `github-h1-submission.md` | `ninesapp-app-service.azurewebsites.net` is released | **`nameAvailable: false — AlreadyExists`**. Already filed as HackerOne 4168910 and closed *informative* — this is the same answer the platform gave. |
| `etoro-bugcrowd-submission.md` | `prod-candle.trafficmanager.net` is released | **`409 Domain name not available`** on create, while the name answers NXDOMAIN. Deleted Traffic Manager profiles keep their DNS name reserved. |

Reproduce:

```bash
.venv/bin/python engine/verify_claimable.py --dry-run
```

That script measures every `claimable=1` row against `checknameavailability` / a real Traffic Manager
create, and (without `--dry-run`) demotes the ones the provider says are taken. It took the corpus from
**33 claimable → 2**, and both survivors are outside every published paying scope.

The lesson is the one worth keeping: `dig` proves a name is *unused*, never that it is *free*.
