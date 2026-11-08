---
name: desktop-design-check
description: Pre-review checklist for desktop-app UI tickets — run before asking Braden to look. Checklist only, no automated hooks or third-party engine binary.
paths:
  - "repos/desktop-app/src/**"
  - "worktrees/desktop-app-*/src/**"
checks:
  resultKeys:
    - status
    - checklistPassed
    - screenshots
---
# Desktop Design Check

Run this checklist on every desktop-app UI ticket before it goes to Braden
for approval. It's a manual/visual checklist — no design-tool hook, no
third-party rendering engine binary, no install step. Look at the running
app or screenshots and answer each item.

## Checklist

1. **Hierarchy** — one clear focal element per view? Size, weight, and
   position show what matters most, before color does?
2. **Spacing rhythm** — consistent spacing scale, not one-off pixel values
   scattered per element? Related elements grouped closer than unrelated
   ones?
3. **Contrast (AA)** — body text meets 4.5:1 contrast against its
   background, in both dark and light mode? Non-text UI (icons, borders,
   focus rings) meets 3:1?
4. **One primary action per view** — exactly one button/action visually
   dominant? Secondary actions are visually secondary, not competing for
   attention.
5. **States covered** — does the view have a designed empty state, loading
   state, error state, and a decided/success state? Not just the happy
   path with data already loaded.
6. **Plain words** — labels, buttons, and error messages use plain,
   specific words a non-technical end user understands. No jargon, no
   internal-only terms leaking into UI copy.
7. **Dark + light** — checked in both themes, not just the one the ticket
   screenshot showed.
8. **No hooks, no engine binary** — the change doesn't wire in a
   design-tool hook, telemetry call, or third-party rendering engine
   binary to do this check. This is a human-eyes checklist, not a new
   dependency.

## Process

Run through all eight items. For each: pass, fail (with the specific
location), or n/a (with why). Take screenshots of the view in both light
and dark mode as evidence. Only pass the ticket to Braden once every
applicable item passes or has an explicit, justified n/a.

## Report

`checklistPassed`: true only if all eight items pass or are justifiably
n/a. `screenshots`: paths to the light/dark captures taken. `status`:
"ready-for-braden" or "needs-work" with the failing items named.
