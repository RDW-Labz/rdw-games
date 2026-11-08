import Link from 'next/link';
import { ConsoleV2Page } from '@/components/console-v2/ConsoleV2Page';
import { SetupStepper, type SetupStep } from '@/components/console-v2/SetupStepper';

export type WarehouseHubV2Props = {
  warehouseId: string;
  title: string;
  locationLine: string;
  completedCount: number;
  totalSteps: number;
  todoCount: number;
  steps: SetupStep[];
};

export function WarehouseHubV2({
  title,
  locationLine,
  completedCount,
  totalSteps,
  todoCount,
  steps,
}: WarehouseHubV2Props) {
  const summary = (
    <>
      {locationLine} ·{' '}
      <strong>
        {completedCount}/{totalSteps} steps complete
      </strong>
      {todoCount > 0 ? ` · ${todoCount} remaining` : ''}
    </>
  );

  return (
    <ConsoleV2Page className="console-v2-warehouse-hub">
      <header className="console-v2-motion-reveal console-v2-warehouse-hub-head">
        <h1 className="console-v2-display">{title}</h1>
        <Link href="/warehouses" className="console-v2-btn console-v2-btn--secondary console-v2-pressable">
          ← All warehouses
        </Link>
      </header>

      <SetupStepper steps={steps} summary={summary} stageHue="intake" />
    </ConsoleV2Page>
  );
}
