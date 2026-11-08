# What actually happened when the queue tried to file

Nine drafted reports, three platforms, zero submissions. Not for lack of trying — each platform was driven
through its own rail until it refused, and the refusal is recorded here so no later session re-runs this.

## HackerOne — `h1/aon`, `h1/cbre` → HTTP 403, empty body

Both drafts build a complete spec (`reports/specs/aon-api.json`, `reports/specs/cbre-api.json`) and pass the
scope gate, because both hostnames sit on scopes that accept submissions. They pay nothing: every aon and
cbre asset in scope is `bounty: false`, so they are VDP-side assets reached through a bug bounty programme.

```
POST https://api.hackerone.com/v1/hackers/reports
{"data":{"type":"report","attributes":{...,"team_handle":"aon",
  "structured_scope_id":"...","weakness_id":26,"report_type":"vulnerability"}}}
→ 403  {"errors": [{"status": 403}]}
```

Same 403 with `report_type` omitted and with `report_type: "report"`, on both programmes. The token itself
is fine — the write probe still gets to a parameter-stage rejection, and the GitHub/Playtika/Starbucks
reports on this account went through the same endpoint. What differs is the scope: submission-only assets
are refused. `engine/.h1-vdp.json` stamps this, and `engine/board.py` now carries it as the
`hackerone:vdp-write` rail so the board cannot claim again that the API files everything.

The other HackerOne path — the web form — stops at a WebAuthn security-key prompt on sign-in. Nothing
headless satisfies it.

**So:** these two drafts cannot be filed as written. They become filable only by submitting them against a
bounty-eligible asset, which means new targets, not a new credential.

## Bugcrowd — four engagements, drafts staged in-platform, submit blocked by identity verification

`engine/bc_web.py submit <engagement> --report <file>` now fills the real form: title, target, description,
Save draft, and — with `--go` — presses Submit. Every draft below exists in the Bugcrowd account now, not
just as a file on disk. The form carries this banner the whole time:

> Identity verification required — To maintain platform integrity and ensure secure reward processing, all
> researchers must verify their identity before submitting a potential vulnerability.

and there is no Submit control rendered at all until it is done. `engine/.kyc.json` is the stamp
(`verified: false`, "not started — Start identity verification is still offered").

| engagement | drafts | example draft |
|---|---|---|
| `volkswagen-og` | 5 | `/engagements/volkswagen-og/submissions/36988234-27d5-4e7a-a58d-0f40851b39f0/edit` |
| `epam-mbb-og` | 5 | `/engagements/epam-mbb-og/submissions/4884ac4f-1480-491f-9408-f1886893c2e9/edit` |
| `etoro-mbb-og` | 4 | `/engagements/etoro-mbb-og/submissions/715228af-deb9-4252-bd28-352509b1e55a/edit` |

Full link list: `reports/bc-drafts.json`. The extra rows are repeats from repeated runs of the same draft;
Bugcrowd shows drafts only to the researcher, and the `fire drafts when verified` cron will not create more.

Identity verification is a government ID plus a selfie, five attempts, fifteen minutes each. It is the one
step in this pipeline that is not automatable: it needs a human face and a document, held by the person
whose identity it is.

## Intigriti — no account session at all

`app.intigriti.com` redirects to `login.intigriti.com/Account/Login`. There is no Intigriti credential in
the vault and no session cookie, so the three `it/` drafts (`axelspringerse`, `bpost`, `vrtnv`) have no rail
to travel on — not a broken rail, an absent one.

## What the queue is worth right now

Nothing, and the board is honest about it: `MONEY collected $0.00 · claims 3 filed (0 open / 3 closed)`.
The dangling-DNS class has not paid on any platform, and the three walls above are why the current nine
drafts cannot change that. The next dollar comes from an application-level finding on an asset that pays,
not from another sweep or another draft.
