// Lot page lineage: entry 0 is the direct parent (the row this lot was
// relisted from), entry 1 its parent, and so on.
export function relistsAgoLabel(idx: number): string {
  const n = idx + 1;
  return `${n} relist${n === 1 ? '' : 's'} ago`;
}
