/**
 * Per-title action scripts, shared by tests/browser.mjs and tools/art-runtime.mjs.
 * One place, so a QA shot and the browser gate always drive a title the same way.
 */
export const ACTS = {
  // seeded run (1234) + steps toward the nearest monster, so a creature sheet
  // actually has to paint — that is the claim worth testing, not just the download
  vaultbreak: [['newGame'], ['step', { x: 1, y: 0 }], ['approach'], ['approach'], ['approach'], ['approach'], ['approach'], ['approach'], ['approach'], ['approach'], ['approach'], ['approach'], ['approach'], ['approach'], ['wait'], ['fire']],
  tessera: [['newGame'], ['endTurn'], ['endTurn']],
  'ember-drift': [['newGame'], ['fire'], ['fire']],
  lanternfall: [['newGame'], ['takeArmour'], ['fire'], ['fire'], ['takeArmour']],
  'rift-nine': [['newGame'], ['right'], ['jump']],
  nulltrace: [['newGame'], ['right'], ['jump'], ['right'], ['jump'], ['right']],
  // the hybrid: lay a drill -> belt -> fabricator line, then let it tick
  siegehaus: [['newGame'], ['buildLine'], ...Array(12).fill(['wait']), ['fire']],
  charterline: [['newGame'], ['charterDemo'], ['endTurn'], ['endTurn'], ['endTurn'], ['endTurn']],
  // the ARPG: open a floor generated from a DCSS vault, hunt what the vault put there
  // until something is actually dead, then take a second floor so the layout changes.
  // 'hunt' reads the live state each swing instead of guessing a direction — a fixed
  // step-then-swing script misses whenever the nearest creature moved, which made this
  // check flake green/red on identical code.
  cinderhold: [['newGame'], ['hunt'], ['descend'], ['attack']],
  // the skirmish: a Wesnoth unit roster on a DCSS arena, two turns of real combat
  wardenmarch: [['newGame'], ['move', { x: 1, y: 0 }], ['attack'], ['endTurn'], ['move', { x: 1, y: 0 }], ['attack'], ['endTurn']],
  // the battle royale: land, mine by hand, then stand up a drill -> belt -> smelter -> turret
  // line and let the factory tick, so the check covers both halves of the hybrid
  stormforge: [['drop'], ['skipLand'], ['grant', { copper: 300, titanium: 120 }], ['buildLine'],
               ['tick', { n: 240 }], ['fire', { ms: 400 }]],
  // the canyon run: fly the racing line long enough to bank real gates, then paint a frame
  galevault: [['newGame'], ['fly', { n: 300 }], ['redraw']],
};
