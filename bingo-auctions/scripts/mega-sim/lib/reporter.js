// scripts/mega-sim/lib/reporter.js
//
// Aggregates results from assert + timer + cost-tracker into:
//   • report.json          — machine-readable, full detail
//   • report.md            — human-readable summary
//   • timeline.csv         — every step with start/end/duration
//   • cost-by-task.csv     — per-AI-call cost detail
//   • bottlenecks.md       — top 10 slowest calls + suggestions

'use strict';

const fs = require('fs');
const path = require('path');
const { getResults, summary } = require('./assert');
const timer = require('./timer');
const cost = require('./cost');

function fmtUsd(n) {
  if (n === 0) return '$0.000';
  if (n < 0.001) return '$' + (n * 1000).toFixed(3) + 'm';
  if (n < 1) return '$' + n.toFixed(4);
  return '$' + n.toFixed(2);
}

function fmtMs(n) {
  if (n < 1) return '<1ms';
  if (n < 1000) return Math.round(n) + 'ms';
  return (n / 1000).toFixed(2) + 's';
}

function csvEscape(s) {
  const v = String(s == null ? '' : s);
  if (v.indexOf(',') !== -1 || v.indexOf('"') !== -1 || v.indexOf('\n') !== -1) {
    return '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}

function buildReport(meta) {
  const results = getResults();
  const sum = summary();
  const timeline = timer.getTimeline();
  const events = cost.getEvents();
  const costSum = cost.summarize(events);
  const latencySum = timer.summarize(timeline);

  const failures = results.filter((r) => !r.ok);
  const bottlenecks = latencySum.slice(0, 10);

  return {
    meta,
    summary: {
      ...sum,
      totalCostUsd: costSum.total,
      totalAiCalls: costSum.calls,
      wallTimeMs: timeline.length > 0
        ? timeline[timeline.length - 1].ts - timeline[0].ts
        : 0,
    },
    failures,
    results,
    timeline,
    latency: latencySum,
    cost: costSum,
    bottlenecks,
  };
}

function writeReports(outDir, meta) {
  fs.mkdirSync(outDir, { recursive: true });
  const report = buildReport(meta);

  // ── JSON ───────────────────────────────────────────────────────────────
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

  // ── timeline.csv ───────────────────────────────────────────────────────
  const timelineCsv = ['phase,label,ms,ok,error,ts']
    .concat(
      report.timeline.map((t) =>
        [t.phase, t.label, t.ms.toFixed(2), t.ok, t.error || '', t.ts].map(csvEscape).join(','),
      ),
    )
    .join('\n');
  fs.writeFileSync(path.join(outDir, 'timeline.csv'), timelineCsv);

  // ── cost-by-task.csv ───────────────────────────────────────────────────
  const costCsv = ['ts,tag,task,model,input_tokens,output_tokens,cost_usd,latency_ms,escalation_tier']
    .concat(
      cost.getEvents().map((e) =>
        [
          e.ts,
          e.tag || '',
          e.task,
          e.model,
          e.input_tokens,
          e.output_tokens,
          (e.cost_estimate_usd || 0).toFixed(6),
          e.latency_ms,
          e.escalation_tier,
        ].map(csvEscape).join(','),
      ),
    )
    .join('\n');
  fs.writeFileSync(path.join(outDir, 'cost-by-task.csv'), costCsv);

  // ── report.md ──────────────────────────────────────────────────────────
  const md = renderMarkdown(report);
  fs.writeFileSync(path.join(outDir, 'report.md'), md);

  // ── bottlenecks.md ─────────────────────────────────────────────────────
  fs.writeFileSync(path.join(outDir, 'bottlenecks.md'), renderBottlenecks(report));

  return { report, outDir };
}

function renderMarkdown(r) {
  const lines = [];
  lines.push('# Mega-Sim ' + (r.meta.startedAt || 'unknown'));
  lines.push('');
  lines.push('**Phase:** ' + (r.meta.phase || '?') + '  ');
  lines.push('**Operator:** `' + (r.meta.operator || '?') + '`  ');
  lines.push('**Mode:** ' + (r.meta.noAi ? 'no-ai (stubbed)' : 'real AI calls') + '  ');
  lines.push('**Wall time:** ' + fmtMs(r.summary.wallTimeMs));
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  const passLine = r.summary.failed === 0
    ? '✓ All ' + r.summary.passed + ' / ' + r.summary.total + ' steps passed'
    : '✗ ' + r.summary.passed + ' / ' + r.summary.total + ' steps passed (' +
      r.summary.failed + ' failed)';
  lines.push('- ' + passLine);
  lines.push('- AI cost: ' + fmtUsd(r.summary.totalCostUsd) + ' (' + r.summary.totalAiCalls + ' calls)');
  lines.push('');

  // Failures first — what the user actually cares about.
  if (r.failures.length > 0) {
    lines.push('## ✗ Failures');
    lines.push('');
    for (const f of r.failures) {
      lines.push('### ' + f.phase + ' · ' + f.name);
      lines.push('');
      lines.push('- Error: `' + (f.error || 'unknown') + '`');
      if (f.context && f.context.assertion) {
        const a = f.context.assertion;
        const expStr = a.expected === undefined ? '(undefined)' : JSON.stringify(a.expected);
        const actStr = a.actual === undefined ? '(undefined)' : JSON.stringify(a.actual);
        lines.push('- Expected: `' + String(expStr).slice(0, 200) + '`');
        lines.push('- Actual: `' + String(actStr).slice(0, 200) + '`');
      }
      if (f.context && f.context.cause) {
        lines.push('- Cause: `' + f.context.cause + '`');
      }
      lines.push('');
    }
  }

  // Latency p95 by RPC/step
  lines.push('## Latency (p95 desc)');
  lines.push('');
  lines.push('| Step | Calls | p50 | p95 | max |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const l of r.latency.slice(0, 20)) {
    lines.push('| `' + l.label + '` | ' + l.count + ' | ' + fmtMs(l.p50) + ' | ' + fmtMs(l.p95) + ' | ' + fmtMs(l.max) + ' |');
  }
  lines.push('');

  // Cost
  if (r.summary.totalAiCalls > 0) {
    lines.push('## AI cost by task');
    lines.push('');
    lines.push('| Task | Calls | Total | Avg latency |');
    lines.push('|---|---:|---:|---:|');
    for (const k of Object.keys(r.cost.byTask)) {
      const t = r.cost.byTask[k];
      lines.push('| ' + k + ' | ' + t.calls + ' | ' + fmtUsd(t.cost) + ' | ' + fmtMs(t.latencyMs / t.calls) + ' |');
    }
    lines.push('');
    lines.push('## AI cost by model');
    lines.push('');
    lines.push('| Model | Calls | Total | Tokens (in/out) |');
    lines.push('|---|---:|---:|---|');
    for (const k of Object.keys(r.cost.byModel)) {
      const m = r.cost.byModel[k];
      lines.push('| `' + k + '` | ' + m.calls + ' | ' + fmtUsd(m.cost) + ' | ' + m.inputTokens + ' / ' + m.outputTokens + ' |');
    }
    lines.push('');
    lines.push('## AI cost by phase tag');
    lines.push('');
    lines.push('| Tag | Calls | Total |');
    lines.push('|---|---:|---:|');
    for (const k of Object.keys(r.cost.byTag)) {
      const t = r.cost.byTag[k];
      lines.push('| ' + k + ' | ' + t.calls + ' | ' + fmtUsd(t.cost) + ' |');
    }
    lines.push('');
  }

  // All steps
  lines.push('## All steps');
  lines.push('');
  let lastPhase = null;
  for (const r2 of r.results) {
    if (r2.phase !== lastPhase) {
      lines.push('');
      lines.push('### ' + r2.phase);
      lines.push('');
      lastPhase = r2.phase;
    }
    lines.push('- ' + (r2.ok ? '✓' : '✗') + ' `' + r2.name + '` ' + fmtMs(r2.ms) + (r2.ok ? '' : ' — `' + (r2.error || '').slice(0, 120) + '`'));
  }
  lines.push('');

  return lines.join('\n');
}

function renderBottlenecks(r) {
  const lines = [];
  lines.push('# Bottlenecks — Mega-Sim ' + (r.meta.startedAt || ''));
  lines.push('');
  lines.push('Top 10 slowest steps by p95 latency.');
  lines.push('');
  lines.push('| # | Step | Calls | p50 | p95 | max | Hint |');
  lines.push('|---:|---|---:|---:|---:|---:|---|');
  let i = 1;
  for (const b of r.bottlenecks) {
    let hint = '';
    if (/shelf_scan|scan-photo|photo_identify/.test(b.label) && b.p95 > 3000) {
      hint = 'AI vision call — pre-compress to 800px before upload?';
    } else if (b.p95 > 2000) {
      hint = 'Investigate — over 2s p95 is slow for non-AI work';
    } else if (b.p95 > 500 && /^supa/.test(b.label)) {
      hint = 'DB query — check for missing index';
    }
    lines.push('| ' + i + ' | `' + b.label + '` | ' + b.count + ' | ' + fmtMs(b.p50) + ' | ' + fmtMs(b.p95) + ' | ' + fmtMs(b.max) + ' | ' + hint + ' |');
    i += 1;
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = { writeReports, buildReport, fmtUsd, fmtMs };
