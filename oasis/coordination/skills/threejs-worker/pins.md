# threejs-worker — full pins and provenance

Referenced from SKILL.md. Source: coordination/research/threejs-shortlist.md; decisions #232, #234–#236, #247, #252.

- three 0.186.1 (r186, MIT). Built-ins first: Sky, Water, Lensflare, EffectComposer.
- postprocessing 6.39.5 (zlib, commit 3e8eb850ae67a4653973c21bcf3ef1d334731f2b; peer three >=0.168 <0.187). Only if EffectComposer can't do it.
- three-good-godrays commit 70ad1c41c78796637064b3bb9246be08e81ee777 (zlib, npm 0.12.1). Its README tests three <=0.182, so r186 is outside the tested range. Test it on our build before use.
- three.quarks commit 7cb6388b478fea6ffcd31c4154f35d45d6a53f0e (MIT); npm `three.quarks@0.17.1` (published 2026-05-21, peer three >=0.182.0, integrity `sha512-HiyORXkPZTfy7OBA/IRJqTcNxpo53yctgV3N8dSUG/jdisiVciDFGyf6hVnOLQDrIEmzU0yOtNFvzo+JHCjc7A==`). Splash only. Never on Home or Coworkers.
- guillocheJS commit 8e1d3fb17820d83999f3b1ab8bfe6c4ce1061128 (MIT). Offline bake to PNG. Never at runtime.
- nidorx/matcaps (MIT). Pin a 40-hex commit + provenance at first use (#235).
- holocloth a6078ba698a53cbf18be870cea555c1971f84103: reference only. Read the foil math, write our own shader. No code copied (#234).
- gsap 3.15.0 (integrity `sha512-dMW4CWBTUK1AEEDeZc1g4xpPGIrSf9fJF960qbTZmN/QwZIWY5wgliS6JWl9/25fpTGJrMRtSjGtOmPnfjZB+A==`, named license exception #252): the ONE timeline library, for choreography and for hover/idle tweens. No Theatre.js (#247), no anime.js (#261).
- simplex-noise 4.0.3 (MIT, published 2024-07-26, integrity `sha512-qSE2I4AngLQG7BXqoZj51jokT4WUXe8mOBrvfOXpci8+6Yu44+/dD5zqDpOx3Ux792eamTd2lLcI8jqFntk/lg==`): organic idle drift on the Orb and holo cards. Hover/idle = plain three + GSAP + simplex-noise (#261).
- Not now (#261): drei, react-spring, React-Three-Fiber (none in the Rig), Lottie, Rive, Motion. Avatar sprite sheets keep the current CSS sprite method; nothing new.
- Every pin is an exact version (no range) plus npm integrity hash before it lands (#261).
- Anything else: stop and write "needs shortlist" in the job result.

