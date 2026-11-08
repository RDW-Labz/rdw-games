import { describe, expect, it } from 'vitest';
import {
  FLOOR_WORKFLOW_ORDER,
  rankStagesByUrgency,
  type FloorStage,
} from '../floor-story';

function stage(
  id: FloorStage['id'],
  count: number | null,
  overrides: Partial<FloorStage> = {},
): FloorStage {
  return {
    id,
    label: id,
    purpose: '',
    hue: id,
    href: `/${id}`,
    count,
    countLabel: null,
    primaryAction: null,
    ...overrides,
  };
}

describe('rankStagesByUrgency', () => {
  it('puts pickup first when customers are at the counter', () => {
    const stages = FLOOR_WORKFLOW_ORDER.map((id) =>
      stage(id, id === 'pickup' ? 3 : id === 'auction' ? 50 : 0),
    );
    const ranked = rankStagesByUrgency(stages);
    expect(ranked[0]?.id).toBe('pickup');
  });

  it('puts empty stages last', () => {
    const stages = [
      stage('intake', 0),
      stage('lotting', 5),
      stage('auction', 0),
      stage('paid', 2),
      stage('pickup', 0),
    ];
    const ranked = rankStagesByUrgency(stages);
    expect(ranked.map((s) => s.id)).toEqual(['lotting', 'paid', 'intake', 'auction', 'pickup']);
  });

  it('breaks ties in workflow order', () => {
    const stages = [
      stage('pickup', 0),
      stage('paid', 4),
      stage('auction', 4),
      stage('lotting', 4),
      stage('intake', 4),
    ];
    const ranked = rankStagesByUrgency(stages);
    expect(ranked.map((s) => s.id)).toEqual(['intake', 'lotting', 'auction', 'paid', 'pickup']);
  });

  it('treats null counts as no waiting work', () => {
    const stages = [stage('intake', null), stage('lotting', 2), stage('auction', null)];
    const ranked = rankStagesByUrgency(stages);
    expect(ranked.map((s) => s.id)).toEqual(['lotting', 'intake', 'auction']);
  });
});

describe('formatCount', () => {
  it('adds thousands separators', async () => {
    const { formatCount } = await import('../floor-story');
    expect(formatCount(2921)).toBe('2,921');
    expect(formatCount(37000)).toBe('37,000');
    expect(formatCount(20)).toBe('20');
  });
});
