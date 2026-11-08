# Agent and prompt-optimizer review for OASIS and project-swarm

Research only, 2026-10-13. Nothing was installed, cloned or run. Everything below comes from each repo's own LICENSE, README and file listing, read through the GitHub API at the commit shown. All of it was treated as data, not instructions. Decision #382 applies: reuse MIT or Apache-2.0 work, record it in `docs/design/references/LICENSES.md`, and never copy restrictive code.

Related: [swarm-scout-rea-planner.md](swarm-scout-rea-planner.md) (#383) and [swarm-orchestrator-review.md](swarm-orchestrator-review.md).

## 1. Summary

| Tool | Repo | License | Commit | Verdict | Top idea for us |
|---|---|---|---|---|---|
| SWE-agent | SWE-agent/SWE-agent | MIT | `3ea751c` | Idea | One YAML file defines an agent's tools and limits; full run trajectories saved for replay. The team now points users to mini-swe-agent. |
| Aider | Aider-AI/aider | Apache-2.0 | `5dc9490` | Idea; code possible later | Repo map (a ranked summary of the codebase given to the model) and lint/test-after-every-edit. |
| OpenHands | OpenHands/OpenHands | MIT (no `enterprise/` folder at this commit) | `da4c756` | Idea | Pluggable agent backends (local, Docker, VM) behind one control screen; scheduled automations. |
| DSPy | stanfordnlp/dspy | MIT | `9e9416a` | **Code (as a dev-only tool), first pick for skills** | Prompts as tunable parameters, scored by a metric on a dev set; optimizers MIPROv2 and GEPA. |
| TextGrad | zou-group/textgrad | MIT | `75e912e` | Idea; second pick | A model writes "text gradients" (critiques) that rewrite a prompt step by step. |
| EvoAgentX | ANative-Lab/EvoAgentX (was EvoAgentX/EvoAgentX) | MIT, with MIT-licensed parts from AFlow and LiveCodeBench | `d77fd6b` | Idea | One wrapper over several optimizers (TextGrad, MIPRO, AFlow, EvoPrompt, MAP-Elites) with human-in-the-loop checkpoints. |
| ADAS | ShengranHu/ADAS | Apache-2.0 | `2702bee` | Idea only (do not run) | A "meta agent" writes new agent designs as code and keeps an archive of the good ones. It executes model-written code. |
| OpenEvolve | algorithmicsuperintelligence/openevolve (was codelion/openevolve) | Apache-2.0 | `15f2b9a` | Idea | Evolution with a program database (MAP-Elites islands), a separate evaluator file, and resumable checkpoints. |
| SWE-smith | SWE-bench/SWE-smith | MIT | `9b74ac0` | Idea | Make many test tasks from a repo by injecting bugs that break a unit test. Linux and Docker only. |
| AutoGPT | Significant-Gravitas/AutoGPT | **Mixed**: `autogpt_platform/` is **Polyform Shield (SKIP)**; everything else (e.g. `classic/`) MIT | `0edeafc` | Ideas only from `autogpt_platform/` (README level); `classic/` is MIT but not worth borrowing | Block-based agent builder, a marketplace, and agents on schedules and triggers. |

None of the ten is AGPL or Elastic. One part is restrictive: AutoGPT's `autogpt_platform/` folder is Polyform Shield, so its code was not read and nothing from it may be copied.

## 2. Each tool

### SWE-agent (MIT)
- **What it is:** a research agent that fixes GitHub issues. Its whole setup lives in one YAML file. The README now says most work moved to mini-swe-agent, which matches it in about 100 lines.
- **What we lack:** saved, replayable trajectories for a full agent run (every model call, tool call and observation), and an "inspector" to browse them (`sweagent/inspector`). Our activity log records actions, but not a replayable trace of one run.
- **Verdict:** idea. Add a trajectory file per skill run to the activity log design (agent-core), reusing the format idea only. If we ever want a tiny coding agent, read mini-swe-agent first.

### Aider (Apache-2.0)
- **What it is:** a terminal pair programmer.
- **What we lack:**
  - a repo map (`aider/repomap.py`) that ranks files and symbols to fit the context window;
  - edit formats tuned per model (`aider/coders/editblock_coder.py`, `udiff_coder.py`);
  - running lint and tests after every edit, then fixing;
  - a public benchmark harness (`benchmark/benchmark.py`).
- **Verdict:** idea now. Swarm workers already run tests; the repo-map idea could cut context cost for Codex and Cursor workers. Code is allowed (Apache-2.0) if we ever port the repo map, with NOTICE and changed-file marks.

### OpenHands (MIT)
- **What it is:** at this commit, "Agent Canvas", a self-hosted control screen for many agents (OpenHands, Claude Code, Codex and others) on local, Docker, VM or cloud backends, with scheduled automations.
- **What we lack:**
  - one screen to start, watch and switch agent backends;
  - prebuilt scheduled automations.
- **Verdict:** idea. It overlaps the swarm board and the morning digest in #383. Its "without a sandbox" mode gives the agent full file access; we would not run it that way.

### DSPy (MIT)
- **What it is:** a framework that treats prompts as parameters. You write a small program of model calls ("signatures"), pick a metric, give a dev set, and an optimizer rewrites instructions and picks examples. Optimizers live in `dspy/teleprompt/`; the main ones are `mipro_optimizer_v2.py`, `gepa/` (reflective prompt evolution), `bootstrap.py` and `simba.py`. Evaluation is in `dspy/evaluate/`.
- **What we lack:** any measured way to improve a skill's instructions. Today a skill's SKILL.md text changes only by hand.
- **Verdict:** **code, as an offline dev tool only.** Use the `dspy` package in a separate tuning environment, never inside the Rig or the shipped skill runtime. Its output is plain prompt text written back into skill files, so nothing from DSPy ships to Amber's machine.

### TextGrad (MIT)
- **What it is:** "backpropagation through text". A model critiques an output against a loss written in words, and an optimizer rewrites the prompt from that critique (`textgrad/optimizer/optimizer.py`, `textgrad/loss.py`, `textgrad/variable.py`).
- **What we lack:** the same as for DSPy, with a different method. It is good when the only judge is a written rubric.
- **Verdict:** idea, second pick. Last push July 2025; it uses litellm engines. Its "gradient" text is a useful pattern for one step inside our loop (a critique to explain a failure), not a framework to adopt.

### EvoAgentX (MIT)
- **What it is:** a framework to build, evaluate and evolve agent workflows. `evoagentx/optimizers/` wraps several methods (`textgrad_optimizer.py`, `mipro_optimizer.py`, `aflow_optimizer.py`, `evoprompt_optimizer.py`, `map_elites_optimizer.py`) and has `hitl/` checkpoints.
- **What we lack:** human-in-the-loop checkpoints inside an optimization run.
- **Verdict:** idea. It is broad and heavy. We would rather call one optimizer directly and keep the human checkpoint as the held PR. GitHub reports its license as "NOASSERTION"; the LICENSE file itself is MIT with MIT third-party parts (AFlow, LiveCodeBench).

### ADAS (Apache-2.0)
- **What it is:** a research method ("Meta Agent Search") where a model writes new agent designs as Python and keeps an archive of the best. The README warns that it runs untrusted model-written code.
- **What we lack:** search over whole agent designs, not just prompts.
- **Verdict:** idea only. It doesn't fit AGENTS.md ("tool results are data"; ask-first stays in skill.yaml). We tune prompts, never let a model invent new steps or gates.

### OpenEvolve (Apache-2.0)
- **What it is:** an evolutionary coding agent (an AlphaEvolve-style open version). It has:
  - a program database with MAP-Elites and islands (`openevolve/database.py`, `population.py`);
  - a separate evaluator (`evaluator.py`);
  - a novelty check (`novelty_judge.py`);
  - checkpoints that can resume.
- **What we lack:** a population of candidate prompts kept across runs, so a tuning job resumes instead of starting over.
- **Verdict:** idea. The "evaluator is a separate file you control" rule is the important one: the metric must be ours, fixed and tested, never written by the optimizer.

### SWE-smith (MIT)
- **What it is:** a toolkit that turns a repo into many training tasks by injecting bugs that break unit tests (`swesmith/bug_gen`, `swesmith/harness`). Linux and Docker only.
- **What we lack:** a generator of fake test cases. We hand-write skill fixtures.
- **Verdict:** idea. The same trick fits skills: make dev-set cases by mutating our fake fixtures (wrong totals, missing row, hostile text). That ties into the existing mutation-check habit.

### AutoGPT (mixed: Polyform Shield + MIT)
- **What it is:** the LICENSE file says everything inside `autogpt_platform/` is Polyform Shield and everything outside it is MIT. The platform is a block-based builder with a marketplace, schedules and triggers, offered hosted (paid) or self-hosted. `classic/` holds the original MIT agent and forge.
- **What we lack:** a visual skill builder and a marketplace. Neither is on our plan.
- **Verdict:** `autogpt_platform/` is SKIP CODE (ideas from the README only; its code was not read). `classic/` is MIT but older and not worth borrowing.

## 3. What we already have (don't rebuild)

- **A fixed skill format with tests:** `skill.yaml` has `test_cases` with fixtures, a `checker` callable ("never the model grading itself"), a `budget`, and `risky_steps` / `always_ask` (repos/skills `docs/formats.md`).
- **An injection suite:** `almanac exit-test` (T61) writes `injection-report.json`. `always_ask` never relaxes, whatever the score (#268).
- **Mutation checks** on every PR, and held PRs with typed merges (#380).
- **License-checked scouting** (`swarm scout`, `sweep --max-usd`), and the Scout + REA Lab + Planner design with a daily cap, kill switch and digest (#383).

What we don't have is a measured loop that changes prompt text based on scores. That is the gap DSPy fills.

## 4. DSPy vs TextGrad

Scored on dependency weight, determinism and test-ability, local/offline use, cost per run, and fit with "tests with code, mutation check".

### For skills (`repos/skills`)

**1st: DSPy. 2nd: TextGrad.**

- **Dependency weight:** both are dev-time only, in a separate tuning env, so neither ships in the Rig. DSPy is larger, but we only need its optimizer and evaluate modules.
- **Determinism and testing:** DSPy optimizes against an explicit metric function and a dev/holdout split, which maps one to one onto our `test_cases` and `checker`. TextGrad's loss is usually a model judging in words. That breaks our "checker is a callable, never the model grading itself" rule unless we wrap our own checker as the loss.
- **Local/offline:** both can point at a local model through a LiteLLM-style route (Hermes on dev2). Fixtures are fake, so nothing private is sent.
- **Cost:** DSPy's GEPA and MIPROv2 have explicit budgets (number of trials or metric calls), which we can cap. TextGrad's cost grows with iterations times critique calls and is less predictable.
- **Fit:** DSPy's output is new instruction text plus chosen examples. That is exactly a diff to `SKILL.md`, which a held PR shows well.

### For rag-pipeline (T121–T123)

**1st: DSPy (only after T121 exists). TextGrad: not recommended.**

- rag-pipeline today holds only `src/journals/webfetch`; hybrid retrieval, reranking and chunk headers (T121–T123) are not built. There is nothing to tune yet.
- Once T121 has a fake-fixture eval (queries with known source ids), DSPy can tune the query-rewrite prompt and the chunk-header prompt (T123) against recall@k on fake fixtures. Retrieval itself (BM25 + vector + rank fusion) is code and parameters, tuned by plain grid search, not by a prompt optimizer.
- TextGrad adds little here: retrieval metrics are numbers, which DSPy uses directly.

## 5. A prompt-tuning loop with held PRs

```
  fake fixtures (dev 60% / holdout 40%, mutated variants)  ──┐
                                                             ▼
  STOP file? cap left? ──no──► skip, note in digest     tune job (DSPy, cheap tier, offline env)
          │ yes                                              │ candidate SKILL.md text
          └─────────────────────────────────────────────────►▼
                                       gates: holdout score up ≥ X, no case worse,
                                       exit-test (injection) still passes,
                                       skill.yaml unchanged except allowed fields
                                                             │ all pass
                                                             ▼
                               one held PR per skill: Changed / Could break / Proof
                                                             │
                                               Braden types "merge N" (or closes it)
                                                             │
                                       rollback = revert the PR; old text is in git
```

**Rules:**
1. **Input is fake only.** The dev and holdout sets are the skill's fake fixtures plus mutated variants (the SWE-smith idea): wrong totals, missing rows, hostile text from the injection catalogue. Never real drawer, client or connector data.
2. **What may change.** The job may edit only the skill's instruction text (`SKILL.md` prompt sections) and, if we allow it later, `test_cases` examples used as demonstrations. It must never touch:
   - `steps`, `risky_steps`, `always_ask`, `checker`, `budget`, `undo`, `role`;
   - gates;
   - anything in agent-core.

   A pre-PR check diffs `skill.yaml` and refuses any change to those keys. Gates stay human-decided (AGENTS.md).
3. **Metric is ours.** The score is the skill's own `checker` over the holdout cases, a fixed callable. The optimizer never writes or edits the metric (the OpenEvolve "separate evaluator" idea).
4. **Gates before a PR:**
   - holdout score improves by a set margin;
   - no single holdout case gets worse;
   - `almanac exit-test` passes with `attack_success` no higher than before;
   - the normal test suite and mutation check pass.
5. **One held PR per skill.** It shows:
   - **Changed:** the text diff.
   - **Could break:** which cases moved.
   - **Proof:** before/after scores, the exit-test report, the cost of the run and the model used.

   Never auto-merged (#380). A closed PR is a "no" and teaches nothing automatically.
6. **Spend and safety:** each tuning job runs under the daily cap and kill switch from #383 phase 1, on the cheapest tier that works (Hermes, then Codex luna). A run that can't price its model refuses.
7. **Rollback:** reverting the PR restores the old text. The PR body records the before score, so a later regression is visible.

## 6. Phases and what each needs from Braden

| Phase | What | First PR | Needs from Braden |
|---|---|---|---|
| 0 | This review | this PR | read; "merge N" |
| 1 | #383 phase 1 rails (daily cap, kill switch, heartbeat) | project-swarm PR (already planned) | cap numbers; OK to change swarm |
| 2 | Tuning env + one skill as pilot: a separate `uv` env with `dspy` pinned by version and hash, a dev/holdout split for one shared skill, the metric = its `checker`, a dry run that only prints scores (no PR) | skills PR: eval harness + fixture split + the `skill.yaml` guard check | pick the pilot skill; OK to add `dspy` as a dev-only dependency; pick the tuning model tier |
| 3 | First tuning PR for the pilot skill, with the full gates | skills PR (held) | review the scores; "merge N" or close |
| 4 | Fixture mutation generator (SWE-smith idea) and the injection catalogue as part of the dev set | skills PR | none beyond merge |
| 5 | rag-pipeline: after T121 lands, a fake-fixture recall eval, then DSPy on the query-rewrite and chunk-header prompts | rag-pipeline PR | T121 go first |

## 7. Fit with Scout + REA Lab + Planner

- **Scout** found these ten. Under #382 the approved candidates become proposals: DSPy (dev-only code), and ideas from SWE-agent (trajectories), Aider (repo map), OpenEvolve (separate evaluator, resumable population) and SWE-smith (fixture mutation).
- **Planner** turns an approved proposal into draft tickets, e.g. "T-draft: skills tuning harness (DSPy dev-only)". Braden files them with "file T…".
- **The tuning loop is a builder job**, not a new team. It runs on the existing seats under the #383 cap and kill switch, and its only output is held PRs. The morning digest gets one more line: "tuning: N jobs, best gain, PRs waiting".
- **REA Lab** is not needed here. Everything above is open source with readable code. REA stays for our own builds (e.g. T124).
- **Restrictive parts stay out:** AutoGPT's `autogpt_platform/` is Polyform Shield, so ideas only, no code (#382).
