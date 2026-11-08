## Unreleased

- T16b follow-ups (agent-core 0.6.0). Model-call accounting follows decision #54: a call the
  provider refuses before running (any HTTP 4xx, such as 400 invalid request or low credit, 401,
  403, 404, 413, 429), or one that fails before anything is sent, is recorded as failed at $0 —
  the reservation is released, the journal gets a terminal zero-cost `fail` record, and it is
  never uncertain. Uncertain is kept for unknown outcomes only (timeout, lost connection, no or
  unreadable response, 5xx after sending), still with no retries, and never blocks later calls
  by itself: the "outstanding model charge requires reconciliation" block is gone from
  `MemoryLedger` and `FileLedger`. There is no agent-level spend cap (decision #8) — the only
  budget is per loop run, from the skill's `max_usd` (`ModelRequest.remaining_usd`); an uncertain
  charge simply counts toward the agent's $500 spend-alert lines at its full reservation until a
  verified settle. `LedgerStore` gains `fail`. The model audit gains a terminal
  `failed` stage with a fixed `reason` (`provider_refused`, `provider_error`, `timeout`,
  `no_response`, `dependency`) and the HTTP status number only, never a body, message, prompt or
  key; `JsonlModelAudit` writes and checks both fields. A failed call raises a fixed message
  naming the reason and status, for example "model provider refused the request (HTTP 400)". New
  operator command `anorak.ledger_cli` — `ledger settle <agent> --amount <usd> --drawer <path>
  [--call <call_id>]` — records the verified cost of a leftover uncertain call through the
  ledger journal, hashing the agent id with the same function `ModelClient` uses (`docs/models.md`).
  Also fixed: `vendor/runtime-requirements.txt` now uses the repo-root path
  `vendor/connectors-0.3.0-py3-none-any.whl` and must be run from the repo root; `rig-service`
  gives a plain message when the drawer folder is not private (`chmod 700`).
- T16b — daily-summary runs for real through `rig-service` (decisions #48-#53). `anorak.loop`'s
