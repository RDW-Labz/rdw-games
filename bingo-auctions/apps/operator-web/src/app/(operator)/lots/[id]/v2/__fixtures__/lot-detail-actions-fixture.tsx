// Lot detail v2 with the REAL v1 action components in the decision slots
// (Relist, Remove from inventory, Keep for business, Cancel lot, Delete), as
// page.tsx wires them. Used by the button-skin render test and the rendered
// evidence; the base fixtures keep their placeholder slots.
import { CancelLotButton } from '../../CancelLotButton';
import { DeleteLotButton } from '../../DeleteLotButton';
import { KeepForBusinessButton } from '../../KeepForBusinessButton';
import { RelistButton } from '../../RelistButton';
import { RemoveFromInventoryButton } from '../../RemoveFromInventoryButton';
import type { LotDetailV2Props } from '../lot-detail-types';
import { lotDetailFixtures } from './lot-detail-fixture';

const base = lotDetailFixtures.unsoldInventory;

export const lotDetailWithV1Actions: LotDetailV2Props = {
  ...base,
  lotId: 'lot-inventory-actions',
  actions: {
    relist: (
      <>
        <p style={{ color: 'var(--console-ink-secondary)', fontSize: 13, marginTop: 0 }}>
          Add this lot to an upcoming auction at the same warehouse.
        </p>
        <RelistButton
          lotId="lot-inventory-actions"
          lotCode="BIN-031200"
          auctions={[
            {
              id: 'auction-sample-1',
              title: 'Sample Tuesday returns',
              ends_at: '2026-10-20T23:00:00.000Z',
              warehouse_id: 'wh-sample',
            },
          ]}
          warehouseTimezone="America/Chicago"
        />
      </>
    ),
    remove: (
      <RemoveFromInventoryButton
        lotId="lot-inventory-actions"
        confirmCode="BRN4982227"
        secondaryCode="BIN-031200"
        noSticker={false}
      />
    ),
    keep: <KeepForBusinessButton lotId="lot-inventory-actions" lotCode="BIN-031200" />,
    cancel: <CancelLotButton lotId="lot-inventory-actions" />,
    delete: <DeleteLotButton lotId="lot-inventory-actions" lotCode="BIN-031200" />,
    removedState: null,
  },
  primaryAction: 'relist',
};
