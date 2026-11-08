let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let duckGain: GainNode | null = null;
let playing = false;
let muted = false;
let hidden = false;
let timer: ReturnType<typeof setInterval> | null = null;
let step = 0;

const BPM = 72;
const LOOP_STEPS = 64 * 4;

const bassLine = [0, 0, 7, 7, 5, 5, 3, 3, 0, 0, 7, 7, 10, 10, 7, 7];
const leadLine = [12, 14, 17, 14, 12, 10, 7, 10, 12, 15, 17, 15, 12, 10, 7, 5];

function midiToHz(n: number): number {
  return 440 * Math.pow(2, (n - 69) / 12);
}

function ensureCtx(): AudioContext | null {
  if (ctx) return ctx;
  try {
    ctx = new AudioContext();
    master = ctx.createGain();
    duckGain = ctx.createGain();
    duckGain.gain.value = 0.22;
    master.gain.value = muted ? 0 : 0.18;
    duckGain.connect(master);
    master.connect(ctx.destination);
    return ctx;
  } catch {
    return null;
  }
}

function playTone(
  when: number,
  freq: number,
  dur: number,
  type: OscillatorType,
  gain: number
): void {
  const c = ensureCtx();
  if (!c || !duckGain || muted || hidden) return;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(gain, when + 0.02);
  g.gain.exponentialRampToValueAtTime(0.001, when + dur);
  osc.connect(g);
  g.connect(duckGain);
  osc.start(when);
  osc.stop(when + dur + 0.05);
}

function tick(): void {
  const c = ensureCtx();
  if (!c || !playing || muted || hidden) return;
  const beat = step % 16;
  const bar = Math.floor(step / 16) % bassLine.length;
  const now = c.currentTime + 0.02;
  const root = 48;
  if (step % 2 === 0) {
    playTone(now, midiToHz(root + bassLine[bar]), 0.35, "sawtooth", 0.08);
  }
  if (beat % 4 === 0) {
    playTone(now, midiToHz(root + 24), 0.08, "square", 0.04);
  }
  if (beat % 2 === 1) {
    playTone(now, midiToHz(root + leadLine[bar]), 0.25, "triangle", 0.05);
  }
  step = (step + 1) % LOOP_STEPS;
}

export function setMusicMuted(m: boolean): void {
  muted = m;
  if (master) master.gain.value = m ? 0 : 0.18;
}

export function unlockMusic(): void {
  ensureCtx();
  if (!playing) {
    playing = true;
    step = 0;
    if (timer) clearInterval(timer);
    timer = setInterval(tick, (60_000 / BPM) / 2);
  }
}

export function duckMusic(ducked: boolean): void {
  if (!duckGain) return;
  duckGain.gain.value = ducked ? 0.06 : 0.22;
}

export function pauseMusicOnHide(hiddenPage: boolean): void {
  hidden = hiddenPage;
  if (hidden && ctx?.state === "running") {
    void ctx.suspend();
  } else if (!hidden && ctx?.state === "suspended" && playing) {
    void ctx.resume();
  }
}

export function stopMusic(): void {
  playing = false;
  if (timer) clearInterval(timer);
  timer = null;
}
