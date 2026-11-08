# Code graph of the OASIS repos (T72, decision #304) — built 2026-09-30

- Tool: Graphify-Labs/graphify, pinned commit `1cd9a36c0c57a661d2d2234bc3207e887e1ba104` (Apache-2.0), installed in a scratch venv at `~/.oasis-vendor-src/.graphify-venv` (Python 3.12). **No hooks installed** (`graphify install` never run); query log off (`GRAPHIFY_QUERY_LOG_DISABLE=1`, and it is off by default); no LLM: run with a minimal PATH (no `claude` CLI) and no API keys, code-only AST extraction + Leiden clustering with `--no-label` (communities keep placeholder names).
- Input: `repos/` (all nine repos; venvs, node_modules, .git and .gitignore'd paths skipped by the tool).
- Result: 557 code files → **10,962 nodes, 33,329 edges, 386 communities** in ~9 s + 4 s clustering. Top hubs by degree: connectors `store_tokens()` 210, agent-core `Drawer` 200, `ChatService` 199, `LocalService` 139, `Scheduler` 133, remote `Response` 109 (full list: `graphify god-nodes --top 12 --json --graph coordination/research/graph/graph.json`).
- Files: `GRAPH_REPORT.md` (committed, 82 KB). `graph.json` (17.7 MB), `.graphify_analysis.json`, `manifest.json`, `cache/` are git-ignored here: rebuild in ~15 s with the two commands below rather than store them.

```
env -i HOME=$HOME PATH=$HOME/.oasis-vendor-src/.graphify-venv/bin:/usr/bin:/bin \
  GRAPHIFY_OUT=$PWD/coordination/research/graph GRAPHIFY_NO_AUTO_REFRESH=1 GRAPHIFY_QUERY_LOG_DISABLE=1 \
  graphify update repos --no-cluster
env -i HOME=$HOME PATH=$HOME/.oasis-vendor-src/.graphify-venv/bin:/usr/bin:/bin \
  GRAPHIFY_OUT=$PWD/coordination/research/graph GRAPHIFY_NO_AUTO_REFRESH=1 GRAPHIFY_QUERY_LOG_DISABLE=1 \
  graphify cluster-only repos --no-label --no-viz --graph coordination/research/graph/graph.json
```

Queries (`graphify query "..."`, `path`, `explain`, `affected`) read graph.json locally; none call a model unless `label` is run. Do not run `label`, `extract`, `add`, `watch` or `install`.
