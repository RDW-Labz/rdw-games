# T12b companion: authenticate the Rig client

Branch: `codex/t12b-rig-auth`  
Base: `main`  
Repository: `desktop-app`

## Problem and result

The Rig client currently reaches the local service without authentication. This narrow companion updates the native token boundary, HTTP client, WebSocket client, fake service, tests, and local API contract while keeping every endpoint path and JSON payload unchanged. It uses the existing `SecretStore` entry `rig.service_token` in OS-keychain service `OASIS`; HTTP sends `Authorization: Bearer <token>`, and browser WebSockets use `Sec-WebSocket-Protocol` protocols `["bearer", token]`. Tokens never appear in URLs, logs, errors, fixtures, or responses.

## Validation

Pending worker completion and coordinator rerun:

```text
npm ci
npm test
npm run lint
npm run typecheck
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked
npm run tauri build -- --no-bundle
git diff --check
```

This PR is the approved desktop companion to the agent-core T12b PR. Windows installation, live keychain use, and live provider flows remain human checks.
