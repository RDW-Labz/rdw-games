# Worker prompt skills to adopt

Source: `addyosmani/agent-skills`, MIT, commit `1be8e34` (Copyright (c) Addy Osmani).
These are for project-swarm worker prompts only, not the OASIS product.

## Picks

### context-engineering
- Prompt addition: Read the ticket, task context, and relevant local rules before editing. State the done-when and key limits in a short preflight.
- Failure targeted: Workers skip context and miss scope or project rules.
- Lives at: `coordination/skills/context-engineering/SKILL.md` (<800 tokens).
- Adopt mode: Rewrite idea.

### test-driven-development
- Prompt addition: Add or update a focused test with the code change. Report only commands actually run and their observed result; mark skipped checks as not run.
- Failure targeted: Missing tests and overclaimed test results.
- Lives at: `coordination/skills/test-driven-development/SKILL.md` (<800 tokens).
- Adopt mode: Rewrite idea.

### code-review-and-quality
- Prompt addition: Review the diff against the ticket, tests, and allowed files before returning. Check Windows behavior, including CRLF, long paths, and `ctypes` cases where relevant.
- Failure targeted: Scope leaks, missed regressions, and Windows-only breakage.
- Lives at: `coordination/skills/code-review-and-quality/SKILL.md` (<800 tokens).
- Adopt mode: Rewrite idea.

### incremental-implementation
- Prompt addition: Make the smallest complete change for the bounded task and keep one writer per file. Stop at the ticket's done-when; return the required capped JSON.
- Failure targeted: Workers expand scope or conflict on shared files.
- Lives at: `coordination/skills/incremental-implementation/SKILL.md` (<800 tokens).
- Adopt mode: Rewrite idea.

Do not adopt interview-me or idea-refine: worker jobs already have bounded tickets, so user interviews add delay. Do not adopt frontend-ui-engineering as a default: most worker jobs are not UI work; invoke a focused UI guide only when a ticket calls for it.
