export type SortDirection = 'ascending' | 'descending' | 'none';

export type SortableValue = string | number | null | undefined;

function normalizeForCompare(value: SortableValue): string | number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && !Number.isNaN(value)) return value;
  const asNum = Number(value);
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(asNum)) {
    return asNum;
  }
  return String(value);
}

/**
 * Comparator for DenseTable: nulls last, numeric when both numeric, else locale string.
 * Stable tie-break via originalIndex.
 */
export function compareSortValues(
  a: SortableValue,
  b: SortableValue,
  direction: Exclude<SortDirection, 'none'>,
  originalIndexA: number,
  originalIndexB: number,
): number {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);

  if (na === null && nb === null) return originalIndexA - originalIndexB;
  if (na === null) return 1;
  if (nb === null) return -1;

  let cmp = 0;
  if (typeof na === 'number' && typeof nb === 'number') {
    cmp = na - nb;
  } else {
    cmp = String(na).localeCompare(String(nb), undefined, { numeric: true, sensitivity: 'base' });
  }

  if (cmp === 0) return originalIndexA - originalIndexB;
  return direction === 'ascending' ? cmp : -cmp;
}

export function nextSortDirection(current: SortDirection, columnId: string, activeColumn: string | null): {
  columnId: string;
  direction: SortDirection;
} {
  if (activeColumn !== columnId || current === 'none') {
    return { columnId, direction: 'ascending' };
  }
  if (current === 'ascending') {
    return { columnId, direction: 'descending' };
  }
  return { columnId, direction: 'none' };
}

export function ariaSortValue(direction: SortDirection): 'ascending' | 'descending' | 'none' | undefined {
  if (direction === 'ascending') return 'ascending';
  if (direction === 'descending') return 'descending';
  return 'none';
}
