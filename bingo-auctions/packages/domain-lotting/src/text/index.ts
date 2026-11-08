// Text utilities — strip warranty boilerplate, shorten over-long titles,
// build condition descriptions from a structured workflow form.
//
// All pure functions, no Anthropic calls. Safe to import from anywhere.

import type { ConditionWorkflowData } from '../types';

export function stripWarranty(text: string): string {
  if (!text) return text;
  const patterns: RegExp[] = [
    /\b(?:manufacturer'?s?\s+)?warranty\s+(?:is\s+)?(?:included|provided|covered|applies|valid|offered)[^.]*\./gi,
    /\b(?:covered|backed)\s+by\s+(?:a\s+)?(?:\d+[\s-]?year|\d+[\s-]?month|limited|full|lifetime)\s+(?:manufacturer'?s?\s+)?warranty[^.]*\./gi,
    /\b\d+[\s-]?year\s+(?:limited\s+)?(?:manufacturer'?s?\s+)?warranty[^.]*\./gi,
    /\bwarranty\s*(?:information|details|terms|coverage)[^.]*\./gi,
    /\bfor\s+warranty\s+information[^.]*\./gi,
    /\bwarranty\s+does\s+not[^.]*\./gi,
    /\bno\s+warranty\s+(?:is\s+)?(?:included|provided|offered)[^.]*\./gi,
    /\bthis\s+(?:product|item)\s+(?:is|comes)\s+(?:covered|backed)\s+by[^.]*warranty[^.]*\./gi,
    /\bsee\s+manufacturer'?s?\s+warranty[^.]*\./gi,
  ];
  let cleaned = text;
  for (const p of patterns) cleaned = cleaned.replace(p, '');
  cleaned = cleaned.replace(/\s{2,}/g, ' ').replace(/\.\s*\./g, '.').trim();
  return cleaned;
}

// Greedy-word title shortener. Keeps the front of the string intact
// up to maxLength. Better at preserving "Brand Model SizeColor" prefix
// than blind substring slicing.
export function shortenTitle(title: string, maxLength = 80): string {
  if (!title || title.length <= maxLength) return title;
  const words = title.split(/\s+/);
  let result = '';
  for (const word of words) {
    const next = result ? result + ' ' + word : word;
    if (next.length > maxLength) break;
    result = next;
  }
  return result || title.substring(0, maxLength);
}

// Convert a structured condition-workflow form into a single sentence
// suitable for the auction listing's condition narrative.
export function buildConditionDescription(data: ConditionWorkflowData | null | undefined): string {
  if (!data) return '';
  const parts: string[] = [];
  parts.push(`Condition: ${data.condition ?? 'Not assessed'}`);
  if (data.damages && data.damages.length > 0) {
    parts.push(`Cosmetic issues: ${data.damages.join(', ').toLowerCase()}`);
  }
  if (data.missing && data.missing.length > 0 && data.missing[0] !== 'None missing') {
    parts.push(`Missing: ${data.missing.join(', ')}`);
  }
  if (data.functionality === 'works') parts.push('Tested and functional');
  else if (data.functionality === 'partial') parts.push('Partially functional — see notes');
  else if (data.functionality === 'broken') parts.push('Does not power on / not functional');
  else if (data.functionality === 'untested') parts.push('Untested — sold as-is');
  if (data.assembly === 'assembled') parts.push('Fully assembled');
  else if (data.assembly === 'partial') parts.push('Partially assembled');
  else if (data.assembly === 'unassembled') parts.push('Unassembled, in original packaging');
  else if (data.assembly === 'incomplete') parts.push('Incomplete assembly — may need parts');
  return parts.join('. ') + '.';
}
