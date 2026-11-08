# T18 Orb voice — shared contract (agent-core + desktop-app)

Only the coordinator edits this file. Names here are fixed. Report any other cross-job name in `notes` as `crossJobName: <name>`.
Ticket: docs/TICKETS.md T18. Decisions #90 (mic ask in Get started, skip = ask on first press), #91 (OS built-in speech, on-device where supported, every transcription logged), #92 (tap to start, tap again or 2 s of silence to stop; the words fill the quick box; nothing is sent without Send).
Hard rules: the transcript text and the audio never go into a log, a file or the service. The Rig talks only to the local service over HTTP/WS (AGENTS.md).

## agent-core (job AC): the log route
- `POST /voice/transcribed`, with the same auth as every other route. JSON body, exactly these fields:
  `engine` (string, 1–40 chars, `^[a-z0-9._-]+$`), `on_device` (bool), `chars` (int, 0–100000), `duration_ms` (int, 0–600000).
  A missing field, a wrong type, an out-of-range value or any other field (for example `text`, `transcript`, `audio`) → 400 `{"error": "..."}`, and nothing is logged.
- On success it appends one action-log entry through the existing log writer: action `voice.transcribed`, actor the person, data `{engine, on_device, chars, duration_ms}`, no model, cost 0. It returns 200 `{"ok": true}`.
- Version 0.6.18 → 0.6.19 in every file that asserts it (pyproject.toml, src/anorak/__init__.py, src/anorak/local_service.py, tests/test_local_service.py x2, tests/test_service_cli.py, uv.lock line 7), plus a CHANGELOG entry.

## desktop-app, Rust shell (job SP, codex): speech bridge
Tauri commands (register them in lib.rs and allow them in capabilities orb.json, quick.json and main.json):
- `voice_permission() -> String`: one of `"granted" | "denied" | "undetermined" | "unsupported"`. It is granted only when BOTH microphone and speech recognition are authorized; denied if either is denied or restricted.
- `voice_request_permission() -> String`: asks the OS (microphone, then speech recognition) when undetermined, waits for the answers, and returns the same values as `voice_permission`.
- `voice_start() -> Result<(), String>`: errors are exactly `"denied"`, `"undetermined"`, `"unsupported"` or `"busy"` (already listening). It uses `SFSpeechRecognizer` with the system locale and sets `requiresOnDeviceRecognition = true` when `supportsOnDeviceRecognition` is true.
- `voice_stop() -> ()`: stops listening; it does nothing when not listening.
Events, emitted to every window:
- `voice-state` `{ "listening": bool }`, on each start and stop.
- `voice-transcript` `{ "text": String, "final": bool, "engine": "macos-speech", "onDevice": bool, "durationMs": u64 }`: partials carry `final: false`; exactly one `final: true` after every stop (its text may be empty).
Auto-stop: 2000 ms with no new partial after the first partial, or 60 s total. Put the timer rule in `logic.rs` as a pure fn `voice_should_stop(elapsed_ms: u64, ms_since_last_partial: Option<u64>) -> bool` with unit tests.
On non-macOS: `voice_permission` returns `"unsupported"` and `voice_start` returns `Err("unsupported")`. It must compile and pass `cargo test` on Windows (cfg-gate every macOS crate).
Info.plist: `src-tauri/Info.plist` with
`NSMicrophoneUsageDescription` = "OASIS listens only while you tap the voice button, to turn your words into text." and
`NSSpeechRecognitionUsageDescription` = "OASIS turns what you say into text on this Mac, only while you tap the voice button."
Pin every new crate to an exact version (`=x.y.z`).

## desktop-app, UI (job UI, sonnet)
- `serviceClient.logVoiceTranscribed({ engine, onDevice, chars, durationMs })` → `POST /voice/transcribed` with `{engine, on_device, chars, duration_ms}`. Never sends text.
- **Quick box** (src/quick/QuickApp.tsx + Composer): a mic button in the composer row. A tap toggles listening:
  - First it calls `voice_permission`: `undetermined` → `voice_request_permission`, and start only if that returns granted. `denied` → show the help line `Voice is off. Turn on Microphone and Speech Recognition for OASIS in System Settings > Privacy & Security.` and never start. `unsupported` → the mic button is hidden.
  - While listening, partial text shows in the draft after whatever was already typed. The final text replaces the partial, and the draft stays editable. Nothing is ever sent without the person pressing Send.
  - On each final with non-empty text it calls `logVoiceTranscribed` with `chars = text.length` (never the text). A failed log call is shown as nothing (no error to the person) but must not block the draft.
- **Orb** (src/orb/OrbApp.tsx): a voice button beside the chat button (same size, placed to the chat button's left with a 4 px gap, and never outside the frame). A tap calls `show_quick` and emits `voice-toggle` (no payload) to the quick window, which then does exactly what its own mic tap does. The orb listens to `voice-state` and shows the `working` look while `listening` is true (it combines with the existing localWorking: working if either is true).
- **Get started** (src/components/Onboarding.tsx): after the last question and before finishing, show one optional screen only when `voice_permission()` is `"undetermined"`: heading "Turn on voice", line "Talk to OASIS instead of typing. Your Mac will ask for the microphone next.", buttons "Turn on voice" (calls `voice_request_permission`, then continues whatever the answer) and "Skip" (continues). It is never shown in a second run (Get started only runs once, #70).
- CHANGELOG entry (the desktop-app version stays 0.1.0, as in past PRs).

## Mutation check (the coordinator runs it before the PR)
Auto-send the transcript; start listening while denied; skip the permission check; keep listening after stop; log the text; the orb ignores `voice-state`; the onboarding screen shows when already granted; the agent-core route accepts an extra field / logs on a 400. Each one must make a test fail.
