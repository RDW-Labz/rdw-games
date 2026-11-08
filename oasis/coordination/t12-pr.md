T12 adds the thin Rig — a Tauri 2 app that signs in via the agent-core service, chats over a WebSocket panel, connects data sources from the T11 catalog with plain-words flows, reads the activity log, and pauses the watcher. The orb is a small draggable always-on-top window, toggled by Ctrl+Space or click, showing glow state from the service status flag. Right-click menu offers pause, hide 1 hour, and open app. Background service registration and NSIS bundle config are wired; the signing pubkey is an explicit placeholder until Braden runs `tauri signer generate` (steps in `docs/rig.md`). Auto-update is configured to a test release endpoint.

The Rig expects agent-core to serve a small HTTP + WebSocket API (`docs/local-api.md`) for sign-in, chat, connector tiles, pause, and log path — no Python service exists yet. Both windows resolve the service's base URL from a well-known port file or default to 4405, call the service directly from the webview (no Rust proxy), and poll status every few seconds. The orb's right-click menu is an in-window popup for testability, covered end-to-end by `tests/Orb.test.tsx`. `tests/fakeService.ts` implements the contract; `npm run dev:fake-service` for manual runs. All screens and interactions are exercised by vitest suites against the fake service.

Validation:
```
npm run lint        → clean
npm test            → Tests 20 passed (20), 7 files
npm run typecheck   → clean
npm run build       → ok (dist/index.html + dist/orb.html)
cargo fmt --all --check                              → clean
cargo clippy --locked --all-targets -- -D warnings   → 0 warnings
cargo test --locked                                  → 14 passed; 0 failed
npm run tauri build -- --no-bundle                   → built (worker run, macOS)
```

Pending on a real Windows machine: Installing from a signed `.exe`/`.msi`, orb rendering above every window, hotkey collision, and app self-update from a signed release (blocked on Braden running `tauri signer generate` and publishing a real release). Connect Gmail end to end also waits for the real agent-core service. This macOS worktree cannot verify Windows-specific behavior; all automated checks pass. Dependencies are exact-pinned Tauri 2 plugins (global-shortcut 2.3.2, opener 2.5.5, updater 2.12.0, process 2.3.1, fs 2.5.2) and matching JS packages; dev-only ws, @types/ws, tsx. Background-service-at-login registration and Mac signed installer are deferred — no Python binary to register, and scaffold only. Base branch main (T01).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
