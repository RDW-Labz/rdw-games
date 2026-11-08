/** Pocket Park design tokens — single source for presentation (system.md). */

function hex(n: number): string {
  return `#${(n & 0xffffff).toString(16).padStart(6, "0")}`;
}

const color = {
  bgTop: 0xfaf3df,
  bgBottom: 0xeee8cf,
  bgLight: 0xfae0b9,
  surfaceTop: 0xfffbee,
  surfaceBottom: 0xf1e8d0,
  raisedTop: 0xfff9e9,
  raisedBottom: 0xfffdf4,
  primaryTop: 0xf58e6c,
  primaryBottom: 0xed7759,
  onPrimary: 0x43271f,
  primaryEdge: 0xcf6248,
  primaryHighlight: 0xffbc94,
  secondary: 0x5c8963,
  text: 0x354b3a,
  textMuted: 0x626950,
  border: 0xd5c8a6,
  controlEdge: 0x626950,
  highlight: 0xffffff,
  shadow: 0x7e6e41,
  focus: 0x354b3a,
  selectedFill: 0xe1edd3,
  selectedEdge: 0x38674c,
  disabledFill: 0xe3ddcc,
  disabledText: 0x354b3a,
  success: 0x38674c,
  warning: 0x8d621a,
  danger: 0xae403b,
  dangerTop: 0xae403b,
  dangerBottom: 0x943630,
  onDanger: 0xffffff,
  scrim: 0x354b3a,
  turfTop: 0xb3d28b,
  turfBottom: 0x87b36f,
  turfEdge: 0x887653,
  turfGrain: 0x354b3a,
  rail: 0xfaf1d7,
  railUnder: 0xb49a71,
  railHighlight: 0xfffdf4,
  sand: 0xe5c786,
  sandLight: 0xf4dfa8,
  sandDot: 0x8d621a,
  waterTop: 0x64b7c6,
  waterBottom: 0x338696,
  waterEdge: 0x276b78,
  waterRipple: 0xe1f9ff,
  slope: 0xd6d294,
  slopeArrow: 0x354b3a,
  mover: 0xbc665c,
  moverEdge: 0x743e38,
  moverHighlight: 0xf0b5a7,
  bumper: 0xa58bc2,
  bumperEdge: 0x59456f,
  bumperHighlight: 0xdacbe9,
  cup: 0x354b3a,
  cupDeep: 0x203428,
  flag: 0xdb6246,
  flagFold: 0xad4930,
  ballLight: 0xffffff,
  ballMid: 0xf2f7e9,
  ballShade: 0xb9cbb8,
  ballMark: 0x626950,
  tee: 0x354b3a,
  tree: 0x5c8963,
  treeLight: 0x80a776,
  trunk: 0x816b45,
  flower: 0xf58e6c,
  star: 0xf3c76b,
  starEdge: 0x8d621a,
  starEmpty: 0xd5c8a6,
  aimLow: 0x3b6659,
  aimMid: 0xad4930,
  aimHigh: 0x764a7b,
  aimAccessible: 0x354b3a,
  aimBacking: 0xfff9e9,
} as const;

const type = {
  logo: { family: "Fredoka", size: 56, weight: 600, lineHeight: 52, tracking: -1 },
  display: { family: "Fredoka", size: 34, weight: 600, lineHeight: 40, tracking: 0 },
  screen: { family: "Fredoka", size: 28, weight: 600, lineHeight: 34, tracking: 0 },
  hole: { family: "Fredoka", size: 20, weight: 500, lineHeight: 26, tracking: 0 },
  action: { family: "Fredoka", size: 20, weight: 600, lineHeight: 24, tracking: 0 },
  number: { family: "Fredoka", size: 40, weight: 600, lineHeight: 44, tracking: 0 },
  body: { family: "Nunito", size: 16, weight: 600, lineHeight: 22, tracking: 0 },
  label: { family: "Nunito", size: 16, weight: 800, lineHeight: 22, tracking: 0 },
  caption: { family: "Nunito", size: 13, weight: 700, lineHeight: 18, tracking: 0 },
} as const;

const space = {
  none: 0,
  hair: 1,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

const radius = {
  small: 8,
  card: 20,
  panel: 24,
  sheet: 28,
  power: 20,
} as const;

const stroke = {
  border: 1,
  mechanic: 2,
  selected: 2,
  focus: 3,
} as const;

type ShadowLayer = { dx: number; dy: number; spread: number; alpha: number; color: keyof typeof color };

const shadow: Record<string, readonly ShadowLayer[]> = {
  small: [
    { dx: 0, dy: 5, spread: 3, alpha: 0.06, color: "shadow" },
    { dx: 0, dy: 2, spread: 0, alpha: 0.12, color: "shadow" },
  ],
  card: [
    { dx: 0, dy: 10, spread: 6, alpha: 0.05, color: "shadow" },
    { dx: 0, dy: 5, spread: 2, alpha: 0.09, color: "shadow" },
    { dx: 0, dy: 2, spread: 0, alpha: 0.1, color: "shadow" },
  ],
  sheet: [
    { dx: 0, dy: 12, spread: 8, alpha: 0.06, color: "shadow" },
    { dx: 0, dy: 6, spread: 3, alpha: 0.1, color: "shadow" },
    { dx: 0, dy: 2, spread: 0, alpha: 0.12, color: "shadow" },
  ],
  primary: [
    { dx: 0, dy: 10, spread: 5, alpha: 0.08, color: "shadow" },
    { dx: 0, dy: 5, spread: 0, alpha: 1, color: "primaryEdge" },
  ],
  pressed: [{ dx: 0, dy: 2, spread: 0, alpha: 0.12, color: "shadow" }],
} as const;

const depth = {
  background: 0,
  ambient: 10,
  decoration: 20,
  islandShadow: 30,
  island: 40,
  terrain: 50,
  track: 60,
  rail: 70,
  cup: 80,
  contactShadow: 90,
  ball: 100,
  flag: 110,
  aim: 120,
  courseFx: 130,
  hud: 200,
  screenTransition: 250,
  scrim: 300,
  sheet: 310,
  sheetContent: 320,
  toast: 400,
  focus: 410,
  dev: 900,
} as const;

const component = {
  pill: {
    primary: { w: 328, h: 56, r: 28, padX: 24 },
    secondary: { w: 328, h: 56, r: 28, padX: 24 },
    destructive: { w: 296, h: 56, r: 28, padX: 24 },
  },
  icon: { size: 56, icon: 22, stroke: 2 },
  chip: { h: 28, minW: 40, padX: 12 },
  toggle: { trackW: 52, trackH: 28, knob: 22, inset: 3, travel: 24, rowH: 64 },
  card: { w: 328, minH: 112, r: 20, pad: 16 },
  holeCard: { w: 158, h: 152, r: 20, pad: 12, thumbW: 134, thumbH: 56 },
  starRow: { small: { size: 18, gap: 6 }, result: { size: 28, gap: 12 } },
  lockBadge: { h: 28, padX: 8, icon: 14, gap: 6 },
  sheet: { w: 328, r: 28, pad: 16, handleW: 32, handleH: 4 },
  result: { w: 328, h: 332, r: 28, pad: 16 },
  toast: { w: 328, minH: 64, maxH: 108, r: 20, pad: 12, icon: 20, gap: 8 },
  topBar: { w: 360, h: 64, gutter: 16, slot: 56, gap: 8 },
  progressDots: { size: 8, gap: 8, activeW: 20, activeH: 8 },
} as const;

const course = {
  islandExtrude: 9,
  mowingStrip: 32,
  mowingRepeat: 64,
  mowingRotation: -24,
  railBacking: 11,
  railCore: 6,
  ballR: 7,
  cupR: 11,
} as const;

const layout = {
  logicalW: 360,
  logicalH: 640,
  gutter: 16,
  contentW: 328,
  sheetInnerW: 296,
  safeTop: 24,
  safeBottom: 40,
} as const;

const motion = {
  duration: {
    instant: 80,
    quick: 160,
    base: 240,
    slow: 400,
    ambientMin: 3000,
    ambientMax: 8000,
    stagger: 24,
    contactIn: 48,
    contactOut: 112,
    toastHold: 4000,
    hintDelay: 1800,
    hintCycle: 2400,
  },
  ease: {
    press: "Cubic.easeOut",
    release: "Cubic.easeOut",
    enter: "Cubic.easeOut",
    exit: "Cubic.easeIn",
    ambient: "Sine.easeInOut",
    drift: "Linear",
    drop: "Cubic.easeIn",
    pop: "Back.easeOut",
    fade: "Linear",
  },
  effect: {
    buttonPress: "buttonPress",
    buttonRelease: "buttonRelease",
    controlAppear: "controlAppear",
    cardAppear: "cardAppear",
    controlExit: "controlExit",
    toggleSlide: "toggleSlide",
    sheetIn: "sheetIn",
    sheetOut: "sheetOut",
  },
  parkMap: {
    menu: { x: 0, y: 0 },
    holes: { x: 1, y: 0 },
    settings: { x: 0, y: -1 },
    play: { x: 1, y: 1 },
    unlock: { x: 2, y: 1 },
    gallery: { x: -1, y: 0 },
  },
} as const;

const budget = {
  ambientSprites: 8,
  liveParticles: 24,
  celebrationParticles: 12,
  splashParticles: 6,
  sandParticles: 4,
  launchParticles: 2,
  impactHighlights: 2,
  ringSprites: 2,
  dynamicCourseSprites: 32,
  effectTweens: 24,
  transitionSnapshots: 1,
  transientTextureMiB: 24,
  textureEdgeMax: 2048,
  textureDprMax: 2,
  textDprMax: 3,
} as const;

const core = {
  color,
  type,
  space,
  radius,
  stroke,
  shadow,
  depth,
  component,
  course,
  layout,
  motion,
  budget,
} as const;

/** Scene compatibility aliases (callers outside src/ui still use flat keys). */
export const TOKENS = {
  ...core,
  bgTop: color.bgTop,
  bgBottom: color.bgBottom,
  panelBg: color.surfaceTop,
  panelBgBottom: color.surfaceBottom,
  panelBorder: color.border,
  panelRadius: radius.card,
  cardRadius: radius.card,
  accentCyan: color.controlEdge,
  accentMagenta: color.bumper,
  accentAmber: color.star,
  accentBlue: color.waterTop,
  accentLime: color.success,
  primaryBtnTop: color.primaryTop,
  primaryBtnBot: color.primaryBottom,
  primaryBtnText: hex(color.onPrimary),
  secondaryBtnTop: color.surfaceTop,
  secondaryBtnBot: color.surfaceBottom,
  secondaryBtnText: hex(color.text),
  disabled: color.disabledFill,
  success: color.success,
  par: color.secondary,
  destructiveTop: color.dangerTop,
  destructiveBot: color.dangerBottom,
  textPrimary: hex(color.text),
  textSecondary: hex(color.textMuted),
  textMuted: hex(color.textMuted),
  primaryBtnW: component.pill.primary.w,
  primaryBtnH: component.pill.primary.h,
  secondaryBtnH: component.pill.secondary.h,
  iconBtnSize: component.icon.size,
  chipH: component.chip.h,
  screenPadding: layout.gutter,
  cardGap: space.sm + 2,
  minTouch: 56,
  safeTop: layout.safeTop,
  safeBottom: layout.safeBottom,
} as const;

export type UiTokens = typeof TOKENS;
export type ColorToken = keyof typeof color;
export type TypeToken = keyof typeof type;
export type DepthToken = keyof typeof depth;
export const DEPTH = TOKENS.depth;

export function cssColor(key: ColorToken): string {
  return hex(color[key]);
}

/** Legacy flat menu button fill — must not appear on new UI (smoke picture check). */
export const LEGACY_FLAT_BTN = { r: 18, g: 22, b: 42 };
