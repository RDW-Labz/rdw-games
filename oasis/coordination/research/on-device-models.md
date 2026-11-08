# On-device models for OASIS (2026-09-28)

Research only, nothing built. Windows x64 laptop first (CPU, maybe a small iGPU, 16GB RAM, no discrete GPU assumed), Apple silicon (M-series, 16GB) second, per decision #263. Jobs: chat titles (2-4 words), short thread summaries, recap opening lines.

## Runtimes

| Pick | License | Pin | Size | What it's for | Link | Catch |
|---|---|---|---|---|---|---|
| llama.cpp (llama-server) | MIT | b11100 (2026-09-22) | binary ~5-15MB + model file | CPU/GPU inference, OpenAI-compatible local HTTP API, GBNF grammar to force output shape | https://github.com/ggml-org/llama.cpp | No model manager; app bundles/versions the GGUF itself |
| Ollama | MIT | v0.34.4 (2026-09-23) | ~1.5GB installer (bundles CUDA/ROCm libs) + model blobs | CPU/GPU inference, local HTTP API on 127.0.0.1:11434, easy model pull UX | https://github.com/ollama/ollama | Installs as a background service, not a binary you embed in your own app; heavier than llama.cpp |
| ONNX Runtime GenAI + DirectML | MIT | v0.17.0 (2026-09-28) | few hundred MB (runtime DLLs + DirectML) | Windows-native NPU/iGPU/CPU acceleration via DirectML EP; powers Foundry Local / Windows ML | https://github.com/microsoft/onnxruntime-genai | Library only, no built-in HTTP server; app writes its own loop or pairs with Foundry Local |
| MLX (Mac only) | MIT | ml-explore/mlx, active 2026 | library, tens of MB, no separate runtime | Fastest local inference on Apple silicon (Metal-native); mlx_lm.server gives an HTTP API | https://github.com/ml-explore/mlx | Mac-only, no Windows path; secondary target per #263 |

### Rejected (runtimes)
- **LM Studio headless (llmster daemon):** free for personal/commercial internal use since 2025-07-08, but under LM Studio's own Application/Hub Terms of Service, not MIT/Apache/BSD. Fails the license filter even though the business terms are friendly (https://lmstudio.ai/app-terms).

## Models (<=4B)

| Pick | License | Pin | Size (Q4) | What it's for | Link | Catch |
|---|---|---|---|---|---|---|
| Qwen3-1.7B-Instruct | Apache-2.0 | Qwen3 launch 2025-04-29 | ~1.1GB (Q4_K_M GGUF) | Best speed/quality balance for titles + short summaries; 32K context | https://huggingface.co/Qwen/Qwen3-1.7B | Needs grammar/schema constraint for reliable JSON; raw prompting alone is not reliable enough |
| Qwen3-0.6B | Apache-2.0 | Qwen3 launch 2025-04-29 | ~400MB (Q4) | Fastest option, titles only | https://huggingface.co/Qwen/Qwen3-0.6B | Noticeable quality drop on multi-topic threads and summaries |
| SmolLM3-3B | Apache-2.0 | 2025-07-08 | ~1.9GB (Q4) | Strong benchmark scores for its size, long-context, multilingual | https://huggingface.co/HuggingFaceTB/SmolLM3-3B | Slower than Qwen3-1.7B on CPU for similar quality; no published CPU tok/s yet |
| Phi-4-mini (3.8B) | MIT | model card, 2025 | ~2.5GB (Q4_K_M) | Strong reasoning/instruction-following, 128K context | https://huggingface.co/microsoft/Phi-4-mini-instruct | Largest of the shortlist, closest to the 4B ceiling, slowest on CPU-only laptops |
| Llama-3.2-3B-Instruct | Meta Community License (custom, not OSI) | 2024-09-25 | ~2.0GB (Q4) | Well-benchmarked, wide tooling support | https://huggingface.co/meta-llama/Llama-3.2-3B-Instruct | Commercial use allowed under 700M MAU, but needs "Llama" naming/attribution + EU multimodal carve-out |
| Gemma3-1B | Gemma Terms of Use (custom, not OSI) | Gemma 3 release, 2025 | ~700MB (Q4) | Small footprint, Google tooling support | https://ai.google.dev/gemma/terms | Prohibited-Use Policy flows down to end users, plus a unilateral termination right; needs legal sign-off before shipping |

## Cost and speed
- CPU-only (no GPU), 1-3B models: published community benchmarks cluster around 25-40 tok/s for ~1.7B models and 10-25 tok/s for 3B models on modern laptop CPUs (Ollama/llama.cpp, 2026). Titles (5-10 output tokens) finish in well under a second either way; summaries (40-80 tokens) take a few seconds.
- Apple silicon (M-series): MLX runs 30-50% faster than Ollama/llama.cpp on the same chip in community benchmarks; small 1-3B models land past 60 tok/s on M1/M2 - plenty of headroom for these job sizes.
- Hosted comparison, cheapest current list price found: Gemini 2.5 Flash-Lite at $0.10 / $0.40 per 1M input/output tokens (2026 pricing). At our volume (200 titles + 50 summaries/person/day; est. ~100 in + 6 out tokens per title, ~400 in + 50 out per summary) that is roughly **$0.005/person/day** (~$1.40/person/year) hosted. Cost is not the deciding factor at this volume either way - the real trade is latency/offline capability/privacy (on-device) versus zero footprint and simpler ops (hosted).

## Recommendation
**llama.cpp (llama-server) + Qwen3-1.7B-Instruct, Q4_K_M GGUF.**
- Reason: MIT license end to end; ships as one small binary plus one model file, no installer, no background service, no Python needed; has a built-in OpenAI-compatible HTTP API; and supports GBNF grammars that force the 2-4 word title shape at the decoding level instead of hoping the model obeys a prompt. Apache-2.0 weights are unambiguous for internal commercial use. The same binary+model pair runs on Windows x64 CPU-only and on Apple silicon, so one trial covers both targets in #263's stated order.
- Catch: llama.cpp has no model manager, so the app owns bundling/versioning the ~1.1GB GGUF file, and grammar-constrained decoding on a 1.7B model still needs a fallback rule for the rare malformed output.
- The one test that decides it: run 50 real-shaped fake OASIS threads through llama-server + Qwen3-1.7B-Instruct with a GBNF grammar capping titles at 2-4 words, on a CPU-only Windows x64 laptop (16GB RAM, no discrete GPU). Score the title pass rate against the 2-4 word rule and measure tokens/sec. >=90% pass rate and sub-second titles = go; otherwise fall back to Phi-4-mini or keep titling on a hosted model.

## Rejected
- **LM Studio headless:** proprietary Application/Hub Terms of Service, not MIT/Apache/BSD - fails the runtime license filter outright.
- **Llama-3.2 1B/3B:** custom Meta Community License, not Apache/MIT; usable under the 700M MAU threshold but adds attribution/naming obligations we don't need when Apache-2.0 options (Qwen3, SmolLM3) score similarly.
- **Gemma3-270m/1B:** custom Gemma Terms of Use with a Prohibited-Use Policy that flows down to end users and a unilateral termination right - needs legal review before it can ship in a distributed app; deprioritized versus Apache-2.0 alternatives.
