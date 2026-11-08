import type { StageId } from '@/components/console-v2/stage-hue';

export type FloorStageId = StageId;

export type FloorStageHue = FloorStageId;

export type FloorStagePrimaryAction = {
  label: string;
  href: string;
};

export type FloorStage = {
  id: FloorStageId;
  label: string;
  purpose: string;
  hue: FloorStageHue;
  href: string;
  /** Actionable-today count, or null = link only (no reliable count). */
  count: number | null;
  /** What the count means, shown next to it ("at the counter", "closing within 2 h"). */
  countLabel: string | null;
  primaryAction: FloorStagePrimaryAction | null;
};

/** Workflow order for tie-breaking (least urgent last in rank list). */
export const FLOOR_WORKFLOW_ORDER: readonly FloorStageId[] = [
  'intake',
  'lotting',
  'auction',
  'paid',
  'pickup',
];

const WORKFLOW_RANK = new Map(FLOOR_WORKFLOW_ORDER.map((id, index) => [id, index]));

function hasWaitingWork(count: number | null): boolean {
  return count != null && count > 0;
}

function workflowRank(id: FloorStageId): number {
  return WORKFLOW_RANK.get(id) ?? 0;
}

/**
 * Most urgent first: waiting work beats idle; pickup at the counter beats everything
 * when count &gt; 0; ties keep Intake → Lotting → Auction → Paid → Pickup.
 */
export function rankStagesByUrgency(stages: FloorStage[]): FloorStage[] {
  return [...stages].sort((a, b) => {
    if (a.id === 'pickup' && hasWaitingWork(a.count)) return -1;
    if (b.id === 'pickup' && hasWaitingWork(b.count)) return 1;

    const aWork = hasWaitingWork(a.count);
    const bWork = hasWaitingWork(b.count);
    if (aWork !== bWork) return aWork ? -1 : 1;

    return workflowRank(a.id) - workflowRank(b.id);
  });
}

/** Counts are shown with thousands separators (2,921 not 2921). */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}
