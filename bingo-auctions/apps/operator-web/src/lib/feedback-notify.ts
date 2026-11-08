// New-feedback emails to the owners, the 07:00 digest and the reply email
// (owner 2026-10-30: feedback landed in /feedback and nobody was told).
// Pure: no I/O. lib/cron/feedback-notify.ts does the reads and sends.

export const NOTIFY_BURST_CAP = 5;
export const NOTIFY_BURST_WINDOW_MS = 10 * 60 * 1000;
export const DIGEST_HOUR_CT = 7;
export const DIGEST_STALE_MS = 24 * 60 * 60 * 1000;
const TZ = 'America/Chicago';

export type FeedbackItem = {
  id: string;
  created_at: string;
  app: 'bidder' | 'staff' | 'web';
  kind: 'bug' | 'idea';
  message: string;
  reporter_label: string | null;
  screen: string | null;
  app_version: string | null;
  update_id: string | null;
  platform: string | null;
  os_version: string | null;
  device_model: string | null;
  status: string;
  has_reply_to: boolean;
  attachment_urls: string[];
};

const APP_NAME: Record<FeedbackItem['app'], string> = {
  staff: 'Staff app',
  bidder: 'Bidder app',
  web: 'Website',
};

/** Who sent it, without customer names or addresses. */
export function senderLabel(item: Pick<FeedbackItem, 'app' | 'reporter_label' | 'has_reply_to'>): string {
  if (item.app === 'staff') return item.reporter_label?.trim() ? `Worker: ${item.reporter_label.trim()}` : 'Worker: not clocked in';
  return item.has_reply_to ? 'Customer (reply-to email on file)' : 'Customer';
}

export function consoleLink(baseUrl: string, id: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/feedback#fb-${id}`;
}

function ctTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }) + ' CT';
}

function deviceLine(i: FeedbackItem): string {
  const os = i.os_version ? `${i.platform === 'ios' ? 'iOS' : i.platform === 'android' ? 'Android' : i.platform ?? 'OS'} ${i.os_version}` : i.platform ?? '';
  return [i.device_model, os].filter(Boolean).join(' · ') || 'unknown';
}

function versionLine(i: FeedbackItem): string {
  const upd = i.update_id && i.update_id !== 'embedded' ? `update ${i.update_id.slice(0, 8)}` : i.update_id ? 'built-in bundle' : '';
  return [i.app_version ? `v${i.app_version}` : '', upd].filter(Boolean).join(' · ') || 'unknown';
}

export function buildFeedbackEmail(item: FeedbackItem, baseUrl: string): { subject: string; text: string } {
  const first = item.message.trim().split('\n')[0]!.slice(0, 60);
  const subject = `[BinGo feedback] ${item.kind === 'bug' ? 'Bug' : 'Idea'} · ${APP_NAME[item.app]} · ${first}`;
  const lines = [
    item.message.trim(),
    '',
    `From: ${senderLabel(item)}`,
    `App: ${APP_NAME[item.app]}`,
    `Screen: ${item.screen ?? 'unknown'}`,
    `Device: ${deviceLine(item)}`,
    `Version: ${versionLine(item)}`,
    `Sent: ${ctTime(item.created_at)}`,
  ];
  if (item.attachment_urls.length > 0) {
    lines.push('', `Screenshots/recordings (links expire in 7 days):`, ...item.attachment_urls.map((u) => `  ${u}`));
  }
  lines.push('', `Open in the console: ${consoleLink(baseUrl, item.id)}`);
  return { subject, text: lines.join('\n') };
}

/** One combined email for a burst past the cap. */
export function buildBatchEmail(items: FeedbackItem[], baseUrl: string): { subject: string; text: string } {
  const subject = `[BinGo feedback] ${items.length} more new item${items.length === 1 ? '' : 's'}`;
  const blocks = items.map((i) =>
    [
      `— ${i.kind === 'bug' ? 'Bug' : 'Idea'} · ${APP_NAME[i.app]} · ${senderLabel(i)} · ${ctTime(i.created_at)}`,
      i.message.trim(),
      `Screen: ${i.screen ?? 'unknown'} · Device: ${deviceLine(i)} · Version: ${versionLine(i)}`,
      ...(i.attachment_urls.length ? [`Attachments: ${i.attachment_urls.join(' ')}`] : []),
      consoleLink(baseUrl, i.id),
    ].join('\n'),
  );
  return { subject, text: `Several reports arrived at once; the rest are in one email.\n\n${blocks.join('\n\n')}` };
}

/**
 * Burst throttle: at most NOTIFY_BURST_CAP individual emails per window.
 * `sentInWindow` = items already notified in the last window. Anything past
 * the allowance goes out as ONE combined email so nothing waits.
 */
export function planNotify<T>(pending: T[], sentInWindow: number, cap = NOTIFY_BURST_CAP): { single: T[]; batched: T[] } {
  const allowance = Math.max(0, cap - sentInWindow);
  return { single: pending.slice(0, allowance), batched: pending.slice(allowance) };
}

/** Chicago calendar day (YYYY-MM-DD) and hour for `now`. */
export function chicagoDayHour(now: Date): { day: string; hour: number } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

export function isDigestHour(now: Date): boolean {
  return chicagoDayHour(now).hour === DIGEST_HOUR_CT;
}

/** Still 'new' and older than 24 hours. */
export function staleNew<T extends { status: string; created_at: string }>(items: T[], now: Date): T[] {
  return items.filter((i) => i.status === 'new' && now.getTime() - new Date(i.created_at).getTime() > DIGEST_STALE_MS);
}

export function buildDigestEmail(items: FeedbackItem[], now: Date, baseUrl: string): { subject: string; text: string } {
  const subject = `[BinGo feedback] Daily: ${items.length} item${items.length === 1 ? '' : 's'} still New after 24 hours`;
  const ageDays = (iso: string) => Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
  const rows = items.map(
    (i) => `• ${ageDays(i.created_at)}d · ${APP_NAME[i.app]} · ${senderLabel(i)} · ${i.message.trim().replace(/\s+/g, ' ').slice(0, 120)}\n  ${consoleLink(baseUrl, i.id)}`,
  );
  return { subject, text: `Still New for more than 24 hours, oldest first:\n\n${rows.join('\n')}\n\nAll feedback: ${baseUrl.replace(/\/+$/, '')}/feedback` };
}

export function buildReplyEmail(reply: string, originalMessage: string): { subject: string; text: string } {
  return {
    subject: 'Re: your feedback to BinGo Auctions',
    text: `${reply.trim()}\n\n— BinGo Auctions\n\n> You wrote:\n${originalMessage
      .trim()
      .split('\n')
      .map((l) => `> ${l}`)
      .join('\n')}`,
  };
}

/** Comma/semicolon/space separated list; anything without an @ is dropped. */
export function parseRecipients(raw: string | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of (raw ?? '').split(/[,;\s]+/)) {
    const a = part.trim();
    if (!a.includes('@') || seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    out.push(a);
  }
  return out;
}
