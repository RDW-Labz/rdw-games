// The client_silent_exits ops email, built from the hour's silent-exit rows.
//
// The 2026-10-13 21:30Z alert said "29 app kills" and nothing else a reader
// could act on: 12 of them were the customer app, every staff kill was in the
// background, and 14 came right after a staff OTA publish (staff force-closing
// to pick it up). This email answers those questions itself, in a fixed order:
// a plain-English "What this means" for a non-developer, the headline with
// yesterday's count, the publish flag, one line per device, and the raw rows.
//
// "Memory footprint" is said only when one screen has >= 3 foreground kills —
// background kills are the OS reclaiming an app nobody was looking at.

export type KillRow = {
  created_at: string;
  app: 'bidder' | 'staff';
  platform: string;
  device_model: string | null;
  os_version: string | null;
  ota_update: string | null;
  screen: string | null;
  message: string;
};

export type OtaPublish = {
  app: 'bidder' | 'staff';
  branch: string;
  group_id: string | null;
  update_ids: string[];
  published_at: string;
};

const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function killState(message: string): 'foreground' | 'background' | 'other' {
  if (message.includes('in the foreground')) return 'foreground';
  if (message.includes('in the background')) return 'background';
  return 'other';
}

export function normalizeScreen(screen: string | null): string {
  if (!screen) return 'unknown';
  let s = screen.replace(UUID_RE, ':id');
  s = s.replace(/\/\d+(?=\/|$)/g, '/:id');
  return s;
}

function appLabel(app: 'bidder' | 'staff'): string {
  return app === 'staff' ? 'Staff app' : 'Customer app';
}

function appPlain(app: 'bidder' | 'staff'): string {
  return app === 'staff' ? 'staff app' : 'customer app';
}

function formatCtTime(d: Date, hour12: boolean): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: hour12 ? 'numeric' : '2-digit',
    minute: '2-digit',
    // h23, not hour12:false: some ICU builds print midnight as "24:05".
    ...(hour12 ? { hour12: true } : { hourCycle: 'h23' as const }),
  }).format(d);
}

function formatOs(platform: string, osVersion: string | null): string {
  if (!osVersion) return 'OS ?';
  const p = platform.toLowerCase();
  if (p === 'ios') return `iOS ${osVersion}`;
  if (p === 'android') return `Android ${osVersion}`;
  return osVersion;
}

function formatDevice(platform: string, deviceModel: string | null): string {
  if (deviceModel) return deviceModel;
  const p = platform.toLowerCase();
  if (p === 'android') return 'unknown device (android)';
  if (p === 'ios') return 'unknown device (ios)';
  return 'unknown device';
}

function findPublishForUpdate(
  otaUpdate: string | null,
  publishes: OtaPublish[],
): OtaPublish | undefined {
  if (!otaUpdate) return undefined;
  return publishes.find((p) => p.update_ids.includes(otaUpdate));
}

function isUpdateNew(
  otaUpdate: string | null,
  recentPublishes: OtaPublish[],
): boolean {
  if (!otaUpdate) return false;
  return recentPublishes.some((p) => p.update_ids.includes(otaUpdate));
}

function recentPublishes(now: Date, publishes: OtaPublish[]): OtaPublish[] {
  const windowStart = now.getTime() - 2 * 60 * 60 * 1000;
  const seen = new Map<string, OtaPublish>();
  for (const p of publishes) {
    const t = new Date(p.published_at).getTime();
    if (t > now.getTime() || t < windowStart) continue;
    const key = `${p.app}:${p.group_id ?? p.published_at}`;
    const existing = seen.get(key);
    if (!existing || t < new Date(existing.published_at).getTime()) {
      seen.set(key, p);
    }
  }
  return [...seen.values()].sort(
    (a, b) => new Date(a.published_at).getTime() - new Date(b.published_at).getTime(),
  );
}

function countSentences(text: string): number {
  return (text.match(/[.!?]+(\s|$)/g) ?? []).length;
}

function buildWhatThisMeans(input: {
  rows: KillRow[];
  worry: boolean;
  worryScreens: { app: 'bidder' | 'staff'; screen: string; count: number; topDevice: string }[];
  recent: OtaPublish[];
  now: Date;
}): string {
  const { rows, worry, worryScreens, recent } = input;
  const staff = rows.filter((r) => r.app === 'staff');
  const bidder = rows.filter((r) => r.app === 'bidder');
  const staffBg = staff.filter((r) => killState(r.message) === 'background').length;
  const staffFg = staff.filter((r) => killState(r.message) === 'foreground').length;

  if (worry && worryScreens.length > 0) {
    const top = worryScreens[0]!;
    const screen = top.screen === 'unknown' ? 'an unknown screen' : top.screen;
    const dev = top.topDevice ? `, mostly on ${top.topDevice}` : '';
    const staffPub = recent.find((p) => p.app === 'staff');
    const afterUpdate =
      staffPub
        ? ` If it started after today's staff update (${formatCtTime(new Date(staffPub.published_at), true)}), the developer may roll that update back.`
        : '';
    return (
      `The ${appPlain(top.app)} closed itself ${top.count} times in the last hour while someone was using it (${screen})${dev}. ` +
      (top.app === 'staff'
        ? `That needs a look: tell staff on that device to save often and send this email to the developer.${afterUpdate}`
        : `That needs a look: send this email to the developer.`)
    ).replace(/\s+/g, ' ').trim();
  }

  const parts: string[] = [];
  if (staff.length > 0 && bidder.length > 0) {
    parts.push(
      `The staff app closed itself ${staff.length} times in the last hour, and the customer app ${bidder.length} times.`,
    );
  } else if (staff.length > 0) {
    parts.push(`The staff app closed itself ${staff.length} times in the last hour.`);
  } else {
    parts.push(`The customer app closed itself ${bidder.length} times in the last hour.`);
  }

  const staffRecent = recent.find((p) => p.app === 'staff');
  const staffAfterPub =
    staffRecent
      ? staff.filter(
          (r) =>
            killState(r.message) === 'background' &&
            new Date(r.created_at).getTime() >= new Date(staffRecent.published_at).getTime(),
        ).length
      : 0;

  if (staff.length > 0 && staffFg === 0 && staffBg === staff.length) {
    if (staffRecent && staffAfterPub >= Math.floor(staff.length * 0.5)) {
      parts.push(
        `All of the staff ones happened while the app wasn't on screen, and most came right after the ${formatCtTime(new Date(staffRecent.published_at), true)} staff update, when staff close the app to pick it up — that's normal.`,
      );
    } else {
      parts.push(
        `All of the staff ones happened while the app wasn't on screen (in a pocket or another app was open).`,
      );
    }
  } else if (staffFg > 0) {
    parts.push(
      `Some staff closes happened while someone was using the app — see the breakdown below.`,
    );
  }

  parts.push('Nothing to do.');
  let text = parts.join(' ');
  while (countSentences(text) > 3 && parts.length > 1) {
    parts.pop();
    if (parts[parts.length - 1]?.startsWith('Nothing')) parts.pop();
    parts.push('Nothing to do.');
    text = parts.join(' ');
  }
  return text;
}

export function buildKillReport(input: {
  now: Date;
  rows: KillRow[];
  yesterdaySameHour: number;
  publishes: OtaPublish[];
}): {
  subject: string;
  text: string;
  foreground: number;
  background: number;
  worry: boolean;
} {
  const { now, rows, yesterdaySameHour, publishes } = input;
  let foreground = 0;
  let background = 0;
  let other = 0;

  const fgByAppScreen = new Map<string, { app: 'bidder' | 'staff'; screen: string; count: number }>();

  for (const row of rows) {
    const state = killState(row.message);
    if (state === 'foreground') foreground++;
    else if (state === 'background') background++;
    else other++;

    if (state === 'foreground') {
      const screen = normalizeScreen(row.screen);
      const key = `${row.app}:${screen}`;
      const cur = fgByAppScreen.get(key) ?? { app: row.app, screen, count: 0 };
      cur.count++;
      fgByAppScreen.set(key, cur);
    }
  }

  const worryEntries = [...fgByAppScreen.values()].filter((e) => e.count >= 3);
  const worry = worryEntries.length > 0;

  const worryScreens = worryEntries
    .sort((a, b) => b.count - a.count)
    .map((e) => {
      const deviceCounts = new Map<string, number>();
      for (const row of rows) {
        if (row.app !== e.app) continue;
        if (killState(row.message) !== 'foreground') continue;
        if (normalizeScreen(row.screen) !== e.screen) continue;
        const dev = formatDevice(row.platform, row.device_model);
        deviceCounts.set(dev, (deviceCounts.get(dev) ?? 0) + 1);
      }
      const topDevice = [...deviceCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
      return { ...e, topDevice };
    });

  const recent = recentPublishes(now, publishes);
  const total = rows.length;

  const what = buildWhatThisMeans({ rows, worry, worryScreens, recent, now });

  const headlineParts = [
    `${total} kills / 60 min (${yesterdaySameHour} yesterday same hour).`,
    `Foreground: ${foreground}. Background: ${background}.`,
  ];
  if (other > 0) headlineParts.push(`Other: ${other}.`);
  const headline = headlineParts.join(' ');

  const appCounts = (app: 'bidder' | 'staff') => {
    const subset = rows.filter((r) => r.app === app);
    const f = subset.filter((r) => killState(r.message) === 'foreground').length;
    const b = subset.filter((r) => killState(r.message) === 'background').length;
    return { n: subset.length, f, b };
  };

  const appLines: string[] = [];
  const staffC = appCounts('staff');
  const bidderC = appCounts('bidder');
  if (staffC.n > 0) {
    appLines.push(`${appLabel('staff')}: ${staffC.n} (foreground ${staffC.f}, background ${staffC.b})`);
  }
  if (bidderC.n > 0) {
    appLines.push(
      `${appLabel('bidder')}: ${bidderC.n} (foreground ${bidderC.f}, background ${bidderC.b})`,
    );
  }

  // A republish to preview + production is two groups a few seconds apart;
  // one line per app and minute is what the reader needs.
  const publishLines = [...new Set(recent.map((p) => {
    const label = p.app === 'staff' ? 'Staff' : 'Customer app';
    const t = formatCtTime(new Date(p.published_at), false);
    return `${label} update published at ${t} CT — background kills in the first 2h after a publish are expected.`;
  }))];

  type DeviceGroup = {
    app: 'bidder' | 'staff';
    device_model: string | null;
    os_version: string | null;
    platform: string;
    ota_update: string | null;
    kills: number;
    screenCounts: Map<string, number>;
  };

  const deviceGroups = new Map<string, DeviceGroup>();
  for (const row of rows) {
    const key = `${row.app}|${row.device_model ?? ''}|${row.os_version ?? ''}|${row.platform}|${row.ota_update ?? ''}`;
    let g = deviceGroups.get(key);
    if (!g) {
      g = {
        app: row.app,
        device_model: row.device_model,
        os_version: row.os_version,
        platform: row.platform,
        ota_update: row.ota_update,
        kills: 0,
        screenCounts: new Map(),
      };
      deviceGroups.set(key, g);
    }
    g.kills++;
    const scr = normalizeScreen(row.screen);
    g.screenCounts.set(scr, (g.screenCounts.get(scr) ?? 0) + 1);
  }

  const deviceLines = [...deviceGroups.values()]
    .sort((a, b) => b.kills - a.kills)
    .map((g) => {
      const topScreen = [...g.screenCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';
      const device = formatDevice(g.platform, g.device_model);
      const os = formatOs(g.platform, g.os_version);
      const updateShort = g.ota_update ? g.ota_update.slice(0, 8) : '????????';
      const pub = findPublishForUpdate(g.ota_update, publishes);
      const isNew = isUpdateNew(g.ota_update, recent);
      let updatePart = updateShort;
      if (pub && g.ota_update) {
        const gShort = (pub.group_id ?? '').slice(0, 8);
        const pubT = formatCtTime(new Date(pub.published_at), false);
        updatePart += ` (${isNew ? 'new: ' : ''}group ${gShort}, ${pub.branch}, published ${pubT})`;
      }
      return `- ${appLabel(g.app)} · ${device} · ${os} · ${updatePart} · ${g.kills} ${g.kills === 1 ? 'kill' : 'kills'} · top screen ${topScreen}`;
    });

  const worryParagraph =
    worry
      ? worryScreens
          .map(
            (w) =>
              `Foreground kills >= 3 on ${w.screen} (${appLabel(w.app)}): this is about memory footprint on that screen, not a code crash. Check whether they are all on the newest update; if so a rollback is reasonable.`,
          )
          .join('\n')
      : '';

  const sortedRows = [...rows].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  const rawLines = sortedRows.map((row) => {
    const t = formatCtTime(new Date(row.created_at), false);
    const state = killState(row.message);
    const device = formatDevice(row.platform, row.device_model);
    const os = formatOs(row.platform, row.os_version);
    const upd = row.ota_update ? row.ota_update.slice(0, 8) : '????????';
    const scr = row.screen ?? 'unknown';
    return `${t} · ${appLabel(row.app)} · ${state} · ${device} ${os} · ${upd} · ${scr}`;
  });

  const sections: string[] = ['What this means:', what, '', headline, ...appLines];
  if (publishLines.length > 0) {
    sections.push('', ...publishLines);
  }
  sections.push('', 'Per device:', ...deviceLines);
  if (worryParagraph) {
    sections.push('', worryParagraph);
  }
  sections.push('', 'Raw rows (newest first):', ...rawLines);

  const text = sections.join('\n');

  const subject = worry
    ? `App kills: ${total} in the last hour — ${worryScreens[0]!.count} foreground on ${worryScreens[0]!.screen}`
    : `App kills: ${total} in the last hour — no action needed`;

  return { subject, text, foreground, background, worry };
}
