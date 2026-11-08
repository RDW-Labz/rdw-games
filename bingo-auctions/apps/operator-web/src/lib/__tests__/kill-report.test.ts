import { describe, expect, it } from 'vitest';
import {
  buildKillReport,
  killState,
  normalizeScreen,
  type KillRow,
  type OtaPublish,
} from '../kill-report';

function bgMsg(screen: string): string {
  return `silent exit on ${screen} — process died while in the background (user had switched away), no JS error`;
}

function fgMsg(screen: string): string {
  return `silent exit on ${screen} — process died while in the foreground, no JS error`;
}

function row(partial: Partial<KillRow> & Pick<KillRow, 'created_at' | 'app' | 'message'>): KillRow {
  return {
    platform: 'ios',
    device_model: 'iPad (8th generation)',
    os_version: '26.2',
    ota_update: '01a131b8-abcd-ef00-0000-000000000001',
    screen: '/lotting/photo',
    ...partial,
  };
}

describe('killState', () => {
  it('classifies foreground, background, mid-transition, and unknown', () => {
    expect(
      killState('silent exit on /x — process died while in the foreground, watchdog'),
    ).toBe('foreground');
    expect(
      killState(
        'silent exit on /x — process died while in the background (user had switched away), watchdog',
      ),
    ).toBe('background');
    expect(killState('silent exit on /x — process died mid-transition, watchdog')).toBe('other');
    expect(killState('silent exit on /x — process died in an unknown state, watchdog')).toBe(
      'other',
    );
  });
});

describe('normalizeScreen', () => {
  it('replaces uuids and numeric path segments', () => {
    expect(normalizeScreen(null)).toBe('unknown');
    expect(normalizeScreen('/lot/550e8400-e29b-41d4-a716-446655440000')).toBe('/lot/:id');
    expect(normalizeScreen('/auction/12345/bid')).toBe('/auction/:id/bid');
  });
});

describe('buildKillReport', () => {
  const now = new Date('2026-10-13T22:00:00.000Z');
  const staffPublish: OtaPublish = {
    app: 'staff',
    branch: 'production',
    group_id: '81e8487a-1111-2222-3333-444444444444',
    update_ids: ['01a131b8-abcd-ef00-0000-000000000001'],
    published_at: '2026-10-13T21:05:00.000Z',
  };

  it('handles the 29-kill warehouse scenario without worry', () => {
    const rows: KillRow[] = [];
    for (let i = 0; i < 17; i++) {
      const minute = 5 + i;
      rows.push(
        row({
          app: 'staff',
          created_at: `2026-10-13T21:${String(minute).padStart(2, '0')}:00.000Z`,
          message: bgMsg('/lotting/warehouse'),
          screen: '/lotting/warehouse',
        }),
      );
    }
    const bidderScreens = ['/browse', '/lot/1', '/cart', '/account'];
    for (let i = 0; i < 12; i++) {
      const fg = i < 4;
      rows.push(
        row({
          app: 'bidder',
          created_at: `2026-10-13T21:${String(20 + i).padStart(2, '0')}:00.000Z`,
          message: fg ? fgMsg(bidderScreens[i]!) : bgMsg('/home'),
          screen: fg ? bidderScreens[i]! : '/home',
          device_model: 'iPhone 14',
          ota_update: 'deadbeef-abcd-ef00-0000-000000000099',
        }),
      );
    }

    const { subject, text, worry, foreground, background } = buildKillReport({
      now,
      rows,
      yesterdaySameHour: 8,
      publishes: [staffPublish],
    });

    expect(worry).toBe(false);
    expect(foreground).toBe(4);
    expect(background).toBe(25);
    expect(subject).toContain('no action needed');
    expect(text.toLowerCase()).not.toContain('memory footprint');
    expect(text.startsWith('What this means:\nThe ')).toBe(true);
    const lead = (text.split('\n\n')[0] ?? '').replace(/^What this means:\n/, '');
    expect((lead.match(/[.!?](\s|$)/g) ?? []).length).toBeLessThanOrEqual(3);
    expect(text).toContain('Staff update published at 16:05');
    expect(text).toContain('29 kills / 60 min (8 yesterday same hour)');
    expect(text).toContain('Staff app: 17 (foreground 0, background 17)');
    expect(text).toContain('Customer app: 12 (foreground 4, background 8)');
  });

  it('sets worry when one screen has >= 3 foreground kills', () => {
    const rows: KillRow[] = [];
    for (let i = 0; i < 4; i++) {
      rows.push(
        row({
          app: 'staff',
          created_at: `2026-10-13T21:${50 + i}:00.000Z`,
          message: fgMsg('/lotting/photo'),
          screen: '/lotting/photo',
        }),
      );
    }

    const { subject, text, worry } = buildKillReport({
      now,
      rows,
      yesterdaySameHour: 0,
      publishes: [staffPublish],
    });

    expect(worry).toBe(true);
    expect(subject).toContain('foreground on /lotting/photo');
    expect(text).toContain('memory footprint');
    expect(text).toContain('Foreground kills >= 3 on /lotting/photo');
  });

  it('omits publish flag when publish is older than 2 hours', () => {
    const oldPublish: OtaPublish = {
      ...staffPublish,
      published_at: '2026-10-13T18:00:00.000Z',
    };
    const rows = [
      row({
        app: 'staff',
        created_at: '2026-10-13T21:50:00.000Z',
        message: bgMsg('/x'),
      }),
    ];

    const { text } = buildKillReport({
      now,
      rows,
      yesterdaySameHour: 0,
      publishes: [oldPublish],
    });

    expect(text).not.toContain('update published at');
  });

  it('maps update ids to groups, marks (new), and sorts raw rows newest first', () => {
    const rows = [
      row({
        app: 'staff',
        created_at: '2026-10-13T21:40:00.000Z',
        message: bgMsg('/a'),
        screen: '/a',
      }),
      row({
        app: 'staff',
        created_at: '2026-10-13T21:55:00.000Z',
        message: bgMsg('/b'),
        screen: '/b',
      }),
    ];

    const { text } = buildKillReport({
      now,
      rows,
      yesterdaySameHour: 0,
      publishes: [staffPublish],
    });

    expect(text).toContain('01a131b8 (new: group 81e8487a, production, published 16:05)');
    expect(text).toContain('2 kills · top screen');
    const rawIdx = text.indexOf('Raw rows (newest first):');
    const rawBlock = text.slice(rawIdx);
    const firstRaw = rawBlock.split('\n')[1];
    const secondRaw = rawBlock.split('\n')[2];
    expect(firstRaw).toContain('16:55');
    expect(secondRaw).toContain('16:40');
  });

  it('says a preview + production republish once, not twice', () => {
    const rows = Array.from({ length: 10 }, (_, k) =>
      row({ app: 'staff', created_at: `2026-10-13T21:${10 + k}:00.000Z`, message: bgMsg('/'), screen: '/' }),
    );
    const preview: OtaPublish = { ...staffPublish, branch: 'preview', group_id: '190dc439-8bc3-42a2-89eb-dca4945dd045', update_ids: [] };
    const { text } = buildKillReport({ now, rows, yesterdaySameHour: 0, publishes: [preview, staffPublish] });
    expect(text.split('Staff update published at').length - 1).toBe(1);
  });
});
