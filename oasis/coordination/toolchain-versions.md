# Isolated toolchain versions (decision #249)

No system Node or brew change. Everything lives under `~/.project-swarm/toolchains` or the orb clone.

| Tool | Version | Where | Provenance | Installed |
|---|---|---|---|---|
| Node.js | v24.21.0 (LTS "Krypton", released 2026-09-07), npm 11.19.0 | `toolchains/node/node-v24.21.0-darwin-arm64`, symlink `toolchains/node/current` (deliberately **not** in `toolchains/bin`, so PATH-prefixed swarm checks keep the system Node 20) | nodejs.org/dist tarball, SHA-256 bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057, checked against SHASUMS256.txt | 2026-09-28 s47 |
| orb npm deps | 100 packages from orb's package-lock (orb cd326a1; playwright 1.63.0, @modelcontextprotocol/sdk 1.30.1, pdfjs-dist 6.3.289, three 0.186.1) | `~/Documents/repos-projects/orb/node_modules` (gitignored) | `npm ci --ignore-scripts`, cache `toolchains/npm-cache` | 2026-09-28 s47 |
| Playwright Chromium | chromium-1243 + Chrome Headless Shell 153.0.8010.12 (chromium_headless_shell-1243), ffmpeg-1011 | `toolchains/ms-playwright` (`PLAYWRIGHT_BROWSERS_PATH`) | `playwright install chromium` (playwright 1.63.0) | 2026-09-28 s47 |

Use: `PATH=~/.project-swarm/toolchains/node/current/bin:$PATH PLAYWRIGHT_BROWSERS_PATH=~/.project-swarm/toolchains/ms-playwright npm_config_cache=~/.project-swarm/toolchains/npm-cache`.
| Playwright (s55, Braden: copy in, #249 scope) | `playwright` 1.63.0 + `playwright-core` 1.63.0 (only dependency), copied from the orb clone's node_modules (orb cd326a1) with `cp -Rp`, no network. Tree sha256 (sorted per-file shasum, then shasum): playwright `1a4cde0dac5b3b5e42c51b4fb1078a482b1cc3475c9edfb37994eeb7d99458c3`, playwright-core `66522009c4a4af1f7e612148b1a04577169220592928762564a2e443bc531eca` (both match the source). Pins chromium 1243 / 153.0.8010.12 = the installed ms-playwright; real launch of both chromium and headless shell verified 2026-09-29. | `toolchains/node_modules/{playwright,playwright-core}` | `require` via `createRequire(<toolchains>/node_modules/)` + `PLAYWRIGHT_BROWSERS_PATH=<toolchains>/ms-playwright` |
