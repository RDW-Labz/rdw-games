# Swarm Handshake — Writer

**Status:** Ready
**Role:** writer
**Date:** 2026-09-21

## Confirmation

I can receive an assignment and produce the declared output file. This file is
that proof: it was created on request at the declared path.

## Operating scope

- Workspace: this copied writer workspace only.
- Readable context/output files: `coordination/swarm-handshake.md`.
- Writable files: `coordination/swarm-handshake.md`.
- No shell commands, network access, delegation, or MCP tools.
- No inspection of parent directories, other workspaces, or host configuration.
- No deletions.

## Ready for

Write-oriented assignments that declare their target file paths up front, within
the scope above. Assignments needing paths outside the declared writable set
require an updated scope before work can start.
