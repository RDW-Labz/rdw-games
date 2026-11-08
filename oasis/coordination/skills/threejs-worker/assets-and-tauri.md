# threejs-worker — assets and Tauri details

Referenced from SKILL.md. Decisions #202, #232, #235, #236.

## Assets
- Allowed sources: ambientCG, Poly Haven, Kenney (CC0, #236), nidorx/matcaps (MIT),
  NASA 3D Resources (public domain) (#235). Khronos glTF Sample Assets for loader tests only, never shipped.
- Never: Fab/Megascans, Mixamo, Quaternius, ThreeUI Pro, any game or brand asset.
- Every asset gets a CREDITS.md line: name, source URL, license,
  date fetched. No line, no merge.

## Tauri fit
- The frontend runs in WebView2 (Windows, primary, #263) and WKWebView (Mac, secondary). Test
  both when the job touches shaders; WebView2 lacks some WebGL2
  extensions. Feature-detect, and fall back to the PNG.
- No Node APIs in frontend code.

