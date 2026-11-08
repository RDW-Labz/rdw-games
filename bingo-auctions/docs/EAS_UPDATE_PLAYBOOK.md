# EAS Update (OTA) Playbook

> Post-launch playbook for pushing JS-only updates to bidder-app + field-mobile
> users WITHOUT going through Apple or Google review. Companion to the
> heavyweight EAS Build workflow (`.github/workflows/eas-build.yml`).

## Decision tree: OTA vs new build

Use this BEFORE running the workflow. The wrong choice creates user-facing
problems (broken installs, stuck on old version, etc.).

```
Did you change ANY of these?
├── Native module added / removed / version-bumped (Podfile, build.gradle)  → NEW BUILD
├── New permission string in Info.plist or AndroidManifest.xml               → NEW BUILD
├── New entitlement (Associated Domains, Push, In-App Purchase, etc.)        → NEW BUILD
├── App icon, splash, name as it appears on home screen                      → NEW BUILD
├── runtimeVersion in app.config.ts bumped                                   → NEW BUILD
├── Anything in the `ios/` or `android/` native directories                  → NEW BUILD
└── Otherwise (JS code, JSX, styling, business logic, new screens
    using already-installed native modules, asset images inside JS)          → OTA OK
```

If unsure: **ship the new build.** OTAs are reversible (you can roll back to
a prior update on the EAS dashboard) but pushing OTA over a binary that
needs new native code creates a broken install.

## How to push an OTA

### Standard flow (most common — both apps, both channels)

1. Land your JS changes on `master` via a normal PR.
2. Go to https://github.com/jmacluer-design/auction-platform/actions/workflows/eas-update.yml
3. Click **Run workflow** → leave defaults (`app=both`, `branches=both`, blank message).
4. Wait ~3-5 min. Each job posts a summary with the EAS update ID.
5. Open the bidder-app or field-mobile binary on a real device. Within
   ~30 seconds of launch, it'll fetch the new bundle and reload.

CLI shortcut from a workstation with `gh` installed:

```powershell
cd C:\Users\jmacl\Projects\auction-platform
gh workflow run "EAS Update (OTA)" --ref master `
  --field app=both `
  --field branches=both `
  --field message="fix: typo in lot pickup confirmation copy"
```

### Canary flow (preview-only first)

When the change is risky (touching auction-engine flow, bid placement,
payment UI, etc.), push to `preview` first, verify on TestFlight, then
promote to `production`:

```powershell
# 1. Push to preview ONLY (TestFlight users)
gh workflow run "EAS Update (OTA)" --ref master `
  --field app=bidder `
  --field branches=preview `
  --field message="canary: refactor bid input"

# 2. Test on TestFlight (you + any internal testers)

# 3. Once verified, push to production (App Store users)
gh workflow run "EAS Update (OTA)" --ref master `
  --field app=bidder `
  --field branches=production `
  --field message="promote canary: refactor bid input"
```

### Dry-run

Use `dry_run=true` to log what would happen without actually pushing.
Useful when first wiring up the workflow or testing a new branch.

## Channel ↔ binary mapping (DO NOT FORGET)

Per the `eas.json` in each app (and per memory
`feedback_ota_both_branches.md`):

| Channel | Which installed binaries pick this up |
|---|---|
| `development` | `eas build --profile development` — Expo Go dev clients only |
| `preview` | `eas build --profile preview` — TestFlight + Play Internal |
| `production` | `eas build --profile production` — App Store + Play Production |

**The "both" default in the workflow** pushes to `preview` AND `production`.
That's the safe default once v1.0 is in the App Store, because:
- TestFlight users (you + internal testers) live on `preview`
- End users (after Apple approval) live on `production`
- Pushing only one means half your user base is on stale code

## Runtime version trap

Both apps use `runtimeVersion: { policy: 'appVersion' }` in `app.config.ts`.
This means:

- An OTA pushed today reaches devices running the same `version` string
  (e.g., `1.0.0`).
- When you bump `version` to `1.0.1`, OTAs for `1.0.0` STOP reaching the
  `1.0.1` binary. You must ship a new EAS Build for `1.0.1` first.
- This is intentional: it prevents shipping JS that depends on native code
  changes that aren't installed yet.

**Practical rule:** if you bump the version field, also do a new EAS Build,
and only push OTAs AFTER the new binary is in TestFlight/App Store.

## Rollback

Every OTA gets an ID + a publish time visible at:

- Bidder: https://expo.dev/accounts/rdw_cluer/projects/auction-platform-bidder/updates
- Staff:  https://expo.dev/accounts/rdw_cluer/projects/bidwizops-field/updates

To roll back, run another OTA from the prior commit (`gh workflow run` on
a previous SHA via the Run workflow UI's "Use workflow from" dropdown).

EAS also has `eas update:republish` for re-publishing a specific update ID
to a different channel — useful when promoting a known-good canary.

## What to do if an OTA breaks the app

Per memory `feedback_pull_real_telemetry_before_hypothesizing.md`: get real
crash logs first.

1. **Symptom**: users report a crash or white screen after the update.
2. **Immediate mitigation**: push an OTA from the prior good SHA. Same
   workflow, just change `--ref` to the prior commit (or use the Run
   workflow UI's branch selector).
3. **Anti-bricking**: app.config.ts already sets
   `updates.disableAntiBrickingMeasures: false` for production builds, so
   the OS-level rollback path stays alive. Users can force-reinstall to
   recover even if the OTA is unrecoverable.
4. **Diagnosis**: pull TestFlight crash logs via
   `scripts/fetch-testflight-crashlogs.mjs` — do NOT hypothesize from
   source code alone.

## When the workflow fails

| Failure | Likely cause | Fix |
|---|---|---|
| `eas whoami` returns error | `EXPO_TOKEN` secret missing or expired | Refresh at https://expo.dev/settings/access-tokens, update `EXPO_TOKEN` GHA secret |
| `EISDIR` or workspace dep not found | Monorepo upload glitch | Check `apps/<app>/eas.json` has `cli.requireCommit: true` (see PR #8 history) |
| Update succeeds but devices don't fetch | runtimeVersion mismatch | The installed binary's version is different from the OTA's runtimeVersion. Push a new EAS Build first. |
| `Failed to upload` on hermes step | Cloud bundler glitch | Re-run the workflow. EAS Cloud is occasionally flaky for hermesc; one retry usually clears it. |

## Future: auto-OTA on merge

When the team grows: consider auto-triggering this workflow on every push
to `master` that touches `apps/bidder-app/**` or `apps/field-mobile/**`
WITHOUT touching `apps/*/ios/**` or `apps/*/android/**` or `apps/*/app.config.ts`.

This is intentionally NOT wired today because:
- Solo founder + few engineers — manual dispatch is fine
- Auto-OTAs require strong CI test coverage on the mobile apps; the
  Maestro Smoke flow is the minimum bar
- Path filters are easy to get subtly wrong (e.g., a JS change that needs
  a native module — Path filter wouldn't catch the implicit dependency)

When ready, add `push: branches: [master]` with `paths:` filter to
eas-update.yml. The workflow_call interface is already set up to accept
parameters from a parent workflow, so a tagged-release workflow could
chain build → OTA in one go.

## Related docs

- `docs/SUBMISSION_PLAYBOOK.md` — Initial submission via `scripts/submit-*.mjs`
- `.github/workflows/eas-build.yml` — Full EAS Cloud builds (heavier, slower)
- `docs/state/STATUS.md` — Current build versions + deploy state
- Memory `feedback_ota_both_branches.md` — The 2026-05-22 incident that
  established the "always push to both channels" rule
- Memory `feedback_eas_update_wsl_arm.md` — Why local `eas update` is
  blocked on the user's Windows ARM box; OTAs must come via this workflow
