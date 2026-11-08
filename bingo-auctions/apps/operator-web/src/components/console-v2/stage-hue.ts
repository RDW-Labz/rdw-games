/**
 * The ONE stage → hue mapping for console v2 (FROZEN: Intake teal, Lotting amber,
 * Auction coral, Paid green, Pickup lime). Rails, stat tiles and section titles
 * all read from here; the colours themselves are the --console-stage-<stage>-*
 * tokens in the v2 block of globals.css.
 */

export const STAGE_IDS = ['intake', 'lotting', 'auction', 'paid', 'pickup'] as const;

export type StageId = (typeof STAGE_IDS)[number];

export type StageHueTokens = {
  /** Edge / marker colour. */
  fg: string;
  /** Text on dark surfaces (titles, numbers). */
  text: string;
  /** Tint behind the current stage. */
  bg: string;
  /** Glow around the current stage. */
  glow: string;
};

/** Stage-less: neutral surface, off-white text, plain line edge, no glow. */
export const NEUTRAL_STAGE_HUE: StageHueTokens = {
  fg: 'var(--console-line)',
  text: 'var(--console-ink)',
  bg: 'var(--console-surface-raised)',
  glow: 'none',
};

/** Accepts an id ('pickup') or a label ('Pickup'); anything else is stage-less. */
export function toStageId(value: unknown): StageId | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  return (STAGE_IDS as readonly string[]).includes(key) ? (key as StageId) : null;
}

// Spelled out (not templated) so every token is greppable and covered by the
// token-coverage test.
const STAGE_TOKENS: Record<StageId, StageHueTokens> = {
  intake: {
    fg: 'var(--console-stage-intake-fg)',
    text: 'var(--console-stage-intake-text)',
    bg: 'var(--console-stage-intake-bg)',
    glow: 'var(--console-stage-intake-glow)',
  },
  lotting: {
    fg: 'var(--console-stage-lotting-fg)',
    text: 'var(--console-stage-lotting-text)',
    bg: 'var(--console-stage-lotting-bg)',
    glow: 'var(--console-stage-lotting-glow)',
  },
  auction: {
    fg: 'var(--console-stage-auction-fg)',
    text: 'var(--console-stage-auction-text)',
    bg: 'var(--console-stage-auction-bg)',
    glow: 'var(--console-stage-auction-glow)',
  },
  paid: {
    fg: 'var(--console-stage-paid-fg)',
    text: 'var(--console-stage-paid-text)',
    bg: 'var(--console-stage-paid-bg)',
    glow: 'var(--console-stage-paid-glow)',
  },
  pickup: {
    fg: 'var(--console-stage-pickup-fg)',
    text: 'var(--console-stage-pickup-text)',
    bg: 'var(--console-stage-pickup-bg)',
    glow: 'var(--console-stage-pickup-glow)',
  },
};

export function stageHueTokens(stage: unknown): StageHueTokens {
  const id = toStageId(stage);
  return id ? STAGE_TOKENS[id] : NEUTRAL_STAGE_HUE;
}

/**
 * Class names that put a stage's hue on an element. `console-v2-stage-hued` plus
 * `console-v2-stage-hue--<id>` point the local --console-stage-accent-* props at
 * that stage's tokens (see the "v2 stage hues" CSS block). Stage-less → ''.
 */
export function stageHueClassName(stage: unknown): string {
  const id = toStageId(stage);
  return id ? `console-v2-stage-hued console-v2-stage-hue--${id}` : '';
}

/** Rail / Needs-attention card: hue edge always; tint + glow when current. */
export function stageCardClassName(
  stage: unknown,
  options: { current?: boolean; extra?: string } = {},
): string {
  return [
    'console-v2-stage-card',
    stageHueClassName(stage),
    options.current ? 'console-v2-stage-card--current' : '',
    options.extra ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Which floor stage a lot is in, for the lot-detail rail's current card.
 * Won lots sit in Paid once their invoice is paid (or refunded) and in Pickup once
 * collected; an unpaid win is still the Auction outcome. Canceled / disposed lots
 * have left the floor story → null (no current card).
 */
export function lotFloorStage(input: {
  lotStatus: string;
  invoiceStatus?: string | null;
  pickedUp?: boolean;
}): StageId | null {
  switch (input.lotStatus) {
    case 'pending_intake':
      return 'intake';
    case 'draft':
    case 'in_inventory':
    case 'unsold':
    case 'relisted':
    // 0475: sale fully refunded, item back on the floor waiting to be relisted.
    case 'refunded':
      return 'lotting';
    case 'scheduled':
    case 'live':
      return 'auction';
    case 'won': {
      if (input.pickedUp) return 'pickup';
      const inv = input.invoiceStatus ?? '';
      if (inv === 'paid' || inv.includes('refund')) return 'paid';
      return 'auction';
    }
    default:
      return null;
  }
}
