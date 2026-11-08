# packlive: live evidence (blank More motion cards, orb never switches)

- Date: 2026-09-30 (probe 17:10Z-17:20Z)
- Rig: agent-core e75b3eb (0.7.47), live pid 61301, http://127.0.0.1:4405 (never stopped or signalled)
- App: /Applications/OASIS.app, desktop-app a862fbd (pid 54416, never touched)
- Method: I replayed the client's own requests with curl, using the app's keychain token (read-only, never printed or stored) and `Origin: tauri://localhost`, the macOS webview origin. Service reads (`avatars_list`, `avatar_get`, `avatar_thumb`, `avatar_manifest`, `avatar_sheet`) are in `UNLOGGED_READ_OPERATIONS`, so the drawer `log.jsonl` has only the picks: `avatar_set` fantasy-03 at 16:57:43Z and fantasy-03/-06/-09 at 16:58:42-44Z, so Braden's clicks did reach the service and were saved. I read only the action/outcome fields.

## Requests the Coworkers page and the orb make (live responses)

| Caller | Method + path | Status | Content-Type | Size | Fields / what the client expects |
|---|---|---|---|---|---|
| Coworkers | GET /avatars | 200 | application/json; charset=utf-8 | 1876 B | `{avatars:[{id,name,artist,source,dev,installed,version,preview,category,tier}]}`: 10 rows, 8 More motion rows `source:bundled, installed:true, preview:true, tier:animated`. Matches `parseAvatarInfo`. |
| Coworkers, orb | GET /avatar | 200 | application/json; charset=utf-8 | 40 B | `{id, tier}`. The client reads `id`. |
| Coworkers | POST /avatars/refresh `{}` | 503 | application/json | 42 B | `{"error":"avatar library not set up yet"}`. The page keeps the list (only a 502 shows a note). Not the bug. |
| Coworkers | GET /themes, GET /theme, POST /themes/refresh | 200 / 200 / 503 | application/json | 179 / 17 / 41 B | Lantern only. Not the bug. |
| Coworkers card | GET /avatars/{id}/thumb.png (x8) | 200 | image/png (+ nosniff, ACAO tauri://localhost) | 2268-3893 B, 128x128 | `requestBlob` wants exactly `image/png`, at most 32768 B. Passes. |
| Orb | GET /avatars/fantasy-03/manifest.yaml | 200 | text/yaml; charset=utf-8 | 1329 B | Grid 12 columns x 12 rows, fps 6. Passes the 16384 B cap and `validateAvatarPack`. |
| Orb | GET /avatars/fantasy-03/sheet.png | 200 | image/png | 372710 B, 1536x1536 RGBA | Equals 128*columns x 128*rows and is under the 2 MiB cap. |
| Pick | PUT /avatar `{"id"}` | 200 | application/json | 40 B | `{id, tier}`. The client reads `id`, then emits Tauri `avatar-changed`. |
| (Beacon) | GET /avatars/beacon/thumb.png | 404 | application/json | 44 B | `this pack is built into the app`. The app uses its own asset. |

Every CORS response carries `Access-Control-Allow-Origin: tauri://localhost`. **The service side is correct.**

## Where it breaks: the webview's CSP

- The client turns every served PNG into `URL.createObjectURL(blob)`, a `blob:` URL (useCoworkers.ts for the card, avatarEngine.ts `servicePackLoader` for the orb).
- The shipped CSP, from `strings` on the installed binary: `img-src 'self' data:`. There is no `blob:`, and CSP3 never lets `'self'` match `blob:`.
- A real WebKit check (`webkit-csp-harness/`): a WKWebView on a `tauri://` custom scheme sending the same CSP as a header, fed the real bytes captured above:
  - Installed CSP: `securitypolicyviolation img-src blob`, `<img>.onerror`, `img.decode()` rejects `EncodingError`. The same bytes as `data:` load (128x128 and 1536x1536).
  - With `img-src 'self' data: blob:`: `blob:` loads and decodes (128x128, 1536x1536).
  - `blob:` only in `default-src`, or only in `connect-src`: still refused, because `img-src` overrides.
- The fixed build (`desktop-target-s58/release/oasis-rig`, not installed) embeds `img-src 'self' data: blob:`. I launched it for about 10 s and then stopped it. No screenshot: this session has no Screen Recording permission, so captures show only the wallpaper.

## Root cause (three lines)

1. The service returns every pack route 200 with the right types, sizes and fields. Picks save.
2. The desktop shows each served PNG through a `blob:` URL, but the app's CSP was `img-src 'self' data:`, so WebKit refuses it: the card stays blank, `img.decode()` rejects, the orb loader returns null and the orb keeps its old pack.
3. jsdom has no CSP and the fixture tests stub `createObjectURL`, so desktop-app#59 and agent-core#85 passed without ever loading an image the way WebKit does.

## Fix

- desktop-app `src-tauri/tauri.conf.json`: `img-src 'self' data: blob:` (one token). Commit b8165c8 on packs-live-fix. Needs a rebuild and reinstall of OASIS.app. Adding `blob:` only permits object URLs the app's own JS creates, and `data:` was already allowed.
- desktop-app `tests/livePacksCsp.test.tsx`: replays the captured responses (`tests/fixtures/live-2026-09-30/responses.json`, captured 2026-09-30 from rig e75b3eb) through the real `createServiceClient`, renders Coworkers, runs the orb's `servicePackLoader` + `AvatarEngine` with a WebKit-like `Image` whose `decode()` rejects when the shipped CSP refuses the URL, and decodes the real sheet for `validateAvatarPack`. Fails 3/3 on a862fbd's CSP and passes with the fix.
- agent-core `tests/test_avatar_bundled_live_routes.py`: the real aiohttp app with a real `AvatarLibrary` on the real vendored `garage/avatars/packs` (all 8), no monkeypatching, and outbound network asserted empty. It checks every desktop path, the `tauri://localhost` CORS, content types, byte caps, row fields, sheet size and PUT/GET `{id, tier:"animated"}`. Commit 1c95f32 (test-only; the service needed no change).

## Checks

- desktop-app: vitest 67 files / 1325 passed. `tsc --noEmit` clean. eslint 0 errors (1 existing warning in a file this change doesn't touch).
- agent-core: pytest 3043 passed, 5 skipped, 1 deselected. ruff clean. `mypy --strict src` clean (62 files).
