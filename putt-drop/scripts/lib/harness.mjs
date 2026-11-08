// Shared process hygiene for the Playwright scripts (smoke, taps, capture, perf, course-check, store assets).
// - spawnPreview(): starts the preview server in its own process group so stopping it also stops the `vite`
//   child that `npx`/`npm exec` leaves behind (a plain child.kill() only reached the npm wrapper).
// - launchBrowser(): Playwright launch that is closed on every exit path.
// - Every exit path (normal end, thrown error, unhandled rejection, Ctrl-C, SIGTERM) stops what we started.
// - reapOrphans(): stops `vite preview` servers older than 1 hour left by earlier runs; never port 5300
//   (the owner's Wi-Fi test link).
import { spawn, execFileSync } from "node:child_process";

const previews = new Set();
const browsers = new Set();
const PROTECTED_PORT = "5300";
const ORPHAN_AGE_S = 60 * 60;

function killGroup(child, signal) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

function stopPreview(child) {
  killGroup(child, "SIGTERM");
  const t = setTimeout(() => killGroup(child, "SIGKILL"), 3000);
  t.unref();
  previews.delete(child);
}

/** Same signature as child_process.spawn; the returned child's kill() stops the whole process group. */
export function spawnPreview(cmd, args, opts = {}) {
  // Bind explicitly to IPv4 loopback: `localhost` can resolve to ::1 only, and the scripts probe 127.0.0.1.
  // The owner's Wi-Fi link (port 5300, --host 0.0.0.0) is started separately and never through here.
  const finalArgs = args.includes("--host") ? args : [...args, "--host", "127.0.0.1"];
  const child = spawn(cmd, finalArgs, { ...opts, detached: true });
  previews.add(child);
  child.once("exit", () => previews.delete(child));
  const original = child.kill.bind(child);
  child.kill = (signal = "SIGTERM") => {
    stopPreview(child);
    return original(signal);
  };
  return child;
}

/** browserType.launch() that is always closed when the process ends. */
export async function launchBrowser(browserType, opts) {
  const browser = await browserType.launch(opts);
  browsers.add(browser);
  browser.once("disconnected", () => browsers.delete(browser));
  return browser;
}

async function closeAll() {
  await Promise.allSettled([...browsers].map((b) => b.close()));
  for (const child of [...previews]) stopPreview(child);
}

function killAllSync() {
  for (const child of [...previews]) killGroup(child, "SIGKILL");
}

let installed = false;
function installCleanup() {
  if (installed) return;
  installed = true;
  process.once("exit", killAllSync);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(sig, async () => {
      await closeAll();
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
  process.once("uncaughtException", async (err) => {
    console.error(err);
    await closeAll();
    process.exit(1);
  });
  process.once("unhandledRejection", async (err) => {
    console.error(err);
    await closeAll();
    process.exit(1);
  });
}

function parseEtime(etime) {
  // macOS/BSD ps etime: [[dd-]hh:]mm:ss
  const [days, rest] = etime.includes("-") ? etime.split("-") : ["0", etime];
  const parts = rest.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  return Number(days) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}

export function isPreviewServer(args) {
  return (
    /^(\S*\/)?node\s+(\S*\/)?vite(\.js)?\s+preview(\s|$)/.test(args) ||
    /^npm exec vite preview(\s|$)/.test(args)
  );
}

function ancestorPids() {
  const set = new Set([process.pid]);
  try {
    const out = execFileSync("ps", ["-ax", "-o", "pid=,ppid="], { encoding: "utf8" });
    const parent = new Map();
    for (const line of out.split("\n")) {
      const [a, b] = line.trim().split(/\s+/).map(Number);
      if (a) parent.set(a, b);
    }
    let p = process.ppid;
    while (p && !set.has(p)) {
      set.add(p);
      p = parent.get(p);
    }
  } catch {
    /* best effort */
  }
  return set;
}

/** Stop `vite preview` servers older than 1 hour, except the one on port 5300. Returns the PIDs stopped. */
export function reapOrphans({ maxAgeS = ORPHAN_AGE_S, log = true } = {}) {
  let out = "";
  try {
    out = execFileSync("ps", ["-ax", "-o", "pid=,etime=,args="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const stopped = [];
  const ancestors = ancestorPids();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const [, pidStr, etime, args] = m;
    const pid = Number(pidStr);
    if (ancestors.has(pid)) continue;
    // Only the server processes themselves: `node .../vite(.js) preview ...` or `npm exec vite preview ...`.
    // A loose "vite preview" match also hit shells whose command line merely mentioned it.
    if (!isPreviewServer(args)) continue;
    if (new RegExp(`--port[ =]${PROTECTED_PORT}\\b`).test(args)) continue;
    if (parseEtime(etime) < maxAgeS) continue;
    try {
      process.kill(pid, "SIGTERM");
      stopped.push(pid);
    } catch {
      /* not ours or already gone */
    }
  }
  if (log && stopped.length) console.log(`harness: stopped ${stopped.length} orphaned preview server(s): ${stopped.join(", ")}`);
  return stopped;
}

installCleanup();
reapOrphans();

export { parseEtime as _parseEtime };
