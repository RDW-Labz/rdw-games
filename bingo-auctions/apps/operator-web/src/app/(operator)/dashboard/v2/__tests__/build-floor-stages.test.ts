import { describe, expect, it } from 'vitest';
import { buildFloorStages } from '../build-floor-stages';
import { rankStagesByUrgency } from '../floor-story';

const today = { atCounter: 24, closingWithin2h: 171, paidPickupEndingWithin24h: 13, noSticker: 344 };

describe('buildFloorStages — actionable-today counts', () => {
  it('Intake is link only (no count, no action)', () => {
    const intake = buildFloorStages(today).find((s) => s.id === 'intake')!;
    expect(intake.count).toBeNull();
    expect(intake.primaryAction).toBeNull();
    expect(intake.href).toBe('/loads');
  });

  it('each counted stage says what its number means', () => {
    const byId = Object.fromEntries(buildFloorStages(today).map((s) => [s.id, s]));
    expect(byId.lotting).toMatchObject({ count: 344, countLabel: 'with no sticker' });
    expect(byId.auction).toMatchObject({ count: 171, countLabel: 'closing within 2 h' });
    expect(byId.paid).toMatchObject({ count: 13, countLabel: 'pickup window ends < 24 h' });
    expect(byId.pickup).toMatchObject({ count: 24, countLabel: 'at the counter' });
    expect(byId.pickup?.primaryAction?.label).toBe('Check out 24 →');
  });

  it('a stage with nothing waiting has no action button', () => {
    const stages = buildFloorStages({ ...today, closingWithin2h: 0, paidPickupEndingWithin24h: null });
    expect(stages.find((s) => s.id === 'auction')!.primaryAction).toBeNull();
    expect(stages.find((s) => s.id === 'paid')!.primaryAction).toBeNull();
  });

  it('pickup at the counter still ranks first', () => {
    expect(rankStagesByUrgency(buildFloorStages(today))[0]!.id).toBe('pickup');
  });

  it('with nobody at the counter, the next stage with work leads and carries its own label', () => {
    const ranked = rankStagesByUrgency(buildFloorStages({ ...today, atCounter: 0 }));
    expect(ranked[0]!.id).toBe('lotting');
    expect(ranked[0]!.countLabel).toBe('with no sticker');
  });
});
