// The list labels come from formatInTimeZone ("Oct 7, 2025, 8:00 PM CDT").
// Splitting date from time lets a narrow column break between the two instead
// of mid-phrase, and lets "Last close" drop the date when it is the same day
// as the first close (the common case), so the second line stays one line.

export type DateLabelParts = { date: string; time: string };

export function splitDateLabel(label: string): DateLabelParts {
  const m = /^(.*\d{4}),\s+(.+)$/.exec(label);
  if (!m || m[1] === undefined || m[2] === undefined) return { date: label, time: '' };
  // Keep v1's comma ("Oct 7, 2025, 8:00 PM CDT") on the date half.
  return { date: `${m[1]},`, time: m[2] };
}

/** "Last close …" text: just the time when it closes the same day as the first close. */
export function lastCloseParts(firstCloseLabel: string, lastCloseLabel: string): DateLabelParts {
  const first = splitDateLabel(firstCloseLabel);
  const last = splitDateLabel(lastCloseLabel);
  if (last.time && first.date === last.date) return { date: '', time: last.time };
  return last;
}
