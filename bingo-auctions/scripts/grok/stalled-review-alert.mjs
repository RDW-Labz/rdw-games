#!/usr/bin/env node
// #723: a re-review request that gets no RED TEAM verdict should not stall
// silently. For each open PR, find the newest re-review request that names the
// current head and the newest RED TEAM verdict for that same head. If the
// request is older than the stall window and no newer verdict exists, post ONE
// read-only reminder per head.
//
// #828: an exact-head FAIL/BLOCK verdict means the PR is waiting on a push,
// not on a current-head review; a recheck request after such a verdict is
// described as "no new verdict since the recheck request" instead of falsely
// claiming no verdict names the head.
//
// This script never labels, approves, merges, closes or counts as a verdict.
// Its only write is one `gh pr comment` per (PR, head).
//
// Usage: node scripts/grok/stalled-review-alert.mjs [--dry-run]
//          [--stall-minutes 60] [--now 2026-11-05T06:50:00Z] [--only 795,766]
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const REPO = 'RDW-Labz/bingo-auctions';
export const RED_TEAM_APP = 1144995;
export const GROK_APP = 1210556;
// GitHub's own Actions integration posts workflow comments with this app id.
export const ACTIONS_APP = 15368;
export const STALL_MS = 60 * 60 * 1000;

// #809 (MEDIUM 5): only the orchestrator token and the alert workflow may ask
// for a re-review or post a stall marker. App comments are trusted by app id;
// plain comments are trusted by login. Anyone else's text is data, not control.
export const TRUSTED_LOGINS = new Set(['btabor11', 'github-actions[bot]']);

const REQUEST_RE = new RegExp(
  [
    String.raw`re-?review\s+requested`,
    String.raw`request(?:ing|ed)?\s+(?:for\s+)?(?:a\s+)?(?:RED\s+TEAM\s+)?(?:re-?)?(?:review|check)`,
    String.raw`ask(?:ing|ed)?\s+(?:for\s+)?(?:a\s+)?(?:re-?)?(?:review|check)`,
    String.raw`(?:re-?)?(?:review|check)\s+(?:is|was|has\s+been|have\s+been)\s+requested`,
    String.raw`please\s+(?:re-?review|review|re-?check)`,
    String.raw`RED\s+TEAM[^\n.]{0,40}re-?(?:review|check)`,
    String.raw`(?:ask|asked|asking)\s+RED\s+TEAM\s+to\s+re-?review`,
  ].join('|'),
  'gi',
);

// A request that asks for a review of the *next* head is not a pending ask on
// the current head: the PR is waiting on a push (#828 / Braden's #711 report).
const NEW_HEAD_RE =
  /\b(?:the\s+)?new\s+head\b|\b(?:next|new)\s+(?:push|commit)\b|\bafter\s+(?:the\s+)?(?:next\s+)?push\b|\bonce\s+(?:you\s+)?push\b/i;

// #829 (MEDIUM 1): "re-review the new head" means a future push only when the
// request also instructs one. "Fixed at X (pushed) — please re-review the new
// head" describes the head that is already at the PR tip.
const AWAITING_PUSH_RE =
  /\b(?:fix|address|resolve|push|rebase|amend|commit)\b[^.\n]{0,80}\b(?:ask\s+)?(?:RED\s+TEAM\s+)?(?:to\s+)?re-?(?:review|check)\b|\bonce\s+(?:you\s+)?push\b|\bafter\s+(?:the\s+)?(?:next\s+)?push\b|\b(?:will|going\s+to|then)\s+push\b/i;

// #832: mask HTML comments on one line, reporting whether a comment opened and
// did not close on that line. Every replacement keeps line length so offsets
// from the masked view stay usable against the authored body.
// #834 (MEDIUM 6): `visible` is the same line with inline code blanked. A
// literal `<!--` inside inline code is example text, not live HTML, so an
// opener is located on `visible` while the authored line is masked.
// #836 (MEDIUM 3): once an opener is live, backticks inside the comment are
// ordinary text — a code span cannot hide its `-->` — so the close is located
// on the authored line. After the close, openers are again found on `visible`,
// so a code literal cannot open false HTML state.
function maskInlineHtmlComments(line, visible = line) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const start = visible.indexOf('<!--', i);
    if (start < 0) {
      out += line.slice(i);
      break;
    }
    out += line.slice(i, start);
    const end = line.indexOf('-->', start + 4);
    if (end < 0) return { text: out + ' '.repeat(line.length - start), open: true };
    out += ' '.repeat(end + 3 - start);
    i = end + 3;
  }
  return { text: out, open: false };
}

const HEADING_RE = /^ {0,3}#{1,6}(?:\s|$)/;
const THEMATIC_BREAK_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;

// #838 (MEDIUM 1): inline code and HTML comments are parsed left to right, and
// whichever starts first wins. A backtick run opens a code span (HTML inside it
// is literal), while `<!--` outside code opens a comment (backticks inside it
// are literal). Code spans are copied verbatim so prose callers can still read
// them; unmatched runs stay literal, as CommonMark specifies. Every replacement
// keeps non-newline characters in place so offsets stay usable against the
// authored body.
function maskInlineConstructs(text) {
  // A code span never crosses a Markdown block (blank line, heading, list item,
  // fence or quote), so pairing is limited to the opener's block range. HTML
  // comments still span lines and blocks.
  const ranges = inlineCodeBlockRanges(text);
  const blockEndAfter = (position) => {
    let lo = 0;
    let hi = ranges.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ranges[mid][1] <= position) lo = mid + 1;
      else hi = mid;
    }
    return lo < ranges.length ? ranges[lo][1] : text.length;
  };
  const runs = [];
  for (let i = 0; i < text.length; ) {
    if (text[i] !== '`') {
      i++;
      continue;
    }
    let length = 0;
    while (text[i + length] === '`') length++;
    runs.push({ start: i, length });
    i += length;
  }
  const byLength = new Map();
  runs.forEach((run, index) => {
    const list = byLength.get(run.length) ?? [];
    list.push(index);
    byLength.set(run.length, list);
  });
  const closingRun = (afterIndex, length, limit) => {
    const list = byLength.get(length);
    if (!list) return null;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] <= afterIndex) lo = mid + 1;
      else hi = mid;
    }
    return lo < list.length && runs[list[lo]].start < limit ? runs[list[lo]] : null;
  };
  const runIndexAt = new Map(runs.map((run, index) => [run.start, index]));
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '`') {
      let length = 0;
      while (text[i + length] === '`') length++;
      const close = closingRun(runIndexAt.get(i), length, blockEndAfter(i));
      if (!close) {
        out += text.slice(i, i + length);
        i += length;
        continue;
      }
      const end = close.start + close.length;
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (text.startsWith('<!--', i)) {
      const close = text.indexOf('-->', i + 4);
      const stop = close < 0 ? text.length : close + 3;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

// #829 (MEDIUM 4) / #832: blank out indented code examples, fenced blocks
// (honouring the opening fence length), blockquote history and its lazy
// continuation lines. The line pass also tracks real HTML comments so a fence
// inside one is inert; #838's inline scanner then resolves code/`<!--`
// precedence left to right and cleans up any comment the line pass could not
// locate safely.
export function maskHistory(body) {
  const raw = String(body ?? '');
  const lines = raw.split('\n');
  // #834 (MEDIUM 6): inline code is example text. Use its masked view only to
  // locate HTML comment delimiters; the authored line is what gets blanked.
  const codeVisible = maskInlineCode(raw).split('\n');
  let fence = null;
  let quote = false;
  let html = false;
  const out = lines.map((line, lineIndex) => {
    const blank = () => ' '.repeat(line.length);
    if (html) {
      const end = line.indexOf('-->');
      if (end < 0) return blank();
      html = false;
      // #836 (MEDIUM 3): the remainder after the close is scanned on the
      // code-masked view so a literal `<!--` inside inline code cannot open a
      // false HTML state and hide later genuine verdicts.
      const visible = (codeVisible[lineIndex] ?? line).slice(end + 3);
      const masked = maskInlineHtmlComments(line.slice(end + 3), visible);
      if (masked.open) html = true;
      return ' '.repeat(end + 3) + masked.text;
    }
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const closes =
        fenceMatch &&
        fenceMatch[1][0] === fence.ch &&
        fenceMatch[1].length >= fence.len &&
        /^\s*$/.test(fenceMatch[2]);
      if (closes) fence = null;
      quote = false;
      return blank();
    }
    if (fenceMatch) {
      fence = { ch: fenceMatch[1][0], len: fenceMatch[1].length };
      quote = false;
      return blank();
    }
    if (/^\s*$/.test(line)) {
      quote = false;
      return blank();
    }
    if (/^(?: {4,}|\t)/.test(line)) return blank();
    if (quote && (HEADING_RE.test(line) || THEMATIC_BREAK_RE.test(line))) quote = false;
    if (/^\s*>/.test(line)) {
      quote = true;
      return blank();
    }
    // A non-blank line after a blockquote line is a lazy quote continuation.
    if (quote) return blank();
    const masked = maskInlineHtmlComments(line, codeVisible[lineIndex] ?? line);
    if (masked.open) html = true;
    return masked.text;
  });
  return maskInlineConstructs(out.join('\n')).replace(/"[^"\n]*"/g, (m) => ' '.repeat(m.length));
}

// #832: mask inline code spans with their real delimiter length and across
// lines. A run of N backticks opens the span and the next run of exactly N
// closes it; a shorter/longer run inside the span is content. Runs are indexed
// once and paired per length, so a pathological body cannot make this
// superlinear.
function inlineCodeSpans(text) {
  const runs = [];
  for (let i = 0; i < text.length; ) {
    if (text[i] !== '`') {
      i++;
      continue;
    }
    let length = 0;
    while (text[i + length] === '`') length++;
    runs.push({ start: i, length });
    i += length;
  }
  const byLength = new Map();
  runs.forEach((run, index) => {
    const list = byLength.get(run.length) ?? [];
    list.push(index);
    byLength.set(run.length, list);
  });
  const spans = [];
  let index = 0;
  while (index < runs.length) {
    const run = runs[index];
    const list = byLength.get(run.length);
    // Find the next run of the same length; every run in between is content.
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] <= index) lo = mid + 1;
      else hi = mid;
    }
    if (lo >= list.length) {
      index++;
      continue;
    }
    const close = runs[list[lo]];
    spans.push({ start: run.start, end: close.start + close.length });
    index = list[lo] + 1;
  }
  return spans;
}

// #834 (MEDIUM 4): a code span never crosses a Markdown block. Blank lines,
// headings, list items (ordered and unordered), fences and quotes each start a
// new block, so an unmatched tick in one block cannot pair with a tick in a
// later one and hide real text. Every range is a half-open [start, end) slice of
// the authored string; offsets are therefore preserved by construction.
// #836 (MEDIUM 8): thematic breaks and setext underlines are block boundaries,
// so unmatched ticks cannot pair across them and hide a genuine verdict.
const BLOCK_LINE_RE =
  /^[ \t]*(?:#{1,6}(?:[ \t]|$)|[-*+][ \t]|\d{1,9}[.)][ \t]|`{3,}|~{3,}|>|([-*_])(?:[ \t]*\1){2,}[ \t]*$|[=-]+[ \t]*$)/;
const LIST_MARKER_RE = /^[ \t]*(?:[-*+][ \t]|\d{1,9}[.)][ \t])/;

function inlineCodeBlockRanges(text) {
  const ranges = [];
  let rangeStart = 0;
  let pos = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = pos;
    const lineEnd = pos + line.length;
    const last = i === lines.length - 1;
    if (/^[ \t\r]*$/.test(line)) {
      if (lineStart > rangeStart) ranges.push([rangeStart, lineStart]);
      rangeStart = last ? lineEnd : lineEnd + 1;
    } else if (LIST_MARKER_RE.test(line)) {
      // #836 (MEDIUM 2): a list marker opens a block whose indented continuation
      // stays in the same range, so a valid multiline code span inside one list
      // item is masked. A following marker or blank line starts a new range.
      if (lineStart > rangeStart) ranges.push([rangeStart, lineStart]);
      rangeStart = lineStart;
    } else if (BLOCK_LINE_RE.test(line)) {
      if (lineStart > rangeStart) ranges.push([rangeStart, lineStart]);
      if (lineEnd > lineStart) ranges.push([lineStart, lineEnd]);
      rangeStart = last ? lineEnd : lineEnd + 1;
    }
    pos = last ? lineEnd : lineEnd + 1;
  }
  if (rangeStart < text.length) ranges.push([rangeStart, text.length]);
  return ranges;
}

export function maskInlineCode(text) {
  const spans = [];
  for (const [start, end] of inlineCodeBlockRanges(text)) {
    for (const span of inlineCodeSpans(text.slice(start, end))) {
      spans.push({ start: start + span.start, end: start + span.end });
    }
  }
  if (spans.length === 0) return text;
  spans.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    const start = Math.max(span.start, cursor);
    if (start > cursor) out += text.slice(cursor, start);
    const end = Math.max(span.end, start);
    out += text.slice(start, end).replace(/[^\n]/g, ' ');
    cursor = end;
  }
  out += text.slice(cursor);
  return out;
}

// Request prose is never code: inline code spans and quoted history are masked
// too, so code-formatted negation or an example cannot create a request.
export function maskInertText(body) {
  return maskInlineCode(maskHistory(body));
}

// #832: a SHA inside a link is a source reference, not the head a request asks
// us to review. Blank URLs while preserving offsets before binding a request.
function maskUrls(text) {
  return text.replace(/https?:\/\/[^\s)>\]]+/gi, (m) => ' '.repeat(m.length));
}

// #828 (RED TEAM #827 MEDIUM 2): the verdict's authoritative scope is its
// top-level checked-commit field. Quoted/fenced history cannot scope it, and
// two different authoritative fields are ambiguous, so they fail closed.
// #834 (MEDIUM 7): the field label must be outside inline code, while the SHA
// itself may be code-formatted. Locating the label on the code-masked view and
// reading the SHA from the authored view rejects a multiline variable-delimiter
// code example without rejecting a genuine `Commit checked: \`<sha>\`` field.
export function checkedHeads(body) {
  const history = maskHistory(body);
  const labels = maskInlineCode(history);
  const labelRe = /^[\t ]*(?:[-*+][\t ]+)?(?:\*\*)?commit[\t ]+checked\b/gim;
  const heads = [];
  for (const match of labels.matchAll(labelRe)) {
    const at = match.index + match[0].length;
    const rest = history.slice(at, at + 80).split('\n')[0];
    // #836 (MEDIUM 1): the SHA must be the field's own value. The suffix search
    // is anchored after optional formatting characters, so prose ("unavailable"),
    // a URL, or an overlong token after an unavailable field cannot supply a
    // scope, while plain and code-formatted fields still parse.
    const sha = rest.match(/^[\s*_`:]*?([0-9a-f]{7,40})(?![0-9a-z])/i);
    if (!sha) continue;
    const head = sha[1].toLowerCase();
    if (!heads.includes(head)) heads.push(head);
  }
  return heads;
}

export function checkedHead(body) {
  const heads = checkedHeads(body);
  return heads.length === 1 ? heads[0] : null;
}

// The verdict token must be authored at the top level, not quoted history.
export function verdictKind(body) {
  const text = maskInertText(body);
  const match = text.match(
    /^[\t ]*(?:\[RED TEAM\]\s*)?(?:\*\*)?VERDICT\s*:?\s*(?:\*\*)?\s*(PASS|FAIL|BLOCK|FREEZE|NO-GO|GO)\b/im,
  );
  return match ? match[1].toUpperCase() : null;
}

export function isTrustedAuthor(comment) {
  const app = Number(comment?.app ?? 0);
  if (app === GROK_APP) return true;
  const login = String(comment?.user ?? '').toLowerCase();
  // #828 (RED TEAM #827 MEDIUM 1): real Actions comments carry app 15368, not
  // app 0, so the workflow's own markers must stay trusted.
  if (app === ACTIONS_APP) return login === 'github-actions[bot]';
  if (app !== 0) return false;
  return TRUSTED_LOGINS.has(login);
}

export function marker(head) {
  return `<!-- stalled-review-alert:${String(head).toLowerCase()} -->`;
}

// Hex tokens of 7-40 characters that are not part of a longer word.
export function shaTokens(body) {
  const out = new Set();
  if (!body) return out;
  const re = /(?<![0-9a-z])[0-9a-f]{7,40}(?![0-9a-z])/gi;
  for (const m of String(body).matchAll(re)) out.add(m[0].toLowerCase());
  return out;
}

// True when `body` names `head`, allowing any 7-40 character prefix in either
// direction (a request usually carries the 8-character short SHA; a verdict
// carries the full SHA).
export function mentionsHead(body, head) {
  const h = String(head || '').toLowerCase();
  if (h.length < 7) return false;
  for (const token of shaTokens(body)) {
    const shorter = token.length <= h.length ? token : h;
    if (shorter.length >= 7 && (h.startsWith(token) || token.startsWith(h))) return true;
  }
  return false;
}

// #829 (MEDIUM 2/3/5): a request binds to its own sentence. The negation and
// completion windows start after the nearest sentence or comma boundary, so an
// unrelated "No findings remain, requesting …" is still a request, while "No
// re-check is needed" is not.
const CLAUSE_BOUNDARIES = ['. ', '.\n', '! ', '!\n', '? ', '?\n', '; ', ';\n', ', ', ',\n', '\n'];

function clauseStart(text, index) {
  let start = 0;
  for (const boundary of CLAUSE_BOUNDARIES) {
    const at = text.lastIndexOf(boundary, index);
    if (at >= 0) start = Math.max(start, at + boundary.length);
  }
  const blank = text.lastIndexOf('\n\n', index);
  if (blank >= 0) start = Math.max(start, blank + 2);
  return start;
}

function clauseEnd(text, index) {
  const after = text.slice(index);
  const endMatch = after.match(/[.!?;](?:\s|$)|\n/);
  return endMatch ? index + endMatch.index + 1 : text.length;
}

// #832: a single newline inside prose is a soft wrap, not a sentence boundary,
// so "Pushed `<sha>`\nplease re-review" binds the head exactly like the
// one-line form. Paragraph breaks and block starts still end the sentence.
const SENTENCE_PUNCT_RE = /[.!?;](?:[ \t]+|\n|$)/g;
const PARAGRAPH_BREAK_RE = /\n[ \t]*\n/g;
// #834 (MEDIUM 5): ordered-list markers are block starts too, so "1) pushed A"
// and "2) review B" cannot combine into one request for A.
const BLOCK_START_RE = /(?:^|\n)[ \t]*(?:[-*+][ \t]+|\d{1,9}[.)][ \t]+|#{1,6}[ \t]+|>[ \t]?)/g;

function sentenceStart(text, index) {
  let start = 0;
  const before = text.slice(0, index);
  for (const re of [SENTENCE_PUNCT_RE, PARAGRAPH_BREAK_RE, BLOCK_START_RE]) {
    re.lastIndex = 0;
    for (const match of before.matchAll(re)) start = Math.max(start, match.index + match[0].length);
  }
  return start;
}

function sentenceEnd(text, index) {
  const after = text.slice(index);
  let end = text.length;
  for (const re of [
    /[.!?;](?:[ \t]+|\n|$)/,
    /\n[ \t]*\n/,
    /\n[ \t]*(?:[-*+][ \t]+|\d{1,9}[.)][ \t]+|#{1,6}[ \t]+|>[ \t]?)/,
  ]) {
    const match = after.match(re);
    if (match) end = Math.min(end, index + match.index + 1);
  }
  return end;
}

// #838 (MEDIUM 8): a "fix X; push; then re-review" instruction is one dependency
// even when a semicolon or a soft wrap splits it. Walk back over those weaker
// boundaries (but not over a full stop, blank line or block start) so the push
// is still visible to the target resolver.
const STRONG_SENTENCE_END_RE = /[.!?](?:[ \t]+|\n|$)/g;

function instructionStart(text, index) {
  let start = 0;
  const before = text.slice(0, index);
  for (const re of [STRONG_SENTENCE_END_RE, PARAGRAPH_BREAK_RE, BLOCK_START_RE]) {
    re.lastIndex = 0;
    for (const match of before.matchAll(re)) start = Math.max(start, match.index + match[0].length);
  }
  return start;
}

// #834 (MEDIUM 2): negation binds to the request's own event. A reason or
// continuation clause after the request ("... because no review was requested
// on it", "... so no re-check is needed") explains it and must not cancel it.
const EVENT_BREAK_RE =
  /\b(?:because|since|though|although|whereas|while|given|considering|so|therefore|thus|hence)\b/i;

function requestEventClause(clause, localIndex) {
  const after = clause.slice(localIndex);
  const match = after.match(EVENT_BREAK_RE);
  return match ? clause.slice(0, localIndex + match.index) : clause;
}

// #836 (MEDIUM 6): a historical negation in an earlier event ("No review was
// requested on OTHER so please review CURRENT") must not cancel the current
// affirmative request. Truncate the negation window at the last event connector
// before the request, so the prefix belongs to its own event.
const EVENT_PREFIX_BREAK_RE =
  /\b(?:because|since|though|although|whereas|while|given|considering|so|therefore|thus|hence|and)\b/gi;

function negationEventPrefix(pre) {
  let start = 0;
  for (const match of pre.matchAll(EVENT_PREFIX_BREAK_RE))
    start = Math.max(start, match.index + match[0].length);
  return pre.slice(start);
}

// #838 (MEDIUM 3 / MEDIUM 5 / MEDIUM 7): tell an imperative request ("please
// re-review X", "requesting a re-check") apart from a passive/status statement
// ("the re-review requested on X was completed"). Completion and historical
// negation only describe the review; they must never cancel a fresh imperative.
function isImperativeRequest(text, index) {
  const before = text.slice(sentenceStart(text, index), index);
  if (/\bplease\s*$/i.test(before)) return true;
  const phrase = text.slice(index, index + 80);
  if (/^please\b/i.test(phrase)) return true;
  if (/^(?:request(?:ing)?|ask(?:ing)?)\b/i.test(phrase)) return true;
  const clauseBefore = text.slice(clauseStart(text, index), index);
  if (
    /^\s*$/.test(clauseBefore) &&
    /^(?:re-?(?:review|check)|review|check|verify|look\s+at)\b/i.test(phrase) &&
    !/^(?:re-?(?:review|check)|review|check)\b[^.!?\n]{0,20}\brequested\b/i.test(phrase)
  )
    return true;
  return false;
}

// #838 (MEDIUM 6): "Do not comment and request a re-review" is a coordinated
// prohibition, so the request verb is prohibited too. A comma before "and"
// does not make the second verb independent.
const COORDINATED_PROHIBITION_RE =
  /\b(?:(?:do|does|did)\s+not|don'?t|doesn'?t|didn'?t)\b[\s\S]*\b(?:and|or)\b\s*,?\s*(?!please\b)(?:request|ask|re-?(?:review|check))\b/i;

// #838 (MEDIUM 7): a negation that names a past review on a different head is
// history, not a prohibition of the imperative that follows it.
function historicalNegation(pre, imperative) {
  if (!imperative) return false;
  return (
    shaTokens(pre).size > 0 &&
    /\b(?:was|were|has\s+been|had\s+been|not\s+requested|no\s+(?:RED\s+TEAM\s+)?re-?(?:review|check))\b/i.test(
      pre,
    )
  );
}

export function requestIsNegated(body, index) {
  const text = maskHistory(body);
  const start = clauseStart(text, index);
  const end = clauseEnd(text, index);
  const localIndex = Math.max(0, index - start);
  const clause = requestEventClause(text.slice(start, end), localIndex);
  const pre = negationEventPrefix(clause.slice(0, localIndex));
  const post = clause.slice(localIndex);
  const imperative = isImperativeRequest(text, index);
  // A bare "No"/"Never" in the immediately preceding comma segment governs the
  // following clause: "No, please re-review" is not a request.
  const segments = text.slice(0, index).split(/(?:[.!?;]\s|\n|,\s)/);
  const previous = String(segments[segments.length - 2] ?? '').trim();
  if (/^(?:no|never|not\s+now)$/i.test(previous)) return true;
  // #838 (MEDIUM 6): coordinated prohibited verbs are not requests, even when a
  // comma or the word "and" separates them.
  const sentence = text.slice(sentenceStart(text, index), Math.min(end, index + 80));
  if (COORDINATED_PROHIBITION_RE.test(sentence)) return true;
  // #838 (MEDIUM 7): do not let an older negated review on another head cancel
  // a fresh affirmative imperative.
  const history = historicalNegation(pre, imperative);
  if (
    !history &&
    /\b(?:no|not|never|nothing|nobody|none|don't|doesn't|didn't|isn't|aren't|won't|cannot|can't)\b/i.test(
      pre,
    )
  )
    return true;
  if (!history && /\bno\s+one\b/i.test(pre)) return true;
  if (!history && /\bno\s+(?:need|request)\b/i.test(pre)) return true;
  // #832: passive "was not requested" / "no review request exists" discussion.
  if (!history && /\b(?:not|never)\s+(?:been\s+)?requested\b/i.test(clause)) return true;
  if (!history && /\bno\s+(?:RED\s+TEAM\s+)?re-?(?:review|check)\b/i.test(clause)) return true;
  if (/\b(?:not|never)\s+(?:needed|required|necessary)\b/i.test(post)) return true;
  if (/\b(?:is|are)\s+not\s+(?:needed|required|necessary)\b/i.test(post)) return true;
  return false;
}

// #829 (MEDIUM 3) / #832: "The re-review requested yesterday was completed" is
// explanatory history, not a fresh ask. The completion must attach to the
// review itself; completion of the prerequisite fixes/checks must never hide a
// live request. Negation is handled by requestIsNegated.
const REVIEW_NOUN_RE = /\b(?:RED\s+TEAM\s+)?re-?(?:review|check)\b/i;
const COMPLETION_WORDS = String.raw`completed|done|finished|answered|addressed|superseded|closed|resolved|posted`;
const REVIEW_SUBJECT =
  String.raw`(?:RED\s+TEAM\s+)?re-?(?:review|check)(?:\s+request(?:ed)?)?(?:\s+(?:yesterday|today|earlier|last\s+\w+))?(?:\s+(?:on|of|for)\s+(?:` +
  '`[^`\\n]*`' +
  String.raw`|[0-9a-f]{7,40}|this\s+head|the\s+head|the\s+PR))?`;
const REVIEW_COMPLETED_RE = new RegExp(
  String.raw`\b${REVIEW_SUBJECT}\s+(?:(?:was|were|is|are)\s+(?:already\s+)?|(?:has|have|had)\s+(?:already\s+)?been\s+|been\s+(?:already\s+)?)(?:${COMPLETION_WORDS})\b`,
  'i',
);
const COMPLETED_REVIEW_RE = new RegExp(
  String.raw`\b(?:${COMPLETION_WORDS})\s+${REVIEW_SUBJECT}`,
  'i',
);
// #834 (MEDIUM 3): a request followed directly by its status ("... requested on
// `X` — completed") is the same completed event, not a new ask.
// #836 (MEDIUM 4): a status statement about a request ("... requested on `X`
// is still pending") describes the existing event; it is not a fresh ask.
// #838 (MEDIUM 3): the status word must be predicated of the review (a linking
// verb), so "please re-review pending changes" stays a live imperative.
const REVIEW_STATUS_WORDS = String.raw`pending|in\s+progress|ongoing|outstanding|awaiting|queued|scheduled`;
// #841 MEDIUM 6: a status may be separated from its subject by a comma, colon
// or dash, or carry an ordinary modifier ("currently pending", "still
// awaiting"). Only a modifier run makes a bare subject+status a status, so
// "please re-review pending changes" stays a live imperative (#838 MEDIUM 3).
const REVIEW_STATUS_MODIFIER_WORDS = String.raw`currently|still|now|already|presently|actively|being|also|again`;
const REVIEW_STATUS_RE = new RegExp(
  String.raw`\b${REVIEW_SUBJECT}\s+(?:(?:is|are|was|were|remains?|stays?)|(?:has|have|had)\s+(?:been\s+)?)\s*(?:(?:${REVIEW_STATUS_MODIFIER_WORDS})\s+){0,2}(?:${REVIEW_STATUS_WORDS})\b` +
    String.raw`|\b${REVIEW_SUBJECT}\s*[:,\u2014-]\s*(?:(?:${REVIEW_STATUS_MODIFIER_WORDS})\s+){0,2}(?:${REVIEW_STATUS_WORDS})\b` +
    String.raw`|\b${REVIEW_SUBJECT}\s+(?:${REVIEW_STATUS_MODIFIER_WORDS})\s+(?:${REVIEW_STATUS_WORDS})\b`,
  'i',
);
// #838 (MEDIUM 5): "requested and completed" is one completed review event even
// though the completion is coordinated after the request verb.
const REVIEW_STATUS_COMPLETION_RE = new RegExp(
  String.raw`\b${REVIEW_SUBJECT}[^.!?\n]{0,15}\b(?:${COMPLETION_WORDS})\b`,
  'i',
);
const REVIEW_CONJOINED_COMPLETION_RE = new RegExp(
  String.raw`\b${REVIEW_SUBJECT}[^.!?\n]{0,50}\b(?:and|then)\s+(?:was\s+|were\s+|is\s+|are\s+|has\s+been\s+|have\s+been\s+|had\s+been\s+|been\s+)?(?:${COMPLETION_WORDS})\b`,
  'i',
);
// Completion of a prerequisite (fixes, checks, findings) is not completion of
// the review, so it must leave the request live.
const PREREQUISITE_COMPLETED_RE = new RegExp(
  String.raw`\b(?:fix(?:es)?|findings?|checks?|tests?|comments?|issues?|changes?|work|review\s+notes?)\b[^.!?\n]{0,40}\b(?:was|were|is|are|has|had|have|been)\b\s+(?:already\s+)?(?:${COMPLETION_WORDS})\b`,
  'i',
);

function reviewWasCompleted(clause) {
  return (
    REVIEW_COMPLETED_RE.test(clause) ||
    COMPLETED_REVIEW_RE.test(clause) ||
    REVIEW_STATUS_RE.test(clause) ||
    REVIEW_STATUS_COMPLETION_RE.test(clause) ||
    REVIEW_CONJOINED_COMPLETION_RE.test(clause)
  );
}

// #834 (MEDIUM 3): completion binds to the request's own event. The sentence is
// soft-wrap aware (so a wrapped "completed" still attaches), but a separate
// clause introduced by a connector names a different event and cannot hide the
// live imperative.
// #836 (MEDIUM 4): "and" may join a completed review to a live current
// imperative, so the imperative itself is excluded before completion is read.
// #838 (MEDIUM 5): "and" between a request and its own completion stays one
// event; the imperative guard keeps an older completion from suppressing a new
// request.
const EVENT_SEGMENT_BREAK_RE =
  /[,;]|\b(?:so|therefore|thus|hence|but|however|yet|because|since|though|although|whereas)\b/gi;

function completionEventClause(text, index) {
  const start = sentenceStart(text, index);
  const end = sentenceEnd(text, index);
  let segmentStart = start;
  let segmentEnd = end;
  for (const match of text.slice(start, end).matchAll(EVENT_SEGMENT_BREAK_RE)) {
    const at = start + match.index;
    if (at + match[0].length <= index) segmentStart = Math.max(segmentStart, at + match[0].length);
    else if (at >= index) {
      segmentEnd = Math.min(segmentEnd, at);
      break;
    }
  }
  return text.slice(segmentStart, segmentEnd);
}

// #841 MEDIUM 7: "the old review was completed and a re-review is requested"
// is a completed historical event followed by a live ask, not one descriptive
// event, so the conjunction cannot suppress the new request.
const COMPLETED_THEN_REQUESTED_RE =
  /\b(?:completed|done|finished|answered|addressed|superseded|closed|resolved)\b[^.!?\n]{0,60}\b(?:and|;|so|then|therefore|thus|hence)\s+(?:please\s+)?(?:request|ask|re-?(?:review|check)|(?:a\s+)?(?:re-?review|re-?check)\s+(?:is|was|has\s+been|have\s+been)\s+requested)\b/i;

export function requestIsDescriptive(body, index) {
  const text = maskHistory(body);
  // #838 (MEDIUM 5): an imperative asks for a new review, so status/completion
  // wording elsewhere in the sentence describes a different event.
  if (isImperativeRequest(text, index)) return false;
  const clause = completionEventClause(text, index);
  if (!REVIEW_NOUN_RE.test(clause)) return false;
  // #841 MEDIUM 7: a completed historical review joined to a fresh request by a
  // conjunction leaves the request live.
  if (COMPLETED_THEN_REQUESTED_RE.test(clause)) return false;
  // #841 MEDIUM 6: a status attached to the request with punctuation ("...
  // requested on `X`, currently pending") is the same event even though the
  // event clause splits at the comma.
  const sentence = text.slice(sentenceStart(text, index), sentenceEnd(text, index));
  const attached = new RegExp(
    String.raw`\b${REVIEW_SUBJECT}\s*[:,\u2014-]\s*(?:(?:${REVIEW_STATUS_MODIFIER_WORDS})\s+){0,2}(?:${REVIEW_STATUS_WORDS})\b`,
    'i',
  );
  if (attached.test(sentence)) return true;
  if (!PREREQUISITE_COMPLETED_RE.test(clause) && reviewWasCompleted(clause)) return true;
  // Historical timing on a passive or active request is explanatory. The subject
  // order can be "requested a re-review", "re-review requested" or "re-review
  // was requested" (#841 MEDIUM 4, 7).
  return (
    /\b(?:requested|requesting|asked|asking)\s+(?:for\s+)?(?:a\s+)?(?:RED\s+TEAM\s+)?re-?(?:review|check)\b[^.!?\n]{0,80}\b(?:yesterday|last\s+\w+|earlier)\b/i.test(
      clause,
    ) ||
    /\b(?:re-?)?(?:review|check)\s+(?:is|was|has\s+been|have\s+been)\s+requested\b[^.!?\n]{0,80}\b(?:yesterday|last\s+\w+|earlier)\b/i.test(
      clause,
    )
  );
}

export function isRequestComment(comment) {
  if (!isTrustedAuthor(comment)) return false;
  const body = String(comment?.body ?? '');
  // Our own stall reminders mention "RED TEAM re-review"; they are not requests.
  if (body.includes('<!-- stalled-review-alert:')) return false;
  const masked = maskInertText(body);
  for (const match of masked.matchAll(REQUEST_RE)) {
    if (!requestIsNegated(body, match.index) && !requestIsDescriptive(body, match.index))
      return true;
  }
  return false;
}

// #832: a future-push instruction ("fix X, push, then request the new head")
// means the named head is the source, not the head to review. This must be
// checked before a bare head mention, otherwise the request binds to the head
// the relay asked us to fix.
// #836 (MEDIUM 7): a "fix, push, then re-review" instruction is a future push
// even without the words "new head"; semicolon-joined instructions count too.
// #838 (MEDIUM 4): an ordinary follow-on request ("review current and then
// request approval") is not a push dependency, so the coordinated verb must be
// a review/check request and a push/fix must precede it.
const FUTURE_PUSH_RE =
  /\b(?:fix|address|resolve|update|rebase|amend|commit)\b[^.]{0,80}\bpush\b[^.]{0,60}\b(?:then|and|,|;)\s*(?:please\s+)?(?:re-?(?:review|check)\b|(?:request|ask)\b[^.]{0,40}\b(?:re-?)?(?:review|check)\b)|\bpush\b[^.]{0,40}\b(?:then|and|,|;)\s*(?:please\s+)?(?:re-?(?:review|check)\b|(?:request|ask)\b[^.]{0,40}\b(?:re-?)?(?:review|check)\b)|\b(?:then|next|after\s+that|once|after\s+you)\s+(?:you\s+)?push\b|\b(?:will|going\s+to|plan\s+to|need\s+to|must)\s+(?:push|fix|address|update)\b|\bawaiting\s+(?:a\s+)?(?:new\s+)?(?:push|head)\b/i;

const PUSHED_HEAD_RE = /\b(?:pushed|push\s+(?:is\s+)?complete|fixed|updated|rebuilt|committed)\b/i;

// #829 (MEDIUM 1/5) / #832: resolve a request to the head it actually names.
// The request's own sentence must name the head (inline code is fine), and a
// future-push instruction or an incidental current SHA after an other-head
// request must not bind it. Otherwise a "new head" request is same-head only
// when a push already happened and the preceding sentence names the head.
// Fenced/quoted/indented heads and link URLs are invisible, so inert history or
// a source link cannot bind a request to the current head.
// #834 (MEDIUM 8): a head named only as an aside ("the current head X is
// unrelated", "for reference", "previous head") is not the request's target.
// Splitting on the clause punctuation keeps a genuine "review X, the current
// head Y is unrelated" from binding Y while leaving "review X and Y" alone.
const INCIDENTAL_HEAD_RE =
  /\b(?:unrelated|aside|incidental|for\s+reference|reference\s+only|only\s+(?:a\s+)?reference|not\s+(?:the|this|a)\s+(?:current\s+)?head|not\s+the\s+head|previous\s+head|old\s+head|historical(?:ly)?)\b/i;

// #836 (MEDIUM 5): "review the current head against the previous head" and
// "review X for unrelated regressions" name a genuine target even though the
// same segment also carries an incidental word. A head that directly follows a
// review verb is the target; a head only mentioned as a reference is not.
const DIRECT_TARGET_VERB_RE =
  /\b(?:re-?review|review|re-?check|check|verify|look\s+at|inspect|examine)\b/i;
const DIRECT_TARGET_WINDOW = 40;

// #838 (MEDIUM 2): "review OTHER (not CURRENT)" and "review OTHER, the current
// head CURRENT is unrelated" mention the current head only as a reference. The
// marker makes that particular mention (and its proximity) ineligible as the
// request target.
const REFERENCE_BEFORE_RE =
  /(?:\bnot|\bother\s+than|\bexcept|\bunlike|\bvs\.?|\bversus|\bbesides|\bapart\s+from|\brather\s+than|\binstead\s+of|\bagainst|\bcompared\s+(?:to|with))\s+(?:(?:the|this|that)\s+)?(?:current\s+head\s+)?[*_`]*$/i;
const REFERENCE_AFTER_RE =
  /^\s*[*_`]*\s*(?:\)|,|;|\.)?\s*(?:(?:is|are|was|were|remains?|stays?)\s+(?:unrelated|unchanged|untouched|irrelevant|separate|not\s+the\s+target)|(?:is\s+)?(?:for|as)\s+(?:a\s+)?reference|\(?for\s+reference)/i;

function headMentionIsReference(segment, index, head) {
  const h = String(head || '').toLowerCase();
  let length = 0;
  while (segment[index + length] && /[0-9a-f]/i.test(segment[index + length])) length++;
  const token = segment.slice(index, index + length).toLowerCase();
  const shorter = token.length <= h.length ? token : h;
  if (shorter.length < 7 || !(h.startsWith(token) || token.startsWith(h))) return false;
  const before = segment.slice(0, index);
  const after = segment.slice(index + length);
  return REFERENCE_BEFORE_RE.test(before) || REFERENCE_AFTER_RE.test(after);
}

function headMentionIsDirectTarget(segment, head) {
  const h = String(head || '').toLowerCase();
  for (const match of segment.matchAll(/(?<![0-9a-z])[0-9a-f]{7,40}(?![0-9a-z])/gi)) {
    const token = match[0].toLowerCase();
    const shorter = token.length <= h.length ? token : h;
    if (shorter.length < 7 || !(h.startsWith(token) || token.startsWith(h))) continue;
    if (headMentionIsReference(segment, match.index, h)) continue;
    const before = segment.slice(Math.max(0, match.index - DIRECT_TARGET_WINDOW), match.index);
    if (DIRECT_TARGET_VERB_RE.test(before)) return true;
  }
  return false;
}

function headMentionIsIncidental(clause, head) {
  const segments = clause.split(/[,;]|\b(?:and|but)\b/i);
  const mentions = segments.filter((segment) => mentionsHead(segment, head));
  if (mentions.length === 0) return true;
  if (mentions.some((segment) => headMentionIsDirectTarget(segment, head))) return false;
  return mentions.every((segment) => {
    if (INCIDENTAL_HEAD_RE.test(segment)) return true;
    const h = String(head || '').toLowerCase();
    const matches = [...segment.matchAll(/(?<![0-9a-z])[0-9a-f]{7,40}(?![0-9a-z])/gi)].filter(
      (match) => {
        const token = match[0].toLowerCase();
        const shorter = token.length <= h.length ? token : h;
        return shorter.length >= 7 && (h.startsWith(token) || token.startsWith(h));
      },
    );
    return (
      matches.length > 0 &&
      matches.every((match) => headMentionIsReference(segment, match.index, head))
    );
  });
}

export function requestTargetsHead(body, index, head) {
  const h = String(head || '').toLowerCase();
  if (h.length < 7) return false;
  const text = maskUrls(maskHistory(body));
  const start = sentenceStart(text, index);
  const end = sentenceEnd(text, index);
  const clause = text.slice(start, end);
  const blank = text.lastIndexOf('\n\n', start);
  const paragraphStart = blank >= 0 ? blank + 2 : 0;
  const nextBlank = text.indexOf('\n\n', end);
  const paragraphEnd = nextBlank >= 0 ? nextBlank : text.length;
  const paragraph = text.slice(paragraphStart, paragraphEnd);
  const instruction = text.slice(instructionStart(text, index), end);
  const future = NEW_HEAD_RE.test(clause);
  if (FUTURE_PUSH_RE.test(instruction)) return false;
  if (future && mentionsHead(clause, h)) {
    // #834 (MEDIUM 1): an imperative that names the actual head binds even
    // without a "pushed" word; only an incidental/aside mention is ignored.
    return !headMentionIsIncidental(clause, h);
  }
  if (mentionsHead(clause, h) && !headMentionIsIncidental(clause, h)) return true;
  if (future) {
    const previous = text.slice(paragraphStart, start);
    if (AWAITING_PUSH_RE.test(paragraph) && !PUSHED_HEAD_RE.test(previous)) return false;
    return mentionsHead(previous, h) && PUSHED_HEAD_RE.test(previous);
  }
  // An attached directive immediately after the request can carry the head.
  const tail = text
    .slice(end, end + 200)
    .split('\n')
    .slice(0, 2)
    .join('\n');
  if (
    /^\s*(?:[-*+]\s*)?(?:\*\*)?(?:head|commit\s+checked|checked)\b/i.test(tail) &&
    mentionsHead(tail, h)
  )
    return true;
  return false;
}

// A same-head request is a genuine ask on the head we are evaluating. A request
// for the new/next head (the standard FAIL relay) means the PR is blocked on a
// push, so it must not produce a "no verdict" reminder.
export function isSameHeadRequest(comment, head = null) {
  if (!isRequestComment(comment)) return false;
  const body = String(comment?.body ?? '');
  const masked = maskInertText(body);
  for (const match of masked.matchAll(REQUEST_RE)) {
    if (requestIsNegated(body, match.index) || requestIsDescriptive(body, match.index)) continue;
    if (head === null) {
      const text = maskHistory(body);
      const clause = text.slice(sentenceStart(text, match.index), sentenceEnd(text, match.index));
      if (!NEW_HEAD_RE.test(clause)) return true;
    } else if (requestTargetsHead(body, match.index, head)) {
      return true;
    }
  }
  return false;
}

export function isVerdictComment(comment, head) {
  if (Number(comment?.app ?? 0) !== RED_TEAM_APP) return false;
  const body = String(comment?.body ?? '');
  if (!verdictKind(body)) return false;
  const checked = checkedHead(body);
  return checked !== null && mentionsHead(checked, head);
}

// #809 (MEDIUM 4): a reminder is only valid while the PR is still open on the
// same head that was listed. A push, close or merge invalidates it.
export function headStillValid(initialHead, freshPr) {
  if (!freshPr) return false;
  if (String(freshPr.state ?? '').toUpperCase() !== 'OPEN') return false;
  return String(freshPr.headRefOid ?? '').toLowerCase() === String(initialHead ?? '').toLowerCase();
}

// #828 (RED TEAM #827 MEDIUM 5): a read failure is not a missing PR. Only a
// genuine "not found" response may be treated as a successful skip.
export function prReadOutcome({ stderr = '', ok }) {
  if (ok) return 'ok';
  if (/not found|could not resolve to a pullrequest|no pull requests found/i.test(String(stderr)))
    return 'missing';
  return 'error';
}

export function evaluatePullRequest({ head, comments = [], now = Date.now(), stallMs = STALL_MS }) {
  const headLower = String(head || '').toLowerCase();
  if (headLower.length < 7) return { stalled: false, reason: 'no-head' };

  const onHead = comments.filter((c) => mentionsHead(maskHistory(c?.body), headLower));
  const requests = onHead
    .filter((c) => isRequestComment(c))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  if (requests.length === 0) return { stalled: false, reason: 'no-request-for-head' };

  // #828: if every request asks for the *new* head, the PR is waiting on a
  // push, not on a current-head review. No reminder.
  const sameHeadRequests = requests.filter((c) => isSameHeadRequest(c, headLower));
  if (sameHeadRequests.length === 0) return { stalled: false, reason: 'awaiting-push' };

  const latest = sameHeadRequests[0];
  const requestAt = Date.parse(latest.at);
  if (!Number.isFinite(requestAt)) return { stalled: false, reason: 'bad-request-time' };

  const verdicts = onHead.filter((c) => isVerdictComment(c, headLower));

  // #809 (MEDIUM 1) / #828: only a verdict at or after the latest request
  // answers it. An older exact-head verdict does not suppress a recheck, but it
  // changes the wording to "no new verdict since the recheck request".
  if (
    verdicts.some((c) => {
      const verdictAt = Date.parse(c.at);
      return Number.isFinite(verdictAt) && verdictAt >= requestAt;
    })
  ) {
    return { stalled: false, reason: 'verdict-present' };
  }

  const priorVerdict =
    verdicts
      .filter((c) => Number.isFinite(Date.parse(c.at)))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null;

  const ageMs = now - requestAt;
  if (ageMs <= stallMs) {
    return { stalled: false, reason: 'too-recent', ageMs, requestAt: latest.at };
  }

  // #809 (MEDIUM 5): a marker only suppresses when it came from the trusted
  // alert workflow or orchestrator, never from an arbitrary commenter. The
  // marker names its own head, so scan every comment rather than the visible
  // head mentions (the marker itself is an HTML comment and is masked there).
  const alreadyNotified = comments.some(
    (c) => isTrustedAuthor(c) && String(c?.body ?? '').includes(marker(headLower)),
  );
  return {
    stalled: true,
    alreadyNotified,
    reason: alreadyNotified
      ? 'already-notified'
      : priorVerdict
        ? 'stalled-since-recheck'
        : 'stalled',
    mode: priorVerdict ? 'recheck' : 'no-verdict',
    priorVerdict: priorVerdict
      ? {
          kind: verdictKind(priorVerdict.body),
          at: priorVerdict.at,
          url: priorVerdict.url ?? null,
        }
      : null,
    ageMs,
    requestAt: latest.at,
    requestApp: Number(latest.app ?? 0),
    requestUrl: latest.url ?? null,
  };
}

export function reminderBody({
  head,
  short,
  ageMs,
  requestAt,
  requestUrl,
  mode = 'no-verdict',
  priorVerdict = null,
}) {
  const minutes = Math.floor(ageMs / 60_000);
  const label = short || head.slice(0, 8);
  const lines = [];
  if (mode === 'recheck' && priorVerdict) {
    lines.push(
      `RED TEAM has posted **no new verdict for ${minutes} minutes** since the recheck request on \`${label}\`.`,
    );
    lines.push('');
    lines.push(`- Recheck request: ${requestAt}${requestUrl ? ` (${requestUrl})` : ''}`);
    lines.push(
      `- The last verdict on this head was **${priorVerdict.kind}** at ${priorVerdict.at}${priorVerdict.url ? ` (${priorVerdict.url})` : ''}. No newer verdict names this head.`,
    );
  } else {
    lines.push(`RED TEAM re-review has had **no verdict for ${minutes} minutes** on \`${label}\`.`);
    lines.push('');
    lines.push(`- Re-review request: ${requestAt}${requestUrl ? ` (${requestUrl})` : ''}`);
    lines.push(
      `- No verdict from the ChatGPT Codex Connector app (${RED_TEAM_APP}) names this head.`,
    );
  }
  lines.push('');
  lines.push(
    'This is a read-only reminder, not a verdict. It does not change labels or the ship gate. If the head moved after this request, the new head needs its own re-review request.',
  );
  lines.push('');
  lines.push(marker(head));
  return lines.join('\n');
}

function gh(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
  } catch (error) {
    if (allowFailure) return '';
    throw error;
  }
}

function listOpenPrs(repo) {
  const raw = gh([
    'pr',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--limit',
    '200',
    '--json',
    'number,title,headRefOid,labels,isDraft',
  ]);
  return raw ? JSON.parse(raw) : [];
}

function listComments(repo, number) {
  const raw = gh([
    'api',
    `repos/${repo}/issues/${number}/comments?per_page=100`,
    '--paginate',
    '--jq',
    '.[] | [.created_at, (.performed_via_github_app.id // 0), (.user.login // ""), (.html_url // ""), (.body | @base64)] | @tsv',
  ]);
  if (!raw) return [];
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [at, app, user, url, body] = line.split('\t');
      return {
        at,
        app: Number(app),
        user,
        url,
        body: Buffer.from(body, 'base64').toString('utf8'),
      };
    });
}

// #828 (RED TEAM #827 MEDIUM 5): distinguish a genuine missing/closed PR from
// a transport failure. Transport failures must increment `failures` and never
// be reported as a successful sweep.
function freshPr(repo, number) {
  let raw;
  try {
    raw = execFileSync(
      'gh',
      ['pr', 'view', String(number), '--repo', repo, '--json', 'state,headRefOid,isDraft'],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    ).trim();
  } catch (error) {
    const stderr = String(error?.stderr ?? error?.message ?? '');
    if (prReadOutcome({ stderr, ok: false }) === 'missing') return null;
    throw error;
  }
  return raw ? JSON.parse(raw) : null;
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    stallMs: STALL_MS,
    now: Date.now(),
    only: null,
    repo: process.env.GITHUB_REPOSITORY || REPO,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--stall-minutes') args.stallMs = Number(argv[++i]) * 60_000;
    else if (arg.startsWith('--stall-minutes=')) args.stallMs = Number(arg.split('=')[1]) * 60_000;
    else if (arg === '--now') args.now = Date.parse(argv[++i]);
    else if (arg.startsWith('--now=')) args.now = Date.parse(arg.split('=')[1]);
    else if (arg === '--only')
      args.only = new Set(
        String(argv[++i])
          .split(',')
          .map((n) => Number(n.trim()))
          .filter(Boolean),
      );
    else if (arg.startsWith('--only='))
      args.only = new Set(
        arg
          .split('=')[1]
          .split(',')
          .map((n) => Number(n.trim()))
          .filter(Boolean),
      );
    else if (arg === '--repo') args.repo = argv[++i];
    else if (arg.startsWith('--repo=')) args.repo = arg.split('=')[1];
  }
  if (!Number.isFinite(args.stallMs) || args.stallMs < 0) args.stallMs = STALL_MS;
  if (!Number.isFinite(args.now)) args.now = Date.now();
  return args;
}

// #828 (RED TEAM #827 MEDIUM 4): the PR is re-read twice, the second time
// immediately before the write. A push, close or merge during the comment read
// therefore skips the write instead of posting a stale reminder.
export function invalidReason(current) {
  if (!current) return 'closed';
  return String(current.state ?? '').toUpperCase() !== 'OPEN' ? 'closed' : 'head-moved';
}

export function processPullRequest({
  pr,
  readComments,
  readPr,
  postComment,
  now,
  stallMs,
  dryRun,
}) {
  const comments = readComments(pr.number);
  const verdict = evaluatePullRequest({
    head: pr.headRefOid,
    comments,
    now,
    stallMs,
  });
  const row = {
    number: pr.number,
    head: String(pr.headRefOid || '').slice(0, 8),
    draft: pr.isDraft,
    ...verdict,
    posted: false,
  };
  if (!verdict.stalled || verdict.alreadyNotified) return { row };

  const current = readPr(pr.number);
  if (!headStillValid(pr.headRefOid, current)) {
    row.reason = invalidReason(current);
    row.alreadyNotified = false;
    return { row };
  }

  const fresh = evaluatePullRequest({
    head: current.headRefOid,
    comments: readComments(pr.number),
    now,
    stallMs,
  });
  if (!fresh.stalled || fresh.alreadyNotified) {
    row.reason = fresh.stalled ? 'already-notified' : fresh.reason;
    row.alreadyNotified = fresh.alreadyNotified ?? false;
    return { row };
  }

  const finalPr = readPr(pr.number);
  if (!headStillValid(current.headRefOid, finalPr)) {
    row.reason = invalidReason(finalPr);
    row.alreadyNotified = false;
    return { row };
  }

  const body = reminderBody({
    head: current.headRefOid,
    short: row.head,
    ageMs: fresh.ageMs,
    requestAt: fresh.requestAt,
    requestUrl: fresh.requestUrl,
    mode: fresh.mode,
    priorVerdict: fresh.priorVerdict,
  });
  if (!dryRun) {
    postComment(pr.number, body);
    row.posted = true;
  }
  return { row, body };
}

export function sweepPullRequests({
  prs,
  readComments,
  readPr,
  postComment,
  now,
  stallMs,
  dryRun,
  log = () => {},
}) {
  const candidates = [];
  let failures = 0;
  for (const pr of prs) {
    try {
      candidates.push(
        processPullRequest({ pr, readComments, readPr, postComment, now, stallMs, dryRun }).row,
      );
    } catch (error) {
      // One unreadable PR must not stop the sweep; surface it and fail the run.
      failures++;
      candidates.push({ number: pr.number, error: String(error?.message || error) });
      log(pr.number, error);
    }
  }
  return { failures, candidates };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { failures, candidates } = sweepPullRequests({
    prs: listOpenPrs(args.repo).filter((pr) => !args.only || args.only.has(pr.number)),
    readComments: (number) => listComments(args.repo, number),
    readPr: (number) => freshPr(args.repo, number),
    postComment: (number, body) =>
      gh(['pr', 'comment', String(number), '--repo', args.repo, '--body', body]),
    now: args.now,
    stallMs: args.stallMs,
    dryRun: args.dryRun,
    log: (number, error) =>
      console.error(`[stalled-review-alert] #${number} failed:`, error?.message || error),
  });
  console.log(JSON.stringify({ dryRun: args.dryRun, failures, candidates }, null, 2));
  if (failures > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
