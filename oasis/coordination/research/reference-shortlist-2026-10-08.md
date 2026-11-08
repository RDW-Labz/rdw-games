# Reference repo shortlist (s88, 2026-10-08) — study only, nothing installed or run
Pins: impeccable 778c8a7b7 (Apache-2.0), superpowers 8ca22db (MIT), agent-skills 1401c8b (MIT), ponytail 9cc65d0 (MIT), awesome-claude-skills be2a406 (no top LICENSE; per-skill), archify bb990b1 (MIT), ui-ux-pro-max 1a2c459 (MIT), graphify 6478eb7 (Apache-2.0+MIT).
Hidden-unicode / long-comment / long-line scan of all 958 SKILL.md: 0 hits.
Config-touching mechanisms (opt-in, disclosed, NOT to adopt): impeccable launcher downloads a release binary (sha256-checked) + `hooks on` writes .claude/settings.local.json etc.; superpowers SessionStart hook injects its meta-skill; ponytail SessionStart hook edits ~/.claude/settings.json (statusLine) + injects rules; agent-skills optional curl cache hooks; graphify install edits CLAUDE.md/AGENTS.md + git hooks.
Shortlist (ideas, own words; no files copied):
1. impeccable craft-floor.md:24-45 + colorize.md:27-59 → "banned patterns" + role-based colour/contrast rules in oasis-design SKILL.md. Apache-2.0 if verbatim → paraphrase. Risk low, effort S.
2. superpowers verification-before-completion SKILL.md:13-30 → worker prompt boilerplate + integrate refuses a claimed check without its output. MIT. Risk low, S.
3. agent-skills constraint-driven-development SKILL.md ~95-230 + references/floor-guard.md → diff "floor guard" in swarm integrate (new skip/ignore/stub/lowered threshold = flag). MIT. Risk medium, M.
4. superpowers subagent-driven-development SKILL.md:50-70 → fix-round cap + escalation ladder for blocked jobs. MIT. Risk medium, M.
5. agent-skills context-engineering SKILL.md → trust tiers for loaded files + task-critical content last in job prompts. MIT. Risk low, S.
