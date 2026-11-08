/**
 * Make `npm test` self-sufficient.
 *
 * Every harness here talks to http://127.0.0.1:8787 by default — the local library
 * server. When that server is not running, the tests do not fail honestly: they
 * navigate to a dead port, find an empty document, and report "no canvas" / "0 cards"
 * for every title. That looks exactly like a code regression and wastes a debugging
 * session (it happened: an 18/18-green suite read as 0/18 after a reboot).
 *
 * So: probe first, and start the server ourselves when nobody is listening. The child
 * is ours and is stopped when the harness exits; a server that was already there is
 * left alone (it is somebody's play session, not ours to kill).
 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function reachable(base, timeoutMs = 1200) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(base + '/catalog/games.json', { signal: ctl.signal });
    if (!r.ok) return false;
    const body = await r.json();
    return Array.isArray(body.games) && body.games.length > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * @param {string} base  URL the harness intends to use.
 * @returns {Promise<{base: string, spawned: boolean, stop: () => void}>}
 */
export async function ensureServer(base) {
  if (await reachable(base)) return { base, spawned: false, stop() { } };

  const url = new URL(base);
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error(`no server at ${base} and it is not a local address this harness may start`);
  }

  const child = spawn('python3', [join(ROOT, 'server', 'server.py'), '--port', String(url.port || 8787)], {
    cwd: ROOT, stdio: 'ignore', detached: false,
  });
  child.on('error', () => { });
  const stop = () => { try { child.kill('SIGTERM'); } catch { } };
  process.on('exit', stop);
  process.on('SIGINT', () => { stop(); process.exit(130); });

  for (let i = 0; i < 60; i++) {
    if (await reachable(base, 800)) return { base, spawned: true, stop };
    if (child.exitCode !== null) break;
    await sleep(150);
  }
  stop();
  throw new Error(`server/server.py would not answer on ${base} — refusing to report a blank page as a test result`);
}
