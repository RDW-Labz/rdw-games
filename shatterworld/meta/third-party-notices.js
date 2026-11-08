// <third-party-notices> =========================================================================================================
// SHATTERWORLD pass B: licence notices for the code / data this layer was ported from (full table: games/THIRD_PARTY-shatterworld.md). Everything else in the mob / food / craft / town / station layers is original.
//
//   three-fps (mohsenheydari/three-fps)  : The MIT License (MIT), Copyright (c) 2021 Mohsen Heydari           -> the FiniteStateMachine / CharacterFSM pattern (`MobFSM`, `MobState`, `<mob-core>`)
//   mobs_redo, mobs_monster, farming     : The MIT License (MIT), Copyright (c) 2016-2025 TenPlus1           -> attack vocabulary + numbers (`<mob-core>`), crop / ingredient / dish graph shape (`<food-core>`, garden beds)
//   projectflowerbed (meta-quest)        : MIT License, Copyright (c) Meta Platforms, Inc. and affiliates     -> dynamic thumb-stick idea inside tools/touch-shim.js (injected below, `// <touch-shim>`)
//   dwarfcorp (blecki/dwarfcorp)         : Modified MIT License, Copyright (c) 2015 Completely Fair Games Ltd. -> recipe / station data SHAPE only (tags, counts, craft location). No images, models, sounds or music were used.
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction,
//   including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so,
//   subject to the following conditions: The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
//   IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
//   OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//
//   copyleft, PRIVATE build, structure / idea only (no text, code or art was pasted; re-clean before ever sharing):
//   // borrowed: watabou/towngeneratoros Source/com/watabou/towngenerator (GPL-3.0)        -> ward / patch / lot-bisection idea, re-implemented on a cell grid in `<town-core>`
//   // borrowed: flareteam/flare-game mods + items (CC BY-SA 3.0)                          -> status-flag dialogue gating, vendor stock gating, quest schema, item -> timed-effect indirection
//   // borrowed: cleverraven/cataclysm-dda data/json (CC BY-SA 3.0)                        -> requirement lists with any-of components, tiered base-upgrade recipes, vendor markup / restock rule, relative food sizes
// </third-party-notices> ========================================================================================================

