# Three.js research shortlist for OASIS (2026-09-28)

Source files: v2-scout-1790612819192.json, v2-scout-1790612821222.json, v2-scout-1790612823211.json, v2-scout-1790612825218.json, v2-scout-1790612827229.json (all in coordination/research).

**1. Holo/foil cards (T50)**

| Pick | License | Pin | Size | What it's for |
|---|---|---|---|---|
| holocloth | MIT | a6078ba698a53cbf18be870cea555c1971f84103 | unknown | Custom GLSL iridescent/holographic foil shader with sparkle |
| guillocheJS | MIT | 8e1d3fb17820d83999f3b1ab8bfe6c4ce1061128 | ~36KB | Hypotrochoid guilloche curves for engraved gold-border pattern |
| vanilla-tilt.js | MIT | 967ab1accf4fdf5ce8a67eeac146e3035a7fe5be | 6.8KB minified | Zero-dependency pointer-driven 3D tilt + glare for card |

**2. Splash + load-in particles and light**

| Pick | License | Pin | Size | What it's for |
|---|---|---|---|---|
| three.quarks | MIT | 7cb6388b478fea6ffcd31c4154f35d45d6a53f0e | ~100KB | GPU-instanced particle/VFX system for embers/sparks |
| three.js Lensflare | MIT | three.js tag r186 | ~9.8KB | Cheap fake volumetric glow around light sources |

**3. World + sky (T40, later)**

| Pick | License | Pin | Size | What it's for |
|---|---|---|---|---|
| three.js Sky.js + Water.js | MIT | three.js tag r186 | ~300 lines | Procedural sky dome + reflective water-plane shader |
| THREE.Terrain | MIT | none found — must pin a commit before use | unknown | Procedural heightmap-based low-poly terrain generation |

**4. Post-processing**

| Pick | License | Pin | Size | What it's for |
|---|---|---|---|---|
| three.js EffectComposer + effects | MIT | three.js tag r186 | ~20KB | Bloom, film grain, vignette, chromatic aberration, tone mapping |

**5. Free asset sources**

| Pick | License | Pin | Size | What it's for |
|---|---|---|---|---|
| Poly Haven (Studio Small 08 HDRI) | CC0 1.0 | https://polyhaven.com/a/studio_small_08 | unknown — resize to ≤2 MB before bundling | Environment maps/HDRIs for world lighting |
| ambientCG Foil 002 | CC0 1.0 | https://ambientcg.com/view?id=Foil002 | unknown — resize to ≤2 MB before bundling | Gold-foil PBR texture for cards |
| ambientCG Metal 007 | CC0 1.0 | https://ambientcg.com/view?id=Metal007 | unknown — resize to ≤2 MB before bundling | Metal PBR texture for world/objects |

**Verify first:** Kenney Particle Pack, Kenney City Kit (CC0; license page 404, couldn't verify independently; City Kit from third-party mirror).

**Rejected:** pokemon-cards-css (GPL-3.0). pmndrs/postprocessing, three-good-godrays (zlib — permissive if Braden wants to allow). Shadertoy procedural sky (Shadertoy default license). Low Poly City Pack itch.io (no license file). Quaternius (custom QAL license). daniel-ilett holo card (Unity, wrong stack). react-flip-tilt (stale). threex.volumetricspotlight (abandoned 2013). three.js bundled example assets (per-file licenses vary).

**Top 3 to use first:**
- holocloth: Three.js/WebGL2 shader reference for T50 foil+sparkle (MIT; vet the math yourself).
- guillocheJS: bake the guilloche border as texture offline (MIT, dependency-free, tiny).
- vanilla-tilt.js: drive pointer-based tilt/glare on the card (MIT, tiny, ubiquitous).

Nothing is adopted until Braden says yes; each yes becomes a decision + a pin.

## Verify pass (2026-09-28, scout-1790613690469, $0.37; decision #234)
- **Kenney: verified CC0** on kenney.nl/support and the asset pages kenney.nl/assets/particle-pack and kenney.nl/assets/city-kit-{commercial,industrial,roads,suburban}. Allowed per #234.
- **pmndrs/postprocessing:** zlib. Pin v6.39.5 = 3e8eb850ae67a4653973c21bcf3ef1d334731f2b; peer three ">= 0.168.0 < 0.187.0" (r186 fits). Newest tag is v7.0.0-beta.16 (beta, not adopted).
- **three-good-godrays:** zlib, no git tags; pin 70ad1c41c78796637064b3bb9246be08e81ee777 (npm 0.12.1). README says tested with three ">= 0.125.0 <= 0.182.0": **r186 is outside the tested range**, so try it on our build before adopting.

## Asset sources (decision #235, 2026-09-28)
| Status | Source | License | Use |
|---|---|---|---|
| Use now | nidorx/matcaps | MIT (pin a commit at first use) | T50 card shading, Orb glow |
| Use now | NASA 3D Resources | Public domain | Space theme props |
| Use now | awesome-cc0 | CC0 list | Master list for finding CC0 assets |
| Later | CMU mocap | Free | More motion packs |
| Later | 200 CC0 VRM avatars; Polygonal Mind | CC0 | Only if 3D coworkers |
| Per file | OpenGameArt, Icosa Gallery, Blend Swap, itch.io CC0 tag, HDRMaps/OpenHDRI | Mixed | Check and record each file's own license |
| Verify first | Rokoko Motion Library, Retro3D, The Base Mesh | Unconfirmed | Check attribution/use terms before any use |
| Skip | Fab/Megascans | Not CC0; no redistribution in shipped packs | — |

**Rule:** every bundled asset gets a line in that repo's CREDITS.md: name, source URL, license, date pulled.

### Second batch (decision #236)
| Status | Source | License | Use |
|---|---|---|---|
| Use now | Poly Haven, Kenney, ambientCG | CC0 (site policy) | Textures, HDRIs, models |
| Use now (test only) | Khronos glTF Sample Assets | Per file, mostly CC-BY/CC0 | glTF loader tests; never shipped |
| Per file | Poly Pizza | Mostly CC-BY | Credit line each |
| Per file | Sketchfab | Filter CC0/CC-BY only | Credit line each |
| Per file | 3DTextures.me, ShareTextures, cgbookcase | CC0 sites | Record each file anyway |
| Verify first | KayKit | Most packs CC0, some paid | Check the pack |
| Verify first | Smithsonian Open Access | CC0 only where marked | Check each item |
| Skip | Quaternius | Custom license | Already rejected |
| Skip | Mixamo | Adobe terms: no redistribution as packs | Internal animation reference only, never bundled |

## GSAP license record (decisions #247, #248)
- **License:** Standard "No Charge" GSAP License (Webflow). Effective 2025-04-30, last modified 2025-05-30 (read at gsap.com/standard-license on 2026-09-28). Not an OSI license. Free for commercial use, plugins included.
- **Grant:** "Webflow grants you a non-exclusive, worldwide license to use, reproduce, display, and implement GSAP Products solely for Permitted Uses."
- **Restriction:** no use in tools that let users build visual animations without code in competition with Webflow, and no reverse engineering to build competing products. OASIS uses GSAP internally for its own UI motion, which is not that.
- **Named exception to the license filter: decision #252 (final).** Pin `gsap@3.15.0` (npm, 2026-04-13), exact.
- **CREDITS.md line when GSAP lands (desktop-app, written by the owning seat):** `GSAP 3.15.0 — https://gsap.com — Standard "No Charge" GSAP License (Webflow), effective 2025-04-30, modified 2025-05-30 — pulled <date>`.
