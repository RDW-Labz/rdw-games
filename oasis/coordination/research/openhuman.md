# openhuman — memory tree + run journal vs ours (T98, research only)

Verdict: Borrow the shapes of bounded memory and replayable journals as ideas only; GPL-3.0 code and hosted choices do not enter OASIS.

## Memory tree vs rag-pipeline + agent-core memory

- Their memory is a pluggable recall, fetch, and store layer that builds a token-budgeted pack per turn, with agent and team namespaces plus a Forget UI. [memory](https://tinyhumans.gitbook.io/openhuman/features/memory) [TinyMemory](https://github.com/tinyhumansai/tinymemory)
- They log user input and the reply around each turn, then periodically synthesize learnings; ours uses explicit T09 TaskHooks, append-only log lines, and a short-lived working store. [memory](https://tinyhumans.gitbook.io/openhuman/features/memory)
- Their items carry types, source tags, and time or folder metadata; ours has four personal drawer stores, thin local note search, and no Phase 0 cross-drawer or role-gated retrieval.
- Their memory can use local or hosted engines; ours keeps secrets in T02, keeps memory free of model and browser calls, and leaves shared role-filtered drawers to the planned RAG phase. [memory](https://tinyhumans.gitbook.io/openhuman/features/memory)

## Run journal vs Scoreboard + action log

- Their companion engine records session history, messages, tool calls, cost, lineage, and JSONL transcripts with SQLite structure behind it. [tinyagents](https://github.com/tinyhumansai/tinyagents)
- Their graph checkpoints support resume and time-travel replay; ours has append-only T09 action logs, private run outputs, and T14/T15 reports that measure rather than execute log content. [flows](https://tinyhumans.gitbook.io/openhuman/developing/architecture/flows-on-tinyagents)
- Their docs show observability through Langfuse and no dedicated in-app journal viewer was found; ours exposes the latest Scoreboard run and keeps missing measures honest. [flows](https://tinyhumans.gitbook.io/openhuman/developing/architecture/flows-on-tinyagents)
- No automated evaluation or scoring pipeline for that run journal was found in the scout report; our Scoreboard has ten named measures and an independent checker.

## Ideas worth borrowing

- Make a bounded, per-turn memory pack an OASIS retrieval view, with counts and clear drawer scope; it could help the COO find useful context without leaking another venture. T09, T57
- Add a user-facing forget action that records an auditable event or tombstone; it could make personal notes easier to control without rewriting append-only history. new ticket
- Give employees a journal view over existing run logs and private outputs, with cost and lineage beside each run; it could make the Scoreboard explainable and build trust. T14, T15
- Add source, type, and time facets to future hybrid retrieval before reranking; it could help the COO find the right document and source quickly. T57

## Do not borrow

- Never place untrusted retrieved text into system instructions; decision 73 requires labelled user data and fixed system text.
- Telemetry on by default: not found in the scout report; OASIS should not assume cloud reporting is wanted.
- Keep secrets in T02 and do not copy hosted-memory credentials or backend assumptions into drawers. [memory](https://tinyhumans.gitbook.io/openhuman/features/memory)
- Do not copy GPL-3.0 code or ship the hosted CortexDB path as an OASIS dependency. [license](https://github.com/tinyhumansai/openhuman/blob/main/LICENSE)

## Install/connect flow

- It is a native desktop download followed by sign-in, explicit OAuth or service connections, and optional model or memory setup. [getting started](https://raw.githubusercontent.com/tinyhumansai/openhuman/main/gitbooks/overview/getting-started.md) [README](https://raw.githubusercontent.com/tinyhumansai/openhuman/main/README.md)
- Screenshots and their dates are in `coordination/references/t98/INDEX.md`; use them as visual reference for T77 Coworkers and T75 updater, not as a dependency.

## Sources

- openhuman: GPL-3.0; commit `5b9abad92359d20eab023d8734dcd6adcb2ec7b3`; read 2026-10-06.
- Links used: [memory](https://tinyhumans.gitbook.io/openhuman/features/memory), [TinyMemory](https://github.com/tinyhumansai/tinymemory), [tinyagents](https://github.com/tinyhumansai/tinyagents), [flows](https://tinyhumans.gitbook.io/openhuman/developing/architecture/flows-on-tinyagents), [getting started](https://raw.githubusercontent.com/tinyhumansai/openhuman/main/gitbooks/overview/getting-started.md), [README](https://raw.githubusercontent.com/tinyhumansai/openhuman/main/README.md), [license](https://github.com/tinyhumansai/openhuman/blob/main/LICENSE).
