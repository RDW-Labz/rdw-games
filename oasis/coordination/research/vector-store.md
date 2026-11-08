# Local vector store for OASIS (2026-09-28)

Scope: rag-pipeline, Python 3.12 (uv), Phase 3 — research only, nothing built. Windows x64 CPU (no GPU assumed) first, Apple silicon second (#263). All three stores below run embedded, in-process, no server.

## Stores

| Pick | License | Pin | Size | What it's for | Link | Catch |
|---|---|---|---|---|---|---|
| LanceDB | Apache-2.0 | 0.39.0 (2026-09-17) | ~103MB wheel, `win_amd64` cp310-abi3 (3.10–3.13, covers 3.12); macOS arm64 wheel also published | Embedded columnar vector db, its own Lance file format (not SQLite). IVF/HNSW/PQ ANN indexes. Every write is a new version (git-like): backup = copy the dataset folder, or `checkout`/`restore` a version. Many concurrent readers; several concurrent writers with automatic commit-retry (one writer is safest). Real `where()` metadata filter pushed into the scan. Row delete/update supported. | [lancedb.com](https://www.lancedb.com/) · [PyPI](https://pypi.org/project/lancedb/) · [FAQ](https://docs.lancedb.com/faq/faq-oss) | A table is a folder of files, not one file to copy; heavy concurrent writers still need a retry loop; biggest wheel of the three. |
| sqlite-vec | MIT AND Apache-2.0 (dual) | 0.1.9 (2026-03-31) | ~0.3MB wheel, `win_amd64` (python3, works on 3.12); loads into stdlib `sqlite3` | A SQLite virtual table (`vec0`) inside the same `.sqlite` file the drawer already uses. Brute-force (SIMD) KNN only, no ANN index yet. Disk format is one ordinary SQLite file. WAL mode gives one writer + many concurrent readers, same as any SQLite file. Metadata/partition columns give real filtering. Normal SQL DELETE/UPDATE. Backup = copy the `.db` file. | [GitHub](https://github.com/asg017/sqlite-vec) · [PyPI](https://pypi.org/project/sqlite-vec/) · [Python docs](https://alexgarcia.xyz/sqlite-vec/python.html) | Pre-1.0 (still 0.x); no ANN index, so it's a linear scan — fine for one person's drawer (thousands of rows), not millions. |
| Chroma (PersistentClient) | Apache-2.0 | 1.5.9 (2026-05-05) | ~23.5MB wheel, `win_amd64` cp39-abi3 (covers 3.12); pulls in onnxruntime + pydantic + more | Embedded client: SQLite for metadata + its own HNSW index files per collection, all in one directory. HNSW params fixed at collection creation. `where=` metadata filter. add/update/delete/upsert all supported, WAL-logged. | [docs](https://docs.trychroma.com/) · [GitHub](https://github.com/chroma-core/chroma) · [system constraints](https://cookbook.chromadb.dev/core/system_constraints/) | Docs say PersistentClient is single-process only — a second process opening the same directory risks `PermissionError` or corruption; telemetry is on by default (must be disabled for private drawer data); backup is a directory copy, not one file. |

## Embedding models (local, no server, Windows CPU + Apple silicon)

| Pick | License | Pin | Size | What it's for | Link | Catch |
|---|---|---|---|---|---|---|
| bge-small-en-v1.5 | MIT | v1.5 (BAAI) | 33M params, ~130MB fp32 / ~33MB int8 ONNX | 384-dim general English retrieval. Runs via fastembed (onnxruntime) or sentence-transformers, CPU-only on Windows x64 and Apple silicon. | [HF](https://huggingface.co/BAAI/bge-small-en-v1.5) | Wants a query-side instruction prefix for best recall; no independently verified CPU throughput figure. |
| all-MiniLM-L6-v2 | Apache-2.0 | sentence-transformers release | 22.7M params, ~90MB | 384-dim general embedding, the most-benchmarked small model. Runs via sentence-transformers or fastembed/onnxruntime. | [HF](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) | Authors' own "~14k sentences/sec" figure is a GPU-batch number, not a verified single-thread CPU figure — expect much less on a laptop. |
| gte-small | MIT | thenlper/gte-small | ~33M params, ~127–133MB ONNX | 384-dim embedding, runs via fastembed/onnxruntime or sentence-transformers. | [HF](https://huggingface.co/thenlper/gte-small) | No official CPU speed figure; same size class as bge-small/MiniLM, no clear gain over them. |
| e5-small-v2 | MIT | intfloat/e5-small-v2 | ~33M params, ~130MB fp32 | 384-dim embedding; needs `"query: "`/`"passage: "` text prefixes. Runs via sentence-transformers or fastembed. | [HF](https://huggingface.co/intfloat/e5-small-v2) | The required prefix is easy to forget and silently hurts results if skipped; no official CPU speed figure. |
| nomic-embed-text-v1.5 | Apache-2.0 | nomic-ai/nomic-embed-text-v1.5 | 137M params, ~550MB fp32 | 768-dim (Matryoshka, sliceable to 256/128), 8192-token context. Runs via sentence-transformers, ONNX, or GGUF/llama.cpp. | [HF](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) | 4–6x the size/compute of the 384-dim models for a single-drawer, short-note use case; no official CPU speed figure. |

## Role gates

Each store can enforce "a person only retrieves from drawers their role allows" two ways:
- **LanceDB:** one dataset directory per drawer (open a different path per person) vs. one shared table plus a `where()` filter on a `person_id` column.
- **sqlite-vec:** one `.sqlite` file per drawer (matches the existing per-person drawer file convention, T06/T09/T21) vs. one shared file plus a `WHERE person_id=` filter.
- **Chroma:** one `persist_directory` (one `PersistentClient`) per drawer vs. one shared collection plus a `where={"person_id": ...}` filter.

A metadata filter alone is weaker: every query path in the codebase has to remember to add the right filter. A missed filter, a copy-pasted query, or a bug in the filter clause returns every drawer's rows in that one call, and nothing about the call looks wrong. A separate file/dataset per drawer turns the same class of bug into a different, more visible failure — wrong path, permission error, empty store — because leaking another drawer's rows first requires opening the wrong file.

**Recommend:** physical separation (one store per drawer, opened only through that person's own drawer path) as the enforced gate, the same pattern already used for macros, memory and chat threads. A metadata filter can still be layered inside a person's own store (e.g., to split note types) but it is never the boundary between people.

## Recommendation

**Store: sqlite-vec, one `.sqlite` file per drawer. Embedding: bge-small-en-v1.5 via fastembed.**

Reason: matches the drawer's existing file-per-person pattern (profile, notes, log, chats, macros) with no new storage concept and no server; MIT/Apache dual license; tiny footprint (a small C extension, no heavy deps beyond onnxruntime for embedding); a single drawer's note/email count is small enough that brute-force KNN stays fast; backup is one file copy; Windows x64 and Apple silicon wheels both exist today for the store and the model.

**Catch:** sqlite-vec has no ANN index yet, so a drawer that grows past roughly tens of thousands of vectors will need a different index (or a move to LanceDB); sqlite-vec is also pre-1.0 (0.1.9) — pin the exact version and re-check before Phase 3 build starts.

## Rejected

- **Chroma** — not a license problem (Apache-2.0 is fine), but PersistentClient is documented single-process-only (risk if two OASIS processes ever open the same drawer), ships telemetry on by default, and has the heaviest dependency footprint of the three.
- **bge-m3** (BAAI, MIT) — considered, but 568M params / 2GB+ is too heavy for a Windows CPU laptop running per-drawer embedding jobs; bge-small covers English retrieval at a fraction of the cost.
- **gte-small, e5-small-v2** — same 384-dim size class as bge-small-en-v1.5 with no clear retrieval or speed gain and a fiddlier prefix convention (e5); kept as fallbacks, not the pick.
- **nomic-embed-text-v1.5** — good license and quality, but 4–6x the size/compute for a short-note, single-drawer job; worth revisiting if a drawer ever needs long-document (8192-token) chunks.
