---
name: threejs-worker
description: Read before any job that touches Three.js, WebGL, holo cards, the splash, or 3D assets in desktop-app. Pinned versions, allowed libraries, render rules, fallbacks, credits.
paths:
  - "src/**/{three,splash,holo*}/**"
  - "src/**/*{3d,3D,webgl,WebGL,shader}*"
  - "**/*.{glsl,frag,vert,glb,gltf,hdr,ktx2,exr}"
  - "src/assets/**/*.{png,jpg,jpeg,webp,mp4,webm,mp3,ogg,wav,glb,gltf,hdr,ktx2}"
checks:
  resultKeys:
    - screenshots
    - rendererInfo
    - frameTimeMs
    - creditsLines
---

# Three.js worker skill

## Pins (exact, no ranges; full commits and licenses in pins.md)
- three 0.186.1 (r186). Built-ins first: Sky, Water, Lensflare, EffectComposer.
- postprocessing 6.39.5, only if EffectComposer can't do it.
- three-good-godrays at the pinned commit. Untested past three 0.182, so test it on r186 first.
- three.quarks: splash only. guillocheJS: offline PNG bake only.
- nidorx/matcaps: pin at first use. holocloth: reference only, no code copied.
- gsap 3.15.0 for choreography (#252). No Theatre.js (#247).
- Anything else: stop and write "needs shortlist" in the result.

## Where 3D is allowed
- Coworkers page (holo cards, T50) and splash (T31). Nowhere else.
- Orb hover (T49) is CSS/GSAP, not WebGL.

## Render rules
1. Render only while the canvas is visible and animating; stop on blur, a hidden tab or pause.
2. One shared renderer per page, never one per card.
3. PNG fallback first for every 3D element; swap in WebGL when ready; on init failure keep the PNG, with no error text.
4. Pixel ratio ≤2; 60 fps (30 unfocused).
5. Dispose geometries, materials and textures on unmount; renderer.info.memory returns to baseline (test it).
6. No runtime network fetches. Bundled assets ≤2 MB each; splash video ≤10 MB H.264 (#202).

## Assets and Tauri (details in assets-and-tauri.md)
- Sources: ambientCG, Poly Haven, Kenney, nidorx/matcaps, NASA 3D. Never Fab, Mixamo, Quaternius, ThreeUI Pro, or game/brand assets.
- Every asset gets a CREDITS.md line (name, URL, license, date). No line, no merge.
- Test shaders in WKWebView and WebView2; feature-detect, fall back to the PNG. No Node APIs in the frontend.

## Done-when for any 3D job
- A screenshot of the PNG fallback and of the WebGL version.
- renderer.info before/after unmount in the job result.
- Frame time under 8 ms at 1x ratio on Windows (WebView2, primary, #263), then on the Mac mini.
- CREDITS.md updated. Lint, typecheck, build green.

## Lessons (this skill's area; not gotchas.md, #258)
- (none yet)

## Don't
- Don't copy from ThreeUI Pro or any paid source (clean room, #232).
- Don't add a library not on the pin list.
- Don't render when nothing is on screen.
