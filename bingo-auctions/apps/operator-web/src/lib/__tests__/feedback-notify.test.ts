import { describe, expect, it } from 'vitest';
import {
  buildBatchEmail,
  buildDigestEmail,
  buildFeedbackEmail,
  buildReplyEmail,
  chicagoDayHour,
  isDigestHour,
  parseRecipients,
  planNotify,
  senderLabel,
  staleNew,
  type FeedbackItem,
} from '../feedback-notify';

const BASE = 'https://console.example.test';
const item = (over: Partial<FeedbackItem> = {}): FeedbackItem => ({
  id: '11111111-1111-1111-1111-111111111111',
  created_at: '2026-10-30T15:00:00Z',
  app: 'staff',
  kind: 'bug',
  message: 'Bin audit count jumps from 5 to 8\nafter scanning',
  reporter_label: 'Pat',
  screen: '/layout/bins/audit',
  app_version: '1.0.1',
  update_id: 'ab1b2651-c175-482e-9b6c-27de8a8f7e35',
  platform: 'android',
  os_version: '14',
  device_model: 'SM-A156U',
  status: 'new',
  has_reply_to: false,
  attachment_urls: [],
  ...over,
});

describe('new-feedback email', () => {
  it('carries the full text, worker, app, screen, device, version and console link', () => {
    const e = buildFeedbackEmail(item({ attachment_urls: ['https://signed.example/a.png'] }), BASE);
    expect(e.subject).toBe('[BinGo feedback] Bug · Staff app · Bin audit count jumps from 5 to 8');
    expect(e.text).toContain('Bin audit count jumps from 5 to 8\nafter scanning');
    expect(e.text).toContain('From: Worker: Pat');
    expect(e.text).toContain('Screen: /layout/bins/audit');
    expect(e.text).toContain('Device: SM-A156U · Android 14');
    expect(e.text).toContain('Version: v1.0.1 · update ab1b2651');
    expect(e.text).toContain('Sent: Oct 30, 2026, 10:00 AM CT');
    expect(e.text).toContain('https://signed.example/a.png');
    expect(e.text).toContain(`${BASE}/feedback#fb-11111111-1111-1111-1111-111111111111`);
  });

  it('never names a customer; says whether a reply-to exists', () => {
    expect(senderLabel({ app: 'web', reporter_label: null, has_reply_to: true })).toBe('Customer (reply-to email on file)');
    expect(senderLabel({ app: 'bidder', reporter_label: 'someone', has_reply_to: false })).toBe('Customer');
    expect(senderLabel({ app: 'staff', reporter_label: null, has_reply_to: false })).toBe('Worker: not clocked in');
  });
});

describe('burst throttle', () => {
  it('sends up to the cap one by one and batches the rest', () => {
    const p = planNotify([1, 2, 3, 4, 5, 6, 7], 0);
    expect(p.single).toEqual([1, 2, 3, 4, 5]);
    expect(p.batched).toEqual([6, 7]);
  });
  it('counts what already went out in the window', () => {
    expect(planNotify([1, 2, 3], 4)).toEqual({ single: [1], batched: [2, 3] });
    expect(planNotify([1, 2], 9)).toEqual({ single: [], batched: [1, 2] });
  });
  it('batch email lists every item with its link', () => {
    const e = buildBatchEmail([item({ id: 'a' }), item({ id: 'b', app: 'web', has_reply_to: true })], BASE);
    expect(e.subject).toBe('[BinGo feedback] 2 more new items');
    expect(e.text).toContain('#fb-a');
    expect(e.text).toContain('#fb-b');
    expect(e.text).toContain('Customer (reply-to email on file)');
  });
});

describe('daily digest', () => {
  it('fires only in the 07:00 Chicago hour, across both DST changes', () => {
    expect(isDigestHour(new Date('2026-10-30T12:05:00Z'))).toBe(true); // 07:05 CDT
    expect(isDigestHour(new Date('2026-11-02T13:05:00Z'))).toBe(true); // 07:05 CST
    expect(isDigestHour(new Date('2026-11-02T12:05:00Z'))).toBe(false); // 06:05 CST
    expect(isDigestHour(new Date('2027-03-15T12:05:00Z'))).toBe(true); // 07:05 CDT
    expect(chicagoDayHour(new Date('2026-11-01T05:30:00Z'))).toEqual({ day: '2026-11-01', hour: 0 });
  });
  it('lists only items still New for more than 24 hours', () => {
    const now = new Date('2026-10-31T12:00:00Z');
    const rows = [
      item({ id: 'old-new', created_at: '2026-10-29T11:00:00Z' }),
      item({ id: 'fresh', created_at: '2026-10-31T00:00:00Z' }),
      item({ id: 'old-fixed', created_at: '2026-10-20T00:00:00Z', status: 'fixed' }),
    ];
    expect(staleNew(rows, now).map((r) => r.id)).toEqual(['old-new']);
    const d = buildDigestEmail(staleNew(rows, now), now, BASE);
    expect(d.subject).toBe('[BinGo feedback] Daily: 1 item still New after 24 hours');
    expect(d.text).toContain('2d · Staff app · Worker: Pat');
  });
});

describe('reply email and recipients', () => {
  it('quotes the original under the reply', () => {
    const r = buildReplyEmail('Fixed in today\'s update.', 'Page froze\nafter paying');
    expect(r.text).toBe("Fixed in today's update.\n\n— BinGo Auctions\n\n> You wrote:\n> Page froze\n> after paying");
  });
  it('parses a typed recipient list and drops junk', () => {
    expect(parseRecipients('a@x.test; b@x.test, a@x.test  nope')).toEqual(['a@x.test', 'b@x.test']);
    expect(parseRecipients(undefined)).toEqual([]);
  });
});
