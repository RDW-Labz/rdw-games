import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { WarehousesV2 } from '../WarehousesV2';
import { warehousesV2Fixture } from '../__fixtures__/warehouses-fixture';

describe('WarehousesV2', () => {
  it('shows inactive badge and off-site chip', () => {
    const html = renderToString(<WarehousesV2 {...warehousesV2Fixture} />);
    expect(html).toContain('Inactive');
    expect(html).toContain('Off-site');
    expect(html).toContain('Crandall');
  });

  it('staggers warehouse rows', () => {
    const html = renderToString(<WarehousesV2 {...warehousesV2Fixture} />);
    expect(html.match(/console-v2-motion-row-in/g)?.length).toBe(warehousesV2Fixture.rows.length);
  });
});

describe('WarehousesV2 — v1 structure as a table, v2 skin', () => {
  const html = renderToString(<WarehousesV2 {...warehousesV2Fixture} />);
  const text = (s: string) => s.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, '');
  const rowHtml = (id: string) => html.split('<tr ').slice(1).find((r) => r.includes(`/warehouses/${id}"`))!;

  it('lays the v1 row contents out as columns in v1 order', () => {
    expect(html).toContain('<table');
    const headers = [...html.matchAll(/<th scope="col" data-col="([a-z]+)"/g)].map((m) => m[1]);
    expect(headers).toEqual(['title', 'location', 'plan', 'mode', 'setup']);
    const thead = html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'));
    expect(text(thead)).toBe('NameLocationFloor planPickup modeSetup');
  });

  it('restores v1 floor-plan wording and keeps city, pickup mode and Setup →', () => {
    const rogers = text(rowHtml('wh-rogers'));
    expect(rogers).toContain('Rogers, AR');
    expect(rogers).toContain('Floor plan uploaded');
    expect(rogers).toContain('Counter pickup');
    expect(rogers).toContain('Setup →');
    expect(text(rowHtml('wh-crandall'))).toContain('No floor plan');
    expect(html.match(/>Setup →<\/a>/g)?.length).toBe(warehousesV2Fixture.rows.length);
  });

  it('puts Inactive and Off-site small under the name; no images (v1 has none)', () => {
    expect(rowHtml('wh-closed')).toMatch(/console-v2-list-meta"><span class="console-v2-list-inactive">Inactive/);
    expect(rowHtml('wh-crandall')).toMatch(/console-v2-list-meta"><span class="console-v2-list-offsite">Off-site/);
    expect(rowHtml('wh-rogers')).not.toContain('console-v2-list-meta');
    expect(html).not.toContain('<img');
  });
});
