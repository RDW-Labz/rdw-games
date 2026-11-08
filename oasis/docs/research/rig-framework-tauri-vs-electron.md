# Rig framework: Tauri 2 vs Electron — do we need anything Electron-only?

Date: 2026-09-21. Decision #13 picked Tauri 2 and said "switch to Electron only if Phase 0 finds a blocker." This checks the Rig's actual needs against what Tauri 2 ships today.

## Short answer

No. Nothing the Rig needs exists only in Electron. Every feature the plan asks for is an official Tauri 2 plugin or a documented window option. Two things need a known workaround (click-through orb, WebView2 on clean Windows 10). Stay on Tauri.

## Feature by feature

| Rig needs (from PLAN.md "The Rig") | Tauri 2 | Electron | Verdict |
|---|---|---|---|
| Orb: small always-on-top window | Window option `alwaysOnTop`; overlay builders report it works in production, no z-order glitches | Yes | Tie |
| Orb: transparent, no frame, draggable | `transparent: true`, `decorations: false`, drag region in HTML. Mac needs `macOSPrivateApi: true` (blocks Mac App Store, which we do not use) | Yes | Tie |
| Orb: click-through on empty pixels | No per-region hit test. Workaround: Rust loop polls cursor ~60 fps and toggles `setIgnoreCursorEvents`. One overlay author reports it as cheap and fine | Same problem; same workaround with `setIgnoreMouseEvents({forward:true})` | Tie (both need the trick) |
| Global hotkey (Ctrl+Space) | `global-shortcut` plugin | `globalShortcut` | Tie |
| Start at login | `autostart` plugin | `app.setLoginItemSettings` | Tie |
| One instance only | `single-instance` plugin | `requestSingleInstanceLock` | Tie |
| Tray icon + right-click menu | Built into core (`TrayIcon`) | `Tray` | Tie |
| Notifications | `notification` plugin | `Notification` | Tie |
| Side panel + full app windows | Multi-window core; `window-state` and `positioner` plugins | Yes | Tie |
| Talk to the Python service | Local HTTP/WebSocket; `shell` plugin sidecar can bundle and launch a PyInstaller binary | `child_process` | Tie |
| Auto-update, silent | `updater` plugin: MSI and NSIS, `passive`/`quiet` modes, GitHub Releases as feed, mandatory signature check | electron-updater | Tie. Tauri's mandatory signing is a plus for us |
| Signed Windows installer | MSI (WiX) and NSIS, code signing documented, EV cert supported | Yes | Tie |
| Browser extension link | Chrome/Edge Native Messaging talks to any local executable. Our host is the Python service, not the shell | Same | Tie. Framework-independent |
| Screen control, watcher, files | Done by the Python service (UI Automation, mitmproxy, mss), not the shell | Same | Not a framework question |
| Memory footprint, always-on | ~14 MB RAM, <1% CPU idle reported for a comparable overlay | 200–300 MB before the app does anything | Tauri wins clearly |
| Install size | Few MB | 100+ MB | Tauri wins |

## What Electron does have that Tauri does not (and why we do not need it)

- **Bundled Chromium, identical on every machine.** Tauri uses the OS WebView (WebView2 on Windows, WebKit on Mac). Our UI is simple panels and chat; no exotic web APIs. Not needed.
- **Loading Chrome extensions inside the app.** We run the extension in the person's real browser, not inside the Rig. Not needed.
- **`desktopCapturer` for screen recording in-app.** The watcher captures via the Python service. Not needed.
- **Larger ecosystem of ready-made pieces.** Real, but every piece we need is on the official Tauri plugin list.

## Gotchas to build into T12

1. **WebView2 on clean Windows 10.** Use the NSIS installer with the WebView2 bootstrapper embedded (`webviewInstallMode: embedBootstrapper` or `offlineInstaller`), not `downloadBootstrapper`. Test on a clean VM.
2. **Click-through orb.** Implement the cursor-poll toggle in Rust from the start; do not design the orb as a large transparent sheet.
3. **Mac transparency** needs `macOSPrivateApi: true`; set `ActivationPolicy::Accessory` so the orb hides from Dock and Cmd+Tab. Avoid `backdrop-filter: blur()` on transparent windows.
4. **Updater signing key.** Generate once, store in the secrets interface and a sealed backup. Losing it means no more updates for installed Rigs.
5. **Quiet updates** work only for per-user installs. Install the Rig per-user, which also avoids admin prompts for Amber.

## Re-check trigger

Revisit only if T12 hits one of these: WebView2 renders the side panel wrong on Amber's machine; the click-through poll shows measurable CPU; or a needed plugin is missing on Mac when Phase 4 adds it.

## Sources

- [Tauri 2 plugin list](https://v2.tauri.app/plugin/)
- [Tauri 2 updater](https://v2.tauri.app/plugin/updater/)
- [Tauri 2 global shortcut](https://v2.tauri.app/plugin/global-shortcut/)
- [Tauri 2 window customization](https://v2.tauri.app/learn/window-customization/)
- [Tauri 2 Windows installer](https://v2.tauri.app/distribute/windows-installer/)
- [Tauri 2 Windows code signing](https://v2.tauri.app/distribute/sign/windows/)
- [Why I chose Tauri v2 for a desktop overlay in 2026](https://blog.manasight.gg/why-i-chose-tauri-v2-for-a-desktop-overlay/)
- [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Tauri vs Electron: performance and trade-offs](https://www.gethopp.app/blog/tauri-vs-electron)
