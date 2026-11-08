import { describe, it, expect } from 'vitest';
import { normalizeIdentification } from '../identification';

// C1 hardening (2026-06-21): the normalizer must reject hallucinated
// placeholder / prompt-leakage values in brand/model (e.g. model="BEFORE")
// and cap oversized fields, WITHOUT over-filtering real values.
describe('normalizeIdentification - placeholder + length hardening', () => {
  it('drops the "BEFORE" prompt-leakage word from model', () => {
    const r = normalizeIdentification({ title: 'iPhone 12 Pro Max Case', model: 'BEFORE' });
    expect(r?.model).toBe('');
  });

  it('drops generic placeholder tokens from model', () => {
    for (const junk of ['N/A', 'Unknown', 'Generic', 'None', 'not visible', 'see photo', '-']) {
      expect(normalizeIdentification({ title: 'thing', model: junk })?.model).toBe('');
    }
  });

  it('drops generic placeholder tokens from brand', () => {
    for (const junk of ['Unknown', 'Generic', 'N/A', 'Unbranded']) {
      expect(normalizeIdentification({ title: 'plain object', brand: junk })?.brand).toBe('');
    }
  });

  it('keeps a real brand + model (no over-filtering)', () => {
    const r = normalizeIdentification({ title: 'DEWALT Li-Ion Charger DCB1107', brand: 'DEWALT', model: 'DCB1107' });
    expect(r?.model).not.toBe('');
    expect(r?.brand).not.toBe('');
  });

  it('still strips Amazon-shaped codes from model (regression)', () => {
    expect(normalizeIdentification({ title: 'thing', model: 'B0DGJ7HYG1' })?.model).toBe('');
  });

  it('caps an oversized model to 60 chars', () => {
    const long = 'this is clearly a whole sentence the model dumped into the wrong field and not a real sku at all';
    const m = normalizeIdentification({ title: 'thing', model: long })?.model ?? '';
    expect(m.length).toBeLessThanOrEqual(60);
  });

  it('caps title to 250 chars', () => {
    const t = normalizeIdentification({ title: 'A'.repeat(400) })?.title ?? '';
    expect(t.length).toBeLessThanOrEqual(250);
  });

  it('returns null on non-object input', () => {
    expect(normalizeIdentification(null)).toBeNull();
    expect(normalizeIdentification('nope')).toBeNull();
  });
});

describe('normalizeIdentification — UPC must be readable, never raw model text', () => {
  const base = { title: 'Party cups 50ct', brand: '', model: '', category: '', condition: 'new' };
  it('drops an invented UPC instead of passing it through (2026-09-23)', () =>
    expect(normalizeIdentification({ ...base, upc: '00012345678901' })?.upc).toBe(''));
  it('drops a non-UPC string rather than keeping it raw', () =>
    expect(normalizeIdentification({ ...base, upc: 'not visible' })?.upc).toBe(''));
  it('keeps a real UPC', () =>
    expect(normalizeIdentification({ ...base, upc: '036000291452' })?.upc).toBe('036000291452'));
});

