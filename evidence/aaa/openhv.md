# OpenHV — build, smoke-test & rubric judgment

- **Repo:** https://github.com/OpenHV/OpenHV @ HEAD (`089365a`, 2026-10-20, shallow clone `--depth 1 --single-branch`)
- **Genre record:** sci-fi pixel RTS (Dune-like — voxel-rendered pixel sprites, base-building + harvest + combat)
- **Stack:** C# / .NET 9 on the **OpenRA engine** (pinned `6bf1f6f2`), Makefile-driven — **not** the libGDX/Gradle stack the task brief assumed (see §2)
- **License:** GPL-3.0 (code) + CC-BY-SA-4.0 (assets) — clear · **Stars:** 1,087 · **Forks:** 67 · **Pushed:** 2026-10-20 (3 days ago) · **Contributors:** ~23 · **Open issues:** 65
- **Official platforms:** Windows / macOS / Linux desktop only (see `packaging/{windows,macos,linux}`). **No Android, no iOS, no web target anywhere in the repo** — the "Android client official" claim in the brief is false for this project.

## 1. Build — OK (with a network workaround)

Documented SDK flow (`docs/Building.md` / `fetch-engine.sh` + `Makefile`), JDK not used at all (this is .NET, not Java; `JAVA_HOME=~/tools/jdk21` irrelevant):

1. `dotnet-sdk 10.0.100` installed to `~/.dotnet` (needed for the pinned `net10.0` TFMs).
2. `./fetch-engine.sh` — the GitHub zip download for the pinned engine commit stalled on this host's network (≈80 KB/s, 24 MB in 5 min). **Workaround:** shallow git fetch of the exact pinned SHA:
   `git init engine && git fetch --depth 1 origin 6bf1f6f2dba1...` + stamp `engine/VERSION`.
3. `cd engine && make TARGETPLATFORM=linux-x64 all` → **Build succeeded, 0 errors** (one transient NuGet retry on SDL2-CS; self-healed). `engine/bin` = 28 MB output, engine tree 142 MB.
4. Repo root: `dotnet build OpenHV.slnx -c Release -p:TargetPlatform=linux-x64` → **Build succeeded, 0 errors** (`OpenHV.Game`, Lua `mods/hv` scripts compile included).

Clone size: OpenHV repo itself **228 MB** shallow (assets bundled — no LFS smudge needed); full workdir with engine **371 MB**.

## 2. Stack-mismatch note (brief vs reality)

Brief said "libGDX game, `./gradlew :game:desktop:build`, Android module in `android/`". Reality: **no `settings.gradle`, no `gradlew`, no `android/` directory exist** — this is a C# OpenRA-engine game with a Makefile. The equivalent targets were executed (see §1); Android build is **n/a** — there is no Android project to build, so it could not "fail on SDK components"; it simply doesn't exist.

## 3. Runtime smoke — OK on all surfaces

1. **Static validation:** `./utility.sh --check-yaml` → exit 0 across all rules, sequences and **69 maps** (MiniYAML schema-valid).
2. **Dedicated headless server:** `./launch-dedicated.sh` → boots fully headless; log: `Engine version is 6bf1f6f2...`, `Master server communication established.`; process persisted, **TCP connect to :1234 succeeded** (`TCP_HANDSHAKE_OK`) — lobby listener live.
3. **GUI client under Xvfb:** `xvfb-run -a ./launch-game.sh` → alive 65s+ (killed, no crash):
   ```
   Using SDL 2.32.10 with OpenGL (Modern) renderer
   OpenGL renderer: llvmpipe (LLVM 23.1.1, 256 bits)
   OpenGL version: 4.6 (Core Profile) Mesa 26.2.4
   ```
   Screenshots (`import -window root`, 1280x720): **16,493 / 28,857 distinct colors, 98% non-black** between t=40s and t=65s — a rendered, animating menu UI (dark-gray panels + olive-green accents), not a blank X root. (Vision-analysis service was down this session; pixel stats + GL context + survival are the grounding.)

## 4. Mobile-optimization evidence — NONE

- No `android/`, no iOS project, no mobile CI job (`ci.yml`, `packaging.yml` target win/mac/linux only).
- No touch/DPI handling: `grep -ril 'touch'` across engine + mod hits only unrelated strings (voice names, Shroud comments).
- OpenRA upstream has no mobile port and no touch UI layer; screen scaling exists for desktop HiDPI only.
- Offline play trivially yes (desktop LAN/internet RTS), but thumb-input play is impossible.

## 5. Content & quality

- 3 single-player campaigns (`Introduction`, `Yuruki`, `Synapol` in `missions.yaml`) + 69 bundled maps + mapgen, encyclopedia, active multiplayer (master server live), Lua scripted campaign engine, 19 rules files with full unit/building tree across factions.
- CI: `ci.yml` + `documentation.yml` + `packaging.yml` (release installers). Clean SDK/mod separation, upstream-pinned engine.

## 6. Score breakdown

| Category | Score | Why |
|---|---|---|
| Gameplay depth & polish | 25/30 | Real Dune-like RTS: campaigns, big unit tree, live MP community, recent polish commits |
| Mobile optimization | 0/25 | Zero mobile surface — no Android/iOS project, no touch input, no DPI/touch UI |
| Build health | 13/15 | Builds clean from docs; zip-fetch needed a git-shallow workaround on this network |
| Runtime smoke | 14/15 | GUI renders under Xvfb, headless server live + TCP probe OK, full YAML/map validation |
| Code quality & activity | 13/15 | GPL-3.0, CI, 3-day-fresh commits, ~23 contributors, clean engine/mod split |
| **Total** | **65** | **Tier B** |

## 7. Verdict

A genuinely deep, actively developed Dune-like RTS that builds clean on this machine and verifiably runs (GL-4.6 client under Xvfb + lobby-ready dedicated server + full rules/map validation) — but it is desktop-only C#/OpenRA with zero mobile surface, so the brief's "official Android client" premise is simply wrong and its mobile score is a hard zero.
