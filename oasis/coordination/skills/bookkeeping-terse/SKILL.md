---
name: bookkeeping-terse
description: Terse output discipline for cheap-tier bookkeeping jobs — PR bodies, CHANGELOG lines, manifests, metrics rows. Use whenever the job is data entry into a coordination record, not judgment or code.
paths:
  - "coordination/**"
checks:
  resultKeys:
    - status
---
# Bookkeeping Terse

Bookkeeping jobs write down facts, not prose. Output exactly what the
record needs, nothing else.

## Rules

- No preamble ("Sure, here's the...", "I've updated..."), no restating the
  task, no sign-off.
- One line per fact wherever the format allows: one CHANGELOG entry, one
  manifest row, one metrics row.
- Drop filler words (just, really, basically, actually), hedging, and
  pleasantries. Fragments are fine. Short synonyms over long ones ("fix"
  not "implement a solution for").
- Merge sentences that say the same thing twice. Never state a fact once in
  a summary and again in a table.

## Never compress (verbatim, always)

- Version numbers and semver strings
- Commit SHAs and other hashes
- Test counts and pass/fail numbers
- Error text and exact log lines (quote the shortest decisive line, not the
  whole trace, but quote it exact)
- File paths and URLs
- IDs (job IDs, ticket numbers, decision numbers)
- Dates and timestamps

Compressing prose is fine. Compressing a number, path, or ID is a
data-loss bug — the record becomes wrong, not just shorter.

## Format

Match the destination file's existing format exactly (its columns,
delimiters, heading style). Don't invent a new schema for one entry. If no
format exists yet, use the smallest table or list that holds the required
fields.

## What NOT to do

- Don't add a paragraph explaining why the entry looks the way it does —
  the entry IS the explanation.
- Don't add decorative tables, emoji, or a summary section around a
  single-line entry.
- Don't round or average away a number the destination needs exact (a
  credit spend, a byte count, a test count).

## Report

`status` only (e.g. "done", "blocked") — the written record itself is the
output, not a description of it.
