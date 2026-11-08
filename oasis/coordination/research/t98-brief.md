# T98 scout brief — tinyhumansai/openhuman (research only)

Target: https://github.com/tinyhumansai/openhuman (and its docs/site if linked from the README).
License: GPL-3 (verify the LICENSE file). Ideas only. Do not copy code or long text; summarize in your own words and link the source file for each fact.

Answer, with a source link per fact:
1. **Memory tree:** how memory is stored and organized (tree/nodes/levels? files or DB? embeddings?), how it is written (who/what decides to save), how it is read back into a model call (retrieval, ranking, size caps), how it is pruned/forgotten, and per-user isolation.
2. **Run journal:** what a run records (steps, tool calls, cost, model, timings, outcome), storage format, append-only or not, how it is viewed, whether it feeds evaluation/scoring or replay.
3. **Install + connect flow:** steps a non-technical user goes through to install it and to connect an account/service (OAuth? API key paste? local model?), and where screenshots or images of these steps exist (README images, docs pages, site) — list the exact image URLs or page URLs.
4. **Trust/safety:** are tool results treated as data or instructions; is there any ask-first/approval step; any telemetry default.
5. **Maturity:** stars, last commit date, contributors, release cadence.

Return the pinned facts (repo commit sha you read, date) so the comparison can cite them.
