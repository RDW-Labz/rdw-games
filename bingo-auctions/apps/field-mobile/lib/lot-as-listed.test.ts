import { describe, it, expect } from 'vitest';
import { resolveLotAsListedSnapshot, lotConditionLabel, type LotAsListedFields } from './lot-as-listed';

const baseLot: LotAsListedFields = {
  title: 'Cordless drill',
  description: 'Used once, box included.',
  condition: 'open_box',
  photoUrls: ['https://cdn.example/a.jpg', 'https://cdn.example/b.jpg'],
  lotUpdatedAt: '2026-10-01T12:00:00Z',
};

describe('resolveLotAsListedSnapshot', () => {
  it('passes through the lot fields unchanged', () => {
    const snap = resolveLotAsListedSnapshot(baseLot, { paidAt: '2026-10-01T12:00:00Z' });
    expect(snap.title).toBe(baseLot.title);
    expect(snap.description).toBe(baseLot.description);
    expect(snap.condition).toBe(baseLot.condition);
    expect(snap.photoUrls).toEqual(baseLot.photoUrls);
  });

  it('editCheckPossible=false and mayBeEditedAfterSale=false when there is no paid_at', () => {
    const snap = resolveLotAsListedSnapshot(baseLot, { paidAt: null });
    expect(snap.editCheckPossible).toBe(false);
    expect(snap.mayBeEditedAfterSale).toBe(false);
  });

  it('editCheckPossible=false when the lot has no updated_at to compare', () => {
    const snap = resolveLotAsListedSnapshot(
      { ...baseLot, lotUpdatedAt: null },
      { paidAt: '2026-10-01T12:00:00Z' },
    );
    expect(snap.editCheckPossible).toBe(false);
    expect(snap.mayBeEditedAfterSale).toBe(false);
  });

  it('not flagged when updated_at is before the sale', () => {
    const snap = resolveLotAsListedSnapshot(
      { ...baseLot, lotUpdatedAt: '2026-09-01T00:00:00Z' },
      { paidAt: '2026-10-01T12:00:00Z' },
    );
    expect(snap.editCheckPossible).toBe(true);
    expect(snap.mayBeEditedAfterSale).toBe(false);
  });

  it('not flagged when updated_at is the same moment as the sale (within slack)', () => {
    const snap = resolveLotAsListedSnapshot(
      { ...baseLot, lotUpdatedAt: '2026-10-01T12:00:10Z' },
      { paidAt: '2026-10-01T12:00:00Z' },
    );
    expect(snap.mayBeEditedAfterSale).toBe(false);
  });

  it('flagged when updated_at is clearly after the sale', () => {
    const snap = resolveLotAsListedSnapshot(
      { ...baseLot, lotUpdatedAt: '2026-10-02T09:00:00Z' },
      { paidAt: '2026-10-01T12:00:00Z' },
    );
    expect(snap.editCheckPossible).toBe(true);
    expect(snap.mayBeEditedAfterSale).toBe(true);
  });

  it('is defensive against unparsable timestamps', () => {
    const snap = resolveLotAsListedSnapshot(
      { ...baseLot, lotUpdatedAt: 'not-a-date' },
      { paidAt: 'also-not-a-date' },
    );
    expect(snap.mayBeEditedAfterSale).toBe(false);
  });
});

describe('lotConditionLabel', () => {
  it('maps known condition codes to display labels', () => {
    expect(lotConditionLabel('appears_new')).toBe('Appears New');
    expect(lotConditionLabel('open_box')).toBe('Open Box');
    expect(lotConditionLabel('good')).toBe('Good');
    expect(lotConditionLabel('as_is')).toBe('As-Is');
  });

  it('falls back to the raw value for an unknown code', () => {
    expect(lotConditionLabel('mystery')).toBe('mystery');
  });

  it('returns null for null', () => {
    expect(lotConditionLabel(null)).toBeNull();
  });
});
