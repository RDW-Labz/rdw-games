# Sound shortlist for OASIS (2026-09-28)

Source: t54.json (scout-1790630067887-a87ee218), license pages re-checked 2026-09-28.

| Pick | License | Pin | Size | What it's for | Link | Catch |
|------|---------|-----|------|---------------|------|-------|
| Kenney: UI Audio | CC0 1.0 | current pack | unknown | 50 UI effects (clicks, tones) for orb cues | [kenney.nl/assets/ui-audio](https://kenney.nl/assets/ui-audio) | Delivered as WAV; re-encode to M4A for WKWebView |
| Pixabay: Cinematic Logo (161456) | Pixabay Content License | 2023-08-10 | unknown | 10s cinematic base for 8s/2s splash cuts | [pixabay.com/sound-effects/musical-cinematic-logo-161456/](https://pixabay.com/sound-effects/musical-cinematic-logo-161456/) | No standalone redistribution; bundled in app is permitted |
| OpenGameArt: UI Sound Effects | CC0 | current pack | unknown | Chime/notification styles for needs-you alert | [opengameart.org/content/ui-sound-effects-button-clicks-user-feedback-notifications](https://opengameart.org/content/ui-sound-effects-button-clicks-user-feedback-notifications) | Zip of many files; extract and audition |
| Freesound: Orchestral Hit (559391) | CC0 1.0 | sound id 559391 | unknown | 4s orchestral hit for splash score accent | [freesound.org/people/Rizzard/sounds/559391/](https://freesound.org/people/Rizzard/sounds/559391/) | Requires free Freesound account to download |
| OpenGameArt: 100 CC0 SFX | CC0 | current pack | unknown | Fallback bell/gong/hit sounds (broad grab-bag) | [opengameart.org/content/100-cc0-sfx](https://opengameart.org/content/100-cc0-sfx) | Requires sifting through irrelevant content |

## Bundling rules

> Orchestrator note: the format and loudness bullets have no source link, and "WebView2 = WKWebView coverage" is doubtful (WebView2 is Chromium and plays Ogg/Opus). Check both before T31 audio lands.

- **CC0 files** ship freely inside desktop app bundles with no attribution requirement ([creativecommons.org/publicdomain/zero/1.0/](https://creativecommons.org/publicdomain/zero/1.0/))
- **Pixabay Content License** prohibits standalone redistribution but permits bundling as app asset ([pixabay.com/service/license-summary/](https://pixabay.com/service/license-summary/))
- **macOS WKWebView** supports WAV, M4A (AAC); OGG/Opus requires re-encoding
- **Windows WebView2** supports WAV, M4A (AAC); equivalent to WKWebView format coverage
- **UI sounds loudness target**: -20 dB LUFS (short feedback sounds)
- **Splash/cinematic loudness target**: -16 dB LUFS (opening cinematic cue)
- **Bundle location**: `assets/audio/ui/` for UI sounds, `assets/audio/splash/` for score/stings
- **Attribution**: Place CC0/Pixabay credits in `CREDITS.md` at repository root; no in-app attribution needed

## Rejected

- Zapsplat: Free tier requires in-app attribution; premium needed for attribution-free use
- SilverIllusionist "Cinematic Stings": Explicit per-sound credit requirement
- Kevin MacLeod / Incompetech: CC BY mandatory attribution trap
- AudioJungle: Paid marketplace
- Storyblocks: Subscription-only access
- Pond5: Paid royalty-free marketplace

## CREDITS.md drafts

- Kenney: UI Audio | https://kenney.nl/assets/ui-audio | CC0 1.0 | 2026-09-28
- Pixabay: Cinematic Logo (161456) | https://pixabay.com/sound-effects/musical-cinematic-logo-161456/ | Pixabay Content License | 2026-09-28
- OpenGameArt: UI Sound Effects | https://opengameart.org/content/ui-sound-effects-button-clicks-user-feedback-notifications | CC0 | 2026-09-28
- Freesound: Orchestral Hit (559391) | https://freesound.org/people/Rizzard/sounds/559391/ | CC0 1.0 | 2026-09-28
- OpenGameArt: 100 CC0 SFX | https://opengameart.org/content/100-cc0-sfx | CC0 | 2026-09-28

## Top 3

- **Kenney UI Audio** — cleanest CC0 fit for all four orb cues in one small pack
- **Pixabay 'Cinematic Logo'** — best ready-made base for the 8s/2s splash score cuts, no login barrier
- **OpenGameArt 'UI Sound Effects'** — best-targeted CC0 source for the needs-you chime
