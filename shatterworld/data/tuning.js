// ---------------------------------------------------------------------------
// TUNING - every gameplay number lives here (units: metres, seconds)
// ---------------------------------------------------------------------------
const TUNING = {
  // Movement numbers are aligned to the classic 3D-platformer state machine (30 fps per-frame values converted to m/s at 1 unit = 1.7/160 m):
  //   gravity 4 u/f^2 -> 38 m/s^2, terminal 75 u/f -> 24 m/s, run 32 u/f -> 10.2 m/s, single/double/triple jump 42/52/69 u/f (+0.25 x speed),
  //   long jump 30 u/f with 1.5x speed boost and half gravity, backflip/side flip/wall kick 62 u/f, dive +15 u/f, jump-release cap 20 u/f.
  step: 1 / 120,            // fixed physics step
  gravity: 38.2, longGravity: 19.1, maxFall: 24,
  walk: 6.0, run: 10.2, sprint: 13.6,          // top speeds (slow-walk / default / shift)
  accel: 48, decel: 52, skidDecel: 80, airAccel: 26, airDrag: 1.6, turn: 15,
  jump: [13.4, 16.6, 22.0], jumpSpeedBonus: 0.25, jumpKeep: 0.8,  // single / double / triple launch speed; x0.25 of forward speed added; forward speed x0.8 on take-off
  jumpCutVy: 6.4, coyote: 0.11, buffer: 0.14, chain: 0.3,         // releasing jump caps rise speed; coyote time, input buffer, landing window for chain
  longJump: { vy: 9.6, mult: 1.5, cap: 15.3 }, backflip: { vy: 19.8, back: 5.1 }, sideflip: { vy: 19.8, speed: 2.6 },
  wallKick: { vy: 19.8, push: 7.6, window: 0.2 }, wallSlide: 4.0,
  pound: { hang: 0.2, speed: 15.9, radius: 6.5 }, dive: { add: 4.8, cap: 15.3, vy: 3.0, slide: 0.55 },
  punch: { time: 0.26, reach: 1.7 },
  radius: 0.4, height: 1.7, stepUp: 0.4, stepUpBlock: 1.06, slopeMax: 1.3,
  hp: 3, invuln: 1.7, coinHeal: 100,
  cam: { dist: 7.2, distWide: 16, height: 1.45, pitch: 0.24, fov: 62, fovWide: 52, fovKick: 11, collide: 0.3, sens: 0.0023, padRate: 2.6 },
  shatter: { localR: 24, localSpeed: 26, healDelay: 1.15, healSpeed: 24, worldSpeed: 52, band: 9, slowmo: 0.2, plinth: 3.6 },
  lowG: 0.38, // gravity multiplier inside low-gravity pockets
  autoDowngradeMs: 26, autoDowngradeWindow: 3,
  // ---- WebXR / VR (Quest Touch, PC-VR). The world is shown as a tabletop DIORAMA: the camera rig is scaled by S = world metres per real metre,
  // so the hero (1.7 m) is ~14 cm tall and the lit play area (fog radius) is ~2-3 m across. Units below: real metres unless marked (world m).
  vr: {
    scales: [16, 12, 9],            // table size small / medium / large -> hero 10.6 / 14.2 / 18.9 cm
    sizeDefault: 1,
    drop: 0.8, fwd: 0.65,           // the hero's ground sits 0.8 m below the eyes and 0.65 m in front of them (re-measured on recentre)
    tableMin: 0.45, tableMax: 1.2,  // clamp of that ground height above the real floor
    clear: 0.5,                     // the rig floats up whenever terrain under the head rises closer than this (hills beside the table)
    followXZ: 3.2, followY: 3.0,    // 1/s damping of the table following the hero (heavy: world slides gently, never snaps)
    slackUp: 9, slackDown: 6,       // (world m) vertical slack: jumps do not move the table, only ground-level changes do
    snapDeg: 30, snapOn: 0.75, snapOff: 0.35, smoothDegPerSec: 110, stickDead: 0.18,
    fog: 0.30,                      // FogExp2 density in REAL metres (the flat build uses ~0.004 per world metre): hazes out at ~3-5 m
    near: 0.05, far: 1500,          // real metres
    beamLen: 16,                    // (world m) shard beam height in the diorama (flat: 90)
    shardVis: 48,                   // (world m) shards further than this from the hero are not drawn in VR (the arrow points to the nearest)
    blinkDist: 4, blinkTime: 0.35,  // a hero teleport (respawn / pipe) bigger than this in one frame blinks to black instead of sliding the table
    fbScale: 0.9, foveation: 1,     // XR framebuffer scale (0.85-1.0; picked by estimated cost, NOT measured on a headset) and fixed foveation
    // ---- RPG layer in VR (see the <vr-rpg> block): diorama limits + panel sizes. (world m) = world metres, the rest real metres
    rpgVis: 22,                     // (world m) enemies / chests / crates / auras further than this from the hero are not drawn (the table rim is at 17.5 m, the fog hides what is beyond)
    rpgOutline: 11,                 // (world m) enemy toon outlines (a second mesh each) are only drawn this close to the hero, for elites / guardians and the nearest few
    rpgLootMax: 6,                  // gold piles / shards / common items drawn at once (rare+ items always)
    rpgBeamMax: 3, rpgBeamK: 0.4,   // at most 3 light beams (loot / chest / elite) drawn at once, at 40% of their flat-play height
    rpgPlates: 4, rpgPlateVis: 40, rpgPlateK: 0.5, rpgPlateMin: 0.13, rpgPlateMax: 0.55, rpgPlateY: 2.4, // pool of 3D name plates (rare+ loot, act chests, elites): reach (world m), width = K x distance to the eye (constant angular size, ~28 deg) clamped to [min, max] (REAL m: a Sprite's size is added in view space, i.e. unscaled by the rig), height above the thing (world m)
    rpgPanelW: 1.5,                 // inventory / perk panel width (m); 2048 x 1280 canvas, ~66 deg wide at 1.15 m, text >= 34 px (= 28 px of a 1024 canvas at the same angular size on the 1.15 m menu panel)
  },
};

