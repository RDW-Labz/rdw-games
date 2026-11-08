import { describe, expect, it } from 'vitest';
import {
  NEUTRAL_STAGE_HUE,
  STAGE_IDS,
  lotFloorStage,
  stageCardClassName,
  stageHueClassName,
  stageHueTokens,
  toStageId,
} from '../stage-hue';

describe('stage-hue', () => {
  it('lists the five floor stages in workflow order', () => {
    expect(STAGE_IDS).toEqual(['intake', 'lotting', 'auction', 'paid', 'pickup']);
  });

  it.each([
    [
      'intake',
      {
        fg: 'var(--console-stage-intake-fg)',
        text: 'var(--console-stage-intake-text)',
        bg: 'var(--console-stage-intake-bg)',
        glow: 'var(--console-stage-intake-glow)',
      },
    ],
    [
      'lotting',
      {
        fg: 'var(--console-stage-lotting-fg)',
        text: 'var(--console-stage-lotting-text)',
        bg: 'var(--console-stage-lotting-bg)',
        glow: 'var(--console-stage-lotting-glow)',
      },
    ],
    [
      'auction',
      {
        fg: 'var(--console-stage-auction-fg)',
        text: 'var(--console-stage-auction-text)',
        bg: 'var(--console-stage-auction-bg)',
        glow: 'var(--console-stage-auction-glow)',
      },
    ],
    [
      'paid',
      {
        fg: 'var(--console-stage-paid-fg)',
        text: 'var(--console-stage-paid-text)',
        bg: 'var(--console-stage-paid-bg)',
        glow: 'var(--console-stage-paid-glow)',
      },
    ],
    [
      'pickup',
      {
        fg: 'var(--console-stage-pickup-fg)',
        text: 'var(--console-stage-pickup-text)',
        bg: 'var(--console-stage-pickup-bg)',
        glow: 'var(--console-stage-pickup-glow)',
      },
    ],
  ] as const)('%s maps to its own -fg / -text / -bg / -glow tokens', (stage, tokens) => {
    expect(stageHueTokens(stage)).toEqual(tokens);
    expect(stageHueClassName(stage)).toBe(`console-v2-stage-hued console-v2-stage-hue--${stage}`);
  });

  it('accepts labels as well as ids', () => {
    expect(toStageId('Pickup')).toBe('pickup');
    expect(stageHueTokens('Lotting').text).toBe('var(--console-stage-lotting-text)');
  });

  it.each([null, undefined, '', 'Missing items', 'warehouse', 42])(
    'unknown %p is neutral (off-white text, plain edge, no glow)',
    (value) => {
      expect(toStageId(value)).toBeNull();
      expect(stageHueTokens(value)).toEqual(NEUTRAL_STAGE_HUE);
      expect(NEUTRAL_STAGE_HUE.text).toBe('var(--console-ink)');
      expect(NEUTRAL_STAGE_HUE.glow).toBe('none');
      expect(stageHueClassName(value)).toBe('');
    },
  );

  it('card class: hue always, current only when asked', () => {
    expect(stageCardClassName('auction')).toBe(
      'console-v2-stage-card console-v2-stage-hued console-v2-stage-hue--auction',
    );
    expect(stageCardClassName('pickup', { current: true, extra: 'x' })).toBe(
      'console-v2-stage-card console-v2-stage-hued console-v2-stage-hue--pickup console-v2-stage-card--current x',
    );
    expect(stageCardClassName('nope')).toBe('console-v2-stage-card');
  });

  it('places a lot on the floor story', () => {
    expect(lotFloorStage({ lotStatus: 'pending_intake' })).toBe('intake');
    expect(lotFloorStage({ lotStatus: 'in_inventory' })).toBe('lotting');
    expect(lotFloorStage({ lotStatus: 'unsold' })).toBe('lotting');
    expect(lotFloorStage({ lotStatus: 'live' })).toBe('auction');
    expect(lotFloorStage({ lotStatus: 'won', invoiceStatus: 'pending' })).toBe('auction');
    expect(lotFloorStage({ lotStatus: 'won', invoiceStatus: 'paid' })).toBe('paid');
    expect(lotFloorStage({ lotStatus: 'won', invoiceStatus: 'partially_refunded' })).toBe('paid');
    expect(lotFloorStage({ lotStatus: 'won', invoiceStatus: 'paid', pickedUp: true })).toBe('pickup');
    expect(lotFloorStage({ lotStatus: 'canceled' })).toBeNull();
    expect(lotFloorStage({ lotStatus: 'disposed' })).toBeNull();
  });
});
