# Reference files (T26 input)

Read-only inputs for the avatar generator (docs/TICKETS.md T26, decision #89). Not shipped, not imported.

- `beacon_v2.py` — the one-off pixel pass that drew Beacon (pack one, decision #75), run with Pillow.
- `make_sheet.py` — the contact-sheet script used for the six Higgsfield candidates.
- `avatarPack.ts` — the Rig's pack validator (desktop-app `src/orb/avatarPack.ts` at e6c98bb); the Python validator must apply the same rules.
- `../../beacon/` — the shipped Beacon pack (`manifest.yaml`, `sheet.png`) and the Higgsfield candidate it was drawn from (`candidate.png`).
