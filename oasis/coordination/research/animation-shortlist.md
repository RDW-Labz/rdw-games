# Animation shortlist for OASIS (2026-09-28)

Source files: t53-a.json and t53-b.json

**1. Choreographed sequences (T31: splash dissolve, lamp ignite, title reveal)**

| Pick | License | Pin | Size | What it's for |
|---|---|---|---|---|
| GSAP | GSAP Standard No Charge (named exception #252) | npm gsap@3.15.0 | unknown | Choreography timelines for splash/lamp/title reveal |
| anime.js v4 | MIT | unknown | ~42KB gzip | Three.js adapter for animating Object3D/material/camera directly |
| Motion | MIT | unknown | ~34KB gzip | Declarative DOM/SVG choreography for UI overlays |
| dotlottie-web | MIT | unknown | ~380KB+ WASM | Lottie/.lottie playback from After Effects |
| lottie-web | MIT | unknown | unknown | Mature SVG/canvas Lottie player with large asset library |
| Rive | MIT | unknown | ~0.9MB gzip WASM | State-machine vector animation for interactive elements |

**2. Hover/idle motion (T49 Orb, T50 holo cards)**

| Pick | License | Pin | Size | What it's for |
|---|---|---|---|---|
| @react-three/drei | MIT | unknown | unknown | React Three Fiber helpers (Float, Sparkles, Trail) for idle motion |
| three.quarks | MIT | unknown | unknown | GPU-instanced particle/VFX system for ambient glow and shimmer |
| react-spring/@react-spring/three | MIT | unknown | unknown | Spring-physics hooks with Three.js native binding for hover transitions |
| simplex-noise | MIT | unknown | ~2KB gzip | Dependency-free noise generator for organic idle motion |

**3. Sprite-sheet playback (T46 More-motion packs)**

| Pick | License | Pin | Size | What it's for |
|---|---|---|---|---|
| three.js native texture offset/repeat | MIT | unknown | zero | Sprite-sheet playback via texture.offset/.repeat on mesh (no new dependency) |
| pixi.js AnimatedSprite | MIT | unknown | unknown | Ready-made sprite frame player for pixel-art atlases |

**4. Free motion asset sources**

| Pick | License | Pin | Size | What it's for |
|---|---|---|---|---|
| webgl-noise | MIT | unknown | unknown | Classic GLSL Perlin/simplex noise snippets for shader-driven animation |
| mattdesl/eases | MIT | unknown | unknown | Penner easing equations for lightweight tweening |

## Rejected

framer-motion-3d — unmaintained, superseded by react-three-fiber patterns
Spine Runtimes — authoring/export requires paid Spine editor license
CreateJS/EaselJS — unmaintained for years, superseded by pixi.js
Velocity.js — unmaintained since ~2020
Phaser — full game engine, too heavy for sprite-sheet playback only
three-SpriteMixer — low activity wrapper, implement texture-offset natively instead
LottieFiles free library — non-OSI Lottie Simple License
LYGIA shader library — non-commercial free only, requires paid commercial license
Shadertoy snippets — per-shader licensing, mostly CC BY-NC-SA non-commercial

## Asset rule

Any asset pulled needs a CREDITS.md line (name, source URL, license, date pulled) per decision #237.

## For Braden to pick

Q1 (choreographed): t53-a top is GSAP (decision #252 exception) for timelines, anime.js v4 as Three.js-native alternative.
Q2 (hover/idle): t53-b top three are @react-three/drei for helpers, three.quarks for VFX, react-spring/@react-spring/three for springs.
Q3 (sprite-sheet): t53-a top pick is three.js native texture-offset pattern (zero bundle cost).
