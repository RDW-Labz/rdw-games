// scripts/mega-sim/lib/timer.js
//
// High-res timing wrapper. Records every step and exposes the timeline
// to the reporter. Wraps an async fn so callers stay clean.
//
//   const { ms, value } = await time('intake-by-upc', async () => { ... });
//
// Steps are emitted into a module-level array; reporter consumes it.

'use strict';

const _timeline = [];
let _phase = '(unset)';

function setPhase(p) {
  _phase = p;
}

async function time(label, fn) {
  const t0 = process.hrtime.bigint();
  let value, error;
  try {
    value = await fn();
  } catch (e) {
    error = e;
  }
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1_000_000;
  _timeline.push({
    phase: _phase,
    label,
    ms,
    ok: !error,
    error: error ? error.message || String(error) : null,
    ts: Date.now(),
  });
  if (error) throw error;
  return { ms, value };
}

function getTimeline() {
  return _timeline.slice();
}

function clearTimeline() {
  _timeline.length = 0;
  _phase = '(unset)';
}

// percentiles
function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summarize(timeline) {
  const byLabel = {};
  for (const t of timeline) {
    if (!byLabel[t.label]) byLabel[t.label] = { count: 0, mss: [] };
    byLabel[t.label].count += 1;
    byLabel[t.label].mss.push(t.ms);
  }
  const summary = Object.keys(byLabel).map((label) => {
    const mss = byLabel[label].mss;
    return {
      label,
      count: byLabel[label].count,
      p50: percentile(mss, 50),
      p95: percentile(mss, 95),
      max: Math.max.apply(null, mss),
    };
  });
  summary.sort((a, b) => b.p95 - a.p95);
  return summary;
}

module.exports = { setPhase, time, getTimeline, clearTimeline, summarize, percentile };
