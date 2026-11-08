# Putt Drop — three ways to feel the drop

These are art direction studies for a premium, offline, one-thumb game. The same real Moon Pool hole appears in all three; the material, hierarchy, typography and motion language change. They are not production game screens or a physics demonstration.

## Review the studies

Open `design/directions/index.html` through a static server rooted at `design/`. From the repository root:

```sh
python3 -m http.server 5301 --bind 0.0.0.0 --directory design
```

On the same local network, open `http://<mac-ip>:5301/directions/`. No downloads or external services are needed. Desktop shows six iframes in one horizontal comparison, each at 60% scale; narrower desktops can scroll horizontally. At 800px and below, direction pills plus Menu/Aim controls show one screen at a time. The preview fits the available width without changing its underlying composition. Desktop scaling is for comparison; inspect at full size to judge touch targets.

Each screen is exactly **390 × 844 CSS px**. The top **47px** is a simulated status area. Play HUD: y=47–117. Course: x=0, y=117, width=390, height=693. Home area: y=810–844. The SVG uses `viewBox="0 0 360 640"` with the requested 390 × 693 viewport: x scale 1.083333, y scale 1.0828125 (the requested integer height introduces a negligible 0.05% difference). No crop, camera rotation or perspective is applied to gameplay.

All three play screens copy every boundary vertex, both interior walls, water polygon and slope polygon from `levels/hole05.json`. Tee is (245,542), cup (245,165), ball radius 7, cup radius 11, par 3. The slope arrows point down/right, matching force (45,30). Decorative wall thickness surrounds the collision centerline; it does not redefine it. There is no sand, mover or bumper in hole 5, so none is invented in the mockups. Hole 9's narrow turns, water, down/left slope and bumper informed the mechanic system below; it is not substituted for the requested hole.

All play views freeze the same **70% aim state**, with a dotted direction line, pullback handle, segmented numeric power meter and “Release to putt.” This line shows initial direction, not a simulated winning route. The ball remains the bottom-third interaction focus (screen position about 265,704). Menu Play begins at y=616, or y=622 in Rally Club. All unscaled interactive targets are at least 48 × 48px. All screen copy is at least 13px; gallery labels are outside the game UI. No bitmap assets, copied art, external URLs, remote fonts or image generation are used.

The menu says **Play / Continue · Hole 4**, as requested. Its preview link deliberately opens the supplied **hole 5** study; these files are not a working save-game flow. Holes opens a small hole 5 preview sheet; Settings opens local checkbox controls; Pause opens Resume/Main menu. Settings are illustrative and are not persisted. Gameplay is deliberately static. Menus have gentle idle animation, and dialogs have a short entrance. Reduced-motion preferences remove both; the gallery also has a Pause motion control.

Display fonts are loaded from `../../fonts/...` inside every direction's HTML. Only provided SIL OFL files are used, with one display family and one supporting body family per direction. Shared CSS and interaction script live one directory up. `design/directions/build.py` reproducibly embeds the unchanged source geometry into all six HTML files; it writes only those files.

## 01 — Afterglow

### Concept and audience

A secluded miniature course after sunset: a luminous rail, cool water and a single warm signal drawing the eye toward the next putt. Light communicates the action rather than decorating every surface. It appeals to players who want a focused evening ritual, premium polish and a little electricity without visual noise.

The design logic is **emissive guidance**. The course is the light source; secondary UI recedes into blue-black, while the ball, aim and primary action share a pale citrus highlight. The menu is symmetrical and still, with a suspended pearl and orbital traces establishing depth.

### Typography

- Display: **Unbounded**, weights 600–700; supplied `unbounded/Unbounded[wght].ttf`. Title 66px/0.92, weight 700, letter spacing −3.5px; action 24px; hole title 19px.
- Body: **Space Grotesk**, weights 500–700; supplied `spacegrotesk/SpaceGrotesk[wght].ttf`. Body 16px; instructions and chips 13px; secondary action 17px. Use tabular numerals for production power and stroke readouts.
- Keep the logo's wide geometry; do not apply its tight tracking to small labels.

### Semantic palette

```text
bg              #080F1B → #0B1C28; atmospheric hotspot #173B43
surface         #11232F → #1A3540
surface-raised  #16323B → #244752
primary         #D5FF98 → #94EAC2
on-primary      #132522
secondary       #6EF5DB
text            #EFFBF5
text-muted      #A4BFBE
success         #C4FF73
warning         #FFD180
danger          #FF8FA4
wall            #6EF5DB; under-edge #176879
turf            #173E43 → #0E272E
sand            #D8B77A
water           #243CC1 → #101C65
slope           #375366; arrow #95C8D3
mover           #E0A5F3
bumper          #FFB58C
cup             #071521; flag #C4FF73
ball            #FFFFFF → #F2F7E9 → #B9CBB8
aim-low         #6EF5DB
aim-mid         #C4FF73
aim-high        #FFD180
aim-accessible  #F5FFE9, dark backing #071521
```

The 70% screenshot uses `aim-mid`. Accessible aim keeps one near-white ink for all powers: short dots at low, longer dashes at mid, a continuous line at high, always paired with ten meter segments and the numeric percentage. Never make red-versus-green the only instruction.

### Shapes and course treatment

- Primary pill: 326 × 74px, radius 38. Secondary: 326 × 52px, radius 28. Icon circle: 48px. Raised power strip: radius 20; sheets: radius 30; score pill: radius 21.
- Borders: 1px #3E6570; top inner highlight white at 14%. Panel shadow `0 12px 32px #00000055`. Primary has a 1px white-at-47% top highlight. No glow around paragraph text.
- Turf is a two-stop gradient clipped to the exact polygon, with alternating 32-unit mowing strips rotated −24°, white at 6.5%, plus sparse two-dot noise. Render once into a texture; do not draw new grain each frame.
- Walls: a dark 11-unit under-rail, cyan 3-unit core, round joins, and a faint 18-unit outer halo. Interior barriers use round end caps, a 10-unit dark backing and a 6-unit core. In Phaser, bake a small halo texture and use alpha rather than a real-time blur pass.
- Water: darker two-stop blue, repeating thin broken ripples at 27% alpha, 2-unit inset-looking boundary. Water remains darker than the playable turf in greyscale. Slope is slate with a repeating down/right chevron pattern, never just a tint.
- Cup: radius-11 dark cavity, narrow cyan lip, radius-14 low-alpha target ring, upright citrus flag. Ball: radius-7 radial pearl, small downward contact shadow; ball illumination is stronger than any decoration.
- Other-hole grammar: sand uses short amber dashes; mover is a lavender capsule with a dashed travel track; bumper is a peach circular puck with concentric impact rings. The hole 9 bumper must not read as another cup: light-filled center and no flag.

### Motion character

1. Idle ball lifts 6px and returns over 3600ms, sine in/out; title light breathes over 5000ms with the same easing. The power meter does not pulse while aiming.
2. Press: 1 → 0.97 scale and 2px down over 100ms, cubic out; return over 160ms, cubic out.
3. Screen transition: new scene rises 12px and fades over 280ms, cubic out; old scene fades over 160ms. No spin or zoom of the course.
4. Sheet entrance: 16px upward movement plus opacity over 250ms, cubic out. Completion rim bloom: 260ms, sine out; no full-screen flash.

### Signature moment: the putt

Frame ranges are storyboard targets at 60fps, not new simulation rules. Travel duration is variable; cup frames begin only on the simulator's `holed` event.

- F0: touch captures the ball. A 20-unit ring resolves in 100ms; no stroke is counted yet.
- F1–6: dotted aim line and pullback tether fade in. The meter follows current power with at most 50ms visual smoothing; numeric percentage is authoritative, without delayed rounding effects.
- Held drag: at 70%, citrus dashes and seven of ten meter segments are lit. The course stays still, preserving the line the player chose.
- Release F0–4: the tether collapses and the aim guide fades in 67ms. The ball's actual simulation trajectory begins immediately; feedback does not delay input.
- Travel: at most six small trailing light sprites, each fading within 100ms. One restrained rail pulse per wall-hit; no predicted second bounce is shown.
- Cup event F0–4: ball moves visually into the hole center while its shadow contracts. F5–10: pearl shrinks 1 → 0.2 and falls below a cup mask. F11–16: a single citrus ring expands 14 → 25 units and fades. A `rim` or `lip-out` event plays a brief rim flicker and keeps the ball visible; it never plays the drop.

### Signature moment: hole complete

- F0–11 after drop: hold on the empty, softly lit cup for 200ms.
- F12–23: a translucent bottom sheet rises 16px; background dims to 70% brightness without obscuring the course.
- F24–35: “Hole complete” resolves, followed by the actual stroke total and a real result label such as “Birdie” only when earned. One narrow light arc traces the score pill.
- F36–47: up to 12 tiny citrus sparks rise from the cup then disappear. No endless confetti.
- F48 onward: **Next hole** is visible and actionable in the bottom third. Tapping during the entrance completes it immediately. Under reduced motion, show the result and next action directly.

### Risks and scores

Dark greens can merge on low-brightness screens; preserve the bright wall silhouette and white ball, and test water/turf differentiation on an actual phone. Broad bloom costs fill rate and can obscure water edges; bake it once, limit its radius and avoid full-screen postprocessing. Wide Unbounded labels need deliberate copy length.

Scores, 1–5: **premium feel 5; clarity 4; distinctiveness 4; perf risk 2; build effort 3**. Higher premium/clarity/distinctiveness is better; higher risk/effort is worse. Scores are art-direction judgments, not benchmark results.

## 02 — Pocket Park

### Concept and audience

A little park held in your hand, with cream clay rails, mown felt, painted water and a bright flag. It should feel like a treasured tabletop object that comes alive when touched. It appeals to cozy-game players, families and people who want a calm, friendly purchase they can keep returning to.

The design logic is **tactile miniature craft**. Shadows, soft bevels and a limited material palette give everything weight. The menu uses an asymmetric, slightly tilted wordmark and a small illustrated island; the playfield stays strictly overhead so miniature charm never hides a collision edge.

### Typography

- Display: **Fredoka**, weights 500–600; supplied `Fredoka-Variable.ttf`. Logo 77px/0.87, weight 600; action 24px; hole title 23px; result 34px. Rounded terminals echo the rails without becoming bubble lettering everywhere.
- Body: **Nunito**, weights 600–800; supplied `Nunito-Variable.ttf`. Body 16px; caption and score 13px; secondary action 17px. Use 700 for essential instructions and 600 for quiet support text.

### Semantic palette

```text
bg              #FAF3DF → #EEE8CF; warm hotspot #FAE0B9
surface         #FFFBEE → #F1E8D0
surface-raised  #FFF9E9 → #FFFDF4
primary         #F58E6C → #ED7759
on-primary      #43271F
secondary       #5C8963
text            #354B3A
text-muted      #626950
success         #38674C
warning         #8D621A
danger          #AE403B
wall            #FAF1D7; under-edge #B49A71
turf            #B3D28B → #87B36F
sand            #E5C786
water           #64B7C6 → #338696
slope           #D6D294; arrow #6C8154
mover           #BC665C
bumper          #A58BC2
cup             #354B3A; flag #DB6246
ball            #FFFFFF → #F2F7E9 → #B9CBB8
aim-low         #3B6659
aim-mid         #AD4930
aim-high        #764A7B
aim-accessible  #354B3A, pale backing #FFF9E9
```

Accessible aim uses dark ink with the same dot/dash/solid progression, ten discrete power segments and an always-visible number. Slope arrows, water ripples and sand speckles distinguish surfaces without depending on green/blue perception.

### Shapes and course treatment

- Primary: 318 × 74px, radius 38; secondary 318 × 52px, radius 28; 48px icon circles; 20px power panel; 30px sheets. No angular paper cards.
- Borders: 1px #D5C8A6. Primary: inset 0 2px #FFBC94, 0 5px 0 #CF6248, then 0 12px 21px #AE795126. Panels: 1px cream top highlight, compact olive-tan shadow; use two alpha-offset silhouettes in Phaser rather than a blur every frame.
- Turf: light-to-dark green fill, wide low-opacity mowing bands and sparse static dot grain. The fine texture should read as felt when still and disappear during play.
- Walls: 11-unit tan backing plus a 6-unit cream core, round joins and caps. Shift a low-alpha duplicate of the outer boundary 9 units down to suggest a small plinth. Keep this extrusion outside the playable boundary; keep hazard polygons unshifted.
- Water: painted teal gradient, subtle pale ripple pattern, a darker 2-unit contour suggesting a recess. The river silhouette remains exactly polygonal; stroke joins soften presentation without cutting across safe space.
- Slopes: warm sage patch with dark chevrons indicating the exact force vector. Sand: small oat-colored pebbles, baked once. Movers: dusty-rose toy sliders with two recessed end dots and a visible dashed track. Bumper: lilac rubber button with a pale crown and firm contact rim.
- Cup: dark green radius-11 well and cream rim; a terracotta flag makes it findable without a moving beacon. Ball: white ceramic shading and a tight olive contact shadow. A plinth does not change the 2D ball radius.
- Menu-only trees use layered circles and rounded stems; the island uses simple filled paths and stacked silhouettes. No mesh, 3D lighting engine or physical soft-body system is needed.

### Motion character

1. Menu ball: a 3px lift with a 1° rock over 4000ms, sine in/out. Shadows stay anchored to make it feel light, not untethered.
2. Press: 3px depression and 0.97 scale over 90ms; settle over 220ms, back-out with only 4% overshoot. Keep text rigid.
3. Sheets: rise 16px over 300ms, cubic out; subtle 1.02 → 1 settle at the end. Preview uses the common 250ms entrance; this fuller recipe is the proposed game treatment.
4. Impact: compress the decorative ball sprite perpendicular to contact to 0.94 for 50ms, recover in 100ms. This is visual only; collision remains the circle. Do not stretch the white silhouette so far it suggests a bigger hitbox.

### Signature moment: the putt

- F0–6 on touch: the ball's outer ring appears as a thin terracotta pencil circle. It stays radius 20, leaving the real ball edge clear.
- F7 onward: dotted aim marks and a fine pullback thread follow the thumb. Power fills ten clay-colored segments; at 70%, seven are filled and the numeric label says 70%.
- Release F0–3: pullback thread disappears; the sprite compresses only 3% for a light physical cue. Simulation starts on release, without waiting for this squash.
- Travel: a tiny contact shadow follows directly below. Two short-lived turf flecks may appear at launch, never along the whole route. Wall contacts get a 100ms highlight on the hit segment; the wall itself does not bend.
- Cup event F0–5: ball lowers into the dark well, shadow tightens. F6–11: cup mask hides its lower half, then the whole ball. F12–20: flag flexes 3° then settles; one pale ring fades. Rim events only produce a brief flag-free contact tick, not a successful drop.

### Signature moment: hole complete

- F0–11 after drop: a quiet beat on the cup, with no camera movement.
- F12–29: a cream rounded result sheet slides up; shadow catches below it. “Lovely putt” is a celebratory heading, followed by the factual “Hole complete,” stroke count and result.
- F30–41: the result pill rises 4px and settles with a mild spring. Six petal-shaped particles drift from the flag; pre-baked ellipses, not simulated paper.
- F42–53: the next-hole name appears above the coral **Next hole** pill. The player can continue as soon as that action is visible; no reward wait.
- F54 onward: decorative particles finish and everything rests. Reduced motion skips the drift and spring and uses a 100ms opacity change.

### Risks and scores

Soft material contrast can become muddy in sunlight; keep the ball near-white, cup dark and water at least one clear value step below turf. A thick cream rail can make narrow bends look tighter than physics; center it on the original line and verify hole 9 at device size. Layered shadows increase overdraw, but baking the static board and using a bounded number of particles avoids expensive lighting.

Scores, 1–5: **premium feel 5; clarity 4; distinctiveness 5; perf risk 2; build effort 4**. The added effort is material consistency and contact animation, not a need for a 3D engine.

## 03 — Rally Club

### Concept and audience

A bright, contemporary sporting club built from oversize type, lilac court rails, citron greens and crisp motion. It makes every quick round feel like a tiny event, with confidence and humor instead of neon spectacle or toy realism. It appeals to players who like bold design, immediate feedback and replaying for a better score.

The design logic is **graphic rhythm**. Big type, stripe repetitions, a clear dark outline and purposeful empty space do most of the work. The menu is offset and typographic; the course is flatter and clearer, with only enough shadow to separate the layers.

### Typography

- Display: **Bricolage Grotesque**, weights 700–800; supplied `bricolagegrotesque/BricolageGrotesque[opsz,wdth,wght].ttf`. Logo 78px/0.86, weight 800; action 25px; hole title 22px; result 40px. Set optical size automatically; keep width at its default.
- Body: **Outfit**, weights 500–700; supplied `outfit/Outfit[wght].ttf`. Body 18px on the menu, 16px elsewhere; controls 17px; labels 13px. Display is characterful, body is calm.

### Semantic palette

```text
bg              #FAF7DF → #EEEDC5; citron hotspot #F8FFB6
surface         #FFFFEF → #E6E6BF
surface-raised  #FFFEEE → #FFFFFF
primary         #6544C8 → #49309F
on-primary      #FFFBEA
secondary       #C1D76B
text            #38276F
text-muted      #6B5A81
success         #416535
warning         #895117
danger          #AE344F
wall            #6550CF; under-edge #332478
turf            #EDEAA5 → #D4DB7C
sand            #E6B76F
water           #719BE3 → #4976CB
slope           #EECC83; arrow #92612D
mover           #B74778
bumper          #F18C50
cup             #30226C; flag #5134BB
ball            #FFFFFF → #F2F7E9 → #B9CBB8
aim-low         #35675B
aim-mid         #5036B9
aim-high        #9C3D4D
aim-accessible  #38276F, pale backing #FFFEEE
```

Accessible aim stays deep violet and changes dash shape with power. The numeric meter and tick positions remain identical across all directions, so comparison does not confuse artistic style with control changes.

### Shapes and course treatment

- Primary: 326 × 72px, radius 38; secondary 326 × 52px, radius 28; 48px circles; 20px power strip; 30px sheets. Big generous pills, no sharp editorial rectangles.
- A primary pill has a 6px deep-violet offset shadow plus 0 12px 22px violet at 9%; its fill moves from medium to deep purple. Secondary panels use a cream gradient and a 1px #CFCBB2 border. Shadows convey alignment, not physical clay depth.
- Turf: citron gradient with higher-contrast 32-unit mowing stripes at 11% alpha. These stripes are graphic bands rather than texture-driven grass. Keep grain almost imperceptible.
- Wall: 11-unit dark-purple under-rail and 6-unit violet core. Interior wall caps are circular; two tiny groups of ticks outside the course evoke court markings without becoming false obstacles.
- Water: cornflower-to-cobalt fill with repeating pale waves; unlike the purple cup, it is broad, patterned and visibly blue. Slope: apricot patch with brown directional chevrons. Sand: small ochre dots; mover: magenta capsule with a dashed travel line; bumper: orange filled circle with a contrasting inner ring.
- Cup: dark purple well with a light rail-colored rim and pennant; ball: off-white with a tiny shadow. Do not give the white ball a colored aura on the pale grass—use its dark ring while aiming and a fine contact edge when rolling.
- The menu's diagonal capsule is an illustration only. Gameplay is never tilted or skewed; the actual course outline is untouched.

### Motion character

1. Idle menu ball: 5px rise over 2800ms, cubic-bezier(.45,0,.55,1); no rotation of the whole interface.
2. Press: 3px downward travel over 80ms, cubic out; return over 140ms. Offset shadow shortens with the press.
3. Screen transition: panels translate 20px horizontally and fade over 220ms, cubic out; freeze course coordinates during play.
4. Score reveal: one 6px upward slide over 180ms, then a 100ms settle. Sparse graphic strokes fan out once over 260ms; avoid a strobing victory screen.

### Signature moment: the putt

- F0–4 on touch: a clear violet ring snaps into view with an 80ms fade. The ball stays in place.
- F5 onward: violet dash train follows aim; meter segments fill left to right with no overshoot. The 70% label and endpoint marker remove ambiguity.
- Release F0–3: aim disappears in 50ms and the live ball moves immediately. Two narrow 60ms launch strokes point opposite the travel direction, then vanish.
- Travel: one short translucent line segment may trail the ball; use no more than four history positions. Wall hits get a 90ms boundary tick aligned with the normal, not a shake of the entire screen.
- Cup event F0–4: ball shrinks to 75% into the mask. F5–9: disappear beneath the lip. F10–16: two half-rings expand in opposite directions like a score mark, fading before the result sheet. `rim` and `lip-out` get a small lateral tick and retain the ball.

### Signature moment: hole complete

- F0–7 after drop: 133ms pause on the cup.
- F8–20: a cream rounded sheet enters from the bottom; a bold **Hole complete** line and the actual result appear with one 6px upward slide.
- F21–32: six violet/citron capsules fan outward 24px around the score, stopping well clear of essential text. The final stroke number lands without counting through fictitious values.
- F33–43: **Next hole** takes the bottom-third position with a short opacity entrance. “Replay” remains secondary, if offered in production.
- F44 onward: all celebratory motion stops. Reduced motion shows the complete sheet immediately and uses no flying strokes.

### Risks and scores

The pale course needs a dark ball contact edge, especially outside aim mode. Graphic stripes can compete with trajectory marks; cap them at 11% white, keep the aim dark and keep decorative ticks outside the boundary. Bold type can overpower a small HUD; reserve the extreme sizes for menu and results. This is the cheapest direction to render because its character depends on layout and baked bands rather than lighting.

Scores, 1–5: **premium feel 4; clarity 5; distinctiveness 4; perf risk 1; build effort 2**.

## Implementation boundaries and verification

All treatments are buildable with filled/stroked polygons, rounded rectangles, clipped gradient textures, small repeated patterns and pooled particles. For Phaser, generate static course and UI textures once per hole, using devicePixelRatio subject to a measured memory budget. Keep the ball, flag, aim and UI readouts as separate sprites/graphics. Avoid one texture per grain fleck, animated SVG filters, full-screen blur and unbounded particle emitters. A maximum of 12 short-lived celebration particles is sufficient. For a 390 × 844 screen, a single RGBA texture at 3× is about 11.3MiB; do not blindly retain six full-screen layers per hole. These are implementation budgets, not measured 60fps claims.

The mockups use CSS gradients, SVG patterns, polygon strokes and transforms. 108 structural assertions passed for exact geometry, font/reference paths, expected dimensions, safe-area arithmetic, six iframes and reduced-motion rules. Both JavaScript files pass syntax checks, and rebuilding produces identical HTML. Seven sampled text/background color pairs pass 4.5:1 contrast, including each primary button and each muted-text color; this is a targeted color check, not a full accessibility audit. Browser rendering, screenshot inspection, phone interaction checks, text-fit checks and frame-rate measurements remain **unverified**: this session's sandbox rejects both local HTTP binding and headless Chromium launch; the available browser-control tool also requires approval that this session cannot grant. No server was started. Open the gallery with the command above in a normal terminal for the final visual review. There is no claim that automated checks prove visual polish.

Only `design/directions/**` and this document are created. Existing font files and all game code, levels, scripts, tests, manifests and public assets are untouched. No commit is made.

## Recommendation

**Choose Pocket Park.** It offers the strongest ownable identity for a small paid-unlock game: a welcoming object with material character, clear one-thumb play and a reason to linger without demanding constant effects. Its warmth supports an offline game that feels complete when purchased. Carry forward the overhead geometry and restrained particle budget, and spend the extra design effort on rail depth, ball contact and the cup drop.

Afterglow is the most natural continuation of the existing neon direction and the fallback if the owner wants a focused night mood. Rally Club is the clearest and least expensive to build; choose it if a fast, graphic arcade personality is more important than tactile warmth. The recommendation is provisional until the owner reviews the six renders on a real phone.
