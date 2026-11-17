# Thrive — Judgment Report

- **Repo:** https://github.com/Revolutionary-Games/Thrive (cloned `--depth 1` @ `c9b1375`, pushed same day as review)
- **Stars:** 3,782 · **Open issues:** 540 · **License:** GPL-3.0-or-later (`LICENSE.txt`, clear + linking exception text) · **Language:** C# (~1,226 .cs files) · **Engine:** Godot 4.7 (`config/features = "4.7", "C#"`)

## 1. Game type & platforms
Evolution/simulation sandbox: single-cell microbe → multicellular → creature → tribal → society → space, with the editor, auto-evo and a full campaign ladder. Official platforms: **Windows, Linux, macOS only** (downloads page + `export_presets.cfg`: 7 presets — Linux ×2, Windows Desktop ×2, macOS ×2 — **zero Android/iOS/web presets**). `project.godot` has no mobile display/handheld settings; a single incidental touch reference exists in `src/engine/input/key_mapping/InputEventItem.cs` — no touch UI layer. (csproj has latent `net9.0-android`/`net8.0-ios` TFM conditions for Godot mobile tooling, but no mobile project or touch controls are wired up.)

## 2. Build log summary
Commands (this host, CachyOS):
1. `dotnet build Thrive.sln` (via installed `~/.dotnet` SDK 10; repo TFM is now `net10.0`) → **Build succeeded, 0 errors / 0 warnings** (incl. native `thrive_native` deps via `Scripts/native/build.py --configuration Release`; Linux .so produced).
2. `godot --headless --path . --import` — first pass threw 2743 ERROR lines, all "Image file is invalid … PNG: Failed to identify image" style: a shallow clone without LFS pull leaves **1,214 Git LFS pointer files**. Materialized every object via a batched media-api fetcher (`lfs_pull.py`, 403-fallback to per-oid URLs); after a wipe of the poisoned import cache, fresh import ran **exit 0** with the only remaining errors being `No loader found for resource: *.cs` — Arch's pacman `godot` 4.7.2-2.1 is a **non-mono build**, so it cannot load C# scripts.
3. Fetched official **Godot 4.7.1-stable mono** editor (no sudo needed) to supply the C# module.

Content on disk: ~853 MB real LFS art/audio, ~1.8 GB imported cache.

## 3. Runtime smoke evidence
`timeout 90 Godot_v4.7.1-stable_mono_linux.x86_64 --headless` (project dir, runs `MainMenu.tscn`):
```
Godot Engine v4.7.1.stable.mono.official.a13da4feb
This is Thrive version: 1.7.0.0-rc1+c9b1375ac6740e368595a772dc18b692a9998fe9
Detected system RAM (MiB) as: 124409 / Picked graphics preset: High
Set C# locale to: en-US ... TaskExecutor started with parallel job count: 16
Achievements data loaded / Jukebox now playing from: Menu
------------ Thrive Startup Succeeded ------------
```
0 ERROR / 0 script errors in the 665-line log; game ran to steady menu state until the 90 s timeout killed it. C# unit suite: `dotnet test test/code_tests` → **120/120 passed** (164 ms).

## 4. Mobile-optimization evidence
- No `android/`, `ios/`, or mobile export presets anywhere; docs never claim mobile support.
- No `InputEventScreenTouch`/touchscreen handling; gameplay is mouse+keyboard.
- Only mobile-adjacent traces: csproj android/ios TFM conditions (scripting layer compiles for mobile) and generic Godot stretch/DPI settings. Effectively desktop-only.

## 5. Score
| Criterion | Score | Why |
|---|---|---|
| Gameplay depth & polish | **28/30** | Multi-era evolution sim with editor + auto-evo, versioned 1.7.0-rc1, ~1 GB of curated content; genuinely AAA-grade open-source ambition |
| Mobile optimization | **1/25** | No Android/iOS project, no touch input, desktop-only presets; latent mobile TFMs only |
| Build health | **12/15** | C# sln + native lib build 0-error and import exit 0, but required LFS materialization (1,214 objects) and swapping to the official mono editor — heavy documented friction |
| Runtime smoke | **13/15** | Clean headless boot to menu, "Thrive Startup Succeeded", zero errors, 120/120 unit tests; headless-only (no rendered-frame check) |
| Code quality & activity | **13/15** | 1,226 well-organized C# files, clear GPL-3.0 + AUTHORS, commit same-day, 3.8k stars, in-repo tests; CI lives on a self-hosted devserver (invisible in `.github`) |
| **Total** | **67/100** | **Tier B** |

## 6. Verdict
One of the most ambitious real games in open source — compiles clean, boots clean, and passes its whole test suite — but this rubric's 25-point mobile axis nearly zeroes out: Thrive is proudly desktop-only, and its build additionally demands LFS pulls and a mono Godot editor. B-tier here only because desktop excellence is weighted against handheld uselessness.
