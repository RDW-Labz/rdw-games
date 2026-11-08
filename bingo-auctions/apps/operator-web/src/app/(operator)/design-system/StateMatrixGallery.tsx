'use client';

import type { ReactNode } from 'react';
import { useState } from 'react';
import {
  Button,
  Card,
  Chip,
  ConfirmDialog,
  DenseTable,
  FilterBar,
  LookupBar,
  LotCard,
  LotIdentity,
  SearchField,
  SectionHeader,
  StatusPill,
  Tabs,
  TextField,
  SelectField,
  Checkbox,
  Toast,
  CONSOLE_GALLERY_STATUSES,
  type ConsoleButtonVariant,
} from '@/components/console-v2';
import type { GalleryVisualState } from '@/components/console-v2/gallery-state';
import { panelStyle } from '@/components/console-v2/styles';

const COLS = [
  'default',
  'hover',
  'focus',
  'active',
  'selected',
  'disabled',
  'loading',
  'error',
  'success',
] as const;

type MatrixCol = (typeof COLS)[number];

const NA = '—';

const cellStyle = {
  verticalAlign: 'top' as const,
  padding: 'var(--console-space-2)',
  borderTop: 'var(--console-border-width) solid var(--console-line)',
  fontSize: 'var(--console-text-sm)',
  minWidth: '120px',
};

const headerStyle = {
  ...cellStyle,
  fontWeight: 'var(--console-weight-label)' as const,
  textTransform: 'uppercase' as const,
  letterSpacing: 'var(--console-tracking-label)',
  fontSize: 'var(--console-text-xs)',
  color: 'var(--console-ink-secondary)',
  background: 'var(--console-surface)',
};

function MatrixTable({ rows }: { rows: { label: string; cells: Record<MatrixCol, ReactNode> }[] }) {
  return (
    <div style={{ overflowX: 'auto', marginBottom: 'var(--console-space-8)' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', background: 'var(--console-surface-raised)' }}>
        <thead>
          <tr>
            <th scope="col" style={{ ...headerStyle, textAlign: 'left', minWidth: '200px' }}>Primitive</th>
            {COLS.map((c) => (
              <th key={c} scope="col" style={headerStyle}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th scope="row" style={{ ...cellStyle, textAlign: 'left', color: 'var(--console-ink)' }}>{row.label}</th>
              {COLS.map((c) => (
                <td key={c} style={cellStyle}>{row.cells[c]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SAMPLE_LOT = { lot_code: 'BIN-031005', sticker_code: 'BIN:BRN4982227' as string | null };
const SAMPLE_LOT_NO_STICKER = { lot_code: 'BIN-031006', sticker_code: null };

const TABLE_ROWS = [
  { id: '1', lot_code: 'BIN-031005', sticker_code: 'BIN:BRN4982227', display_code: null, title: 'Sample row', bid: 4200 },
];

function btnCells(variant: ConsoleButtonVariant, label = 'Action') {
  return {
    default: <Button variant={variant}>{label}</Button>,
    hover: <Button variant={variant} forceState="hover">{label}</Button>,
    focus: <Button variant={variant} forceState="focus">{label}</Button>,
    active: <Button variant={variant} forceState="active">{label}</Button>,
    selected: NA,
    disabled: <Button variant={variant} disabled>{label}</Button>,
    loading: <Button variant={variant} loading>{label}</Button>,
    error: NA,
    success: NA,
  } satisfies Record<MatrixCol, ReactNode>;
}

function MiniTable(opts: {
  loading?: boolean;
  error?: string;
  forceHover?: boolean;
  selected?: boolean;
  disabledAction?: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(opts.selected ? new Set(['1']) : new Set());
  return (
    <DenseTable
      caption="Matrix (Sample data)"
      columns={[
        { id: 'identity', header: 'Lot', render: () => null },
        { id: 'bid', header: 'Bid', align: 'right', render: () => '$42.00' },
      ]}
      rows={opts.loading || opts.error ? [] : TABLE_ROWS}
      getRowKey={(r) => r.id}
      identityForRow={(r) => r}
      loading={opts.loading}
      error={opts.error}
      selectedKeys={selected}
      onToggleRow={(key) => {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      }}
      forceRowHoverKey={opts.forceHover ? '1' : null}
      rowActionDisabledReason={opts.disabledAction ? () => 'Blocked (Sample data)' : undefined}
    />
  );
}

function TabsCell(force?: GalleryVisualState, selected = true) {
  const [tabId, setTabId] = useState('one');
  return (
    <Tabs
      activeId={selected ? tabId : 'two'}
      onChange={setTabId}
      tabForceState={force}
      tabs={[
        { id: 'one', label: 'Today', panel: <span>Panel</span> },
        { id: 'two', label: 'Wait', panel: <span>Panel</span> },
      ]}
    />
  );
}

export function StateMatrixGallery() {
  const warehouseOpts = [{ value: 'all', label: 'All' }, { value: 'wh1', label: 'North (Sample)' }];

  const rows = [
    { label: 'Button · primary', cells: btnCells('primary-lime', 'Find') },
    { label: 'Button · secondary', cells: btnCells('secondary') },
    { label: 'Button · ghost', cells: btnCells('ghost') },
    { label: 'Button · danger', cells: btnCells('danger', 'Remove') },
    {
      label: 'Chip · selectable',
      cells: {
        default: <Chip>North floor</Chip>,
        hover: <Chip forceState="hover">North floor</Chip>,
        focus: <Chip forceState="focus">North floor</Chip>,
        active: <Chip forceState="active">North floor</Chip>,
        selected: <Chip selected>North floor</Chip>,
        disabled: <Chip disabled>North floor</Chip>,
        loading: NA,
        error: NA,
        success: NA,
      },
    },
    {
      label: 'Chip · removable',
      cells: {
        default: <Chip removable onRemove={() => undefined}>Warehouse A</Chip>,
        hover: <Chip removable forceState="hover" onRemove={() => undefined}>Warehouse A</Chip>,
        focus: <Chip removable forceState="focus" onRemove={() => undefined}>Warehouse A</Chip>,
        active: <Chip removable forceState="active" onRemove={() => undefined}>Warehouse A</Chip>,
        selected: NA,
        disabled: <Chip removable disabled onRemove={() => undefined}>Warehouse A</Chip>,
        loading: NA,
        error: NA,
        success: NA,
      },
    },
    {
      label: 'Tabs',
      cells: {
        default: TabsCell(),
        hover: TabsCell('hover'),
        focus: TabsCell('focus'),
        active: TabsCell('active'),
        selected: TabsCell(undefined, true),
        disabled: <Tabs activeId="one" onChange={() => undefined} tabs={[{ id: 'one', label: 'Locked', panel: <span>—</span> }]} />,
        loading: NA,
        error: NA,
        success: NA,
      },
    },
    {
      label: 'SearchField',
      cells: {
        default: <SearchField />,
        hover: <SearchField forceState="hover" />,
        focus: <SearchField forceState="focus" />,
        active: <SearchField value="chair" />,
        selected: NA,
        disabled: <SearchField disabled disabledReason="Locked (Sample data)" />,
        loading: <SearchField value="chair" loading />,
        error: <SearchField value="???" error="Failed (Sample data)" />,
        success: <p style={{ color: 'var(--console-success)', margin: 0 }}>12 results</p>,
      },
    },
    {
      label: 'Text input',
      cells: {
        default: <TextField id="m-tx-def" label="Note" hint="Sample" />,
        hover: <TextField id="m-tx-h" label="Note" forceState="hover" />,
        focus: <TextField id="m-tx-f" label="Note" forceState="focus" />,
        active: <TextField id="m-tx-a" label="Note" defaultValue="Active" />,
        selected: NA,
        disabled: <TextField id="m-tx-d" label="Note" disabled disabledReason="Read-only" />,
        loading: <TextField id="m-tx-l" label="Note" readOnly aria-busy={true} defaultValue="Saving…" />,
        error: <TextField id="m-tx-e" label="Code" error="Required" />,
        success: <TextField id="m-tx-s" label="Code" success="Saved" defaultValue="BRN4982227" readOnly />,
      },
    },
    {
      label: 'Select',
      cells: {
        default: <SelectField id="m-sel" label="State" options={[{ value: 'live', label: 'Live' }]} />,
        hover: <SelectField id="m-sel-h" label="State" forceState="hover" options={[{ value: 'live', label: 'Live' }]} />,
        focus: <SelectField id="m-sel-f" label="State" forceState="focus" options={[{ value: 'live', label: 'Live' }]} />,
        active: <SelectField id="m-sel-a" label="State" defaultValue="live" options={[{ value: 'live', label: 'Live' }]} />,
        selected: NA,
        disabled: <SelectField id="m-sel-d" label="State" disabled options={[{ value: 'live', label: 'Live' }]} />,
        loading: <SelectField id="m-sel-l" label="State" aria-busy={true} disabled options={[{ value: 'live', label: 'Live' }]} />,
        error: <SelectField id="m-sel-e" label="State" error="Invalid" options={[{ value: '', label: '—' }]} />,
        success: <p style={{ color: 'var(--console-success)', margin: 0 }}>Applied</p>,
      },
    },
    {
      label: 'Checkbox',
      cells: {
        default: <Checkbox id="m-chk" label="Include disposed" />,
        hover: NA,
        focus: <Checkbox id="m-chk-f" label="Include disposed" forceState="focus" />,
        active: <Checkbox id="m-chk-a" label="Include disposed" defaultChecked />,
        selected: <Checkbox id="m-chk-s" label="Include disposed" defaultChecked />,
        disabled: <Checkbox id="m-chk-d" label="Include disposed" disabled />,
        loading: NA,
        error: NA,
        success: NA,
      },
    },
    {
      label: 'FilterBar',
      cells: {
        default: <FilterBar warehouseOptions={warehouseOpts} warehouseValue="all" showReset />,
        hover: <FilterBar warehouseOptions={warehouseOpts} forceState="hover" />,
        focus: <FilterBar warehouseOptions={warehouseOpts} forceFocusSelect />,
        active: <FilterBar warehouseOptions={warehouseOpts} warehouseValue="wh1" stateValue="live" showReset />,
        selected: NA,
        disabled: <FilterBar warehouseOptions={warehouseOpts} warehouseValue="wh1" disabledReason="Locked" />,
        loading: <FilterBar warehouseOptions={warehouseOpts} loading />,
        error: <FilterBar warehouseOptions={warehouseOpts} error="Scope failed" />,
        success: <FilterBar warehouseOptions={warehouseOpts} success="Filters applied" />,
      },
    },
    {
      label: 'StatusPill · all statuses',
      cells: {
        default: (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--console-space-1)' }}>
            {CONSOLE_GALLERY_STATUSES.map((s) => <StatusPill key={s} status={s} />)}
          </div>
        ),
        hover: NA,
        focus: NA,
        active: NA,
        selected: NA,
        disabled: NA,
        loading: <StatusPill status="live" loading />,
        error: <StatusPill status="live" error />,
        success: <StatusPill status="paid" />,
      },
    },
    {
      label: 'LotIdentity · sticker',
      cells: {
        default: <LotIdentity lot={SAMPLE_LOT} />,
        hover: NA,
        focus: NA,
        active: NA,
        selected: NA,
        disabled: NA,
        loading: NA,
        error: NA,
        success: NA,
      },
    },
    {
      label: 'LotIdentity · no sticker',
      cells: {
        default: <LotIdentity lot={SAMPLE_LOT_NO_STICKER} />,
        hover: NA,
        focus: NA,
        active: NA,
        selected: NA,
        disabled: NA,
        loading: NA,
        error: NA,
        success: NA,
      },
    },
    {
      label: 'LotCard',
      cells: {
        default: <LotCard lot={SAMPLE_LOT} />,
        hover: <LotCard lot={SAMPLE_LOT} forceState="hover" />,
        focus: <LotCard lot={SAMPLE_LOT} forceState="focus" />,
        active: NA,
        selected: <LotCard lot={SAMPLE_LOT} selected />,
        disabled: <LotCard lot={SAMPLE_LOT} disabledActionReason="Blocked" />,
        loading: <LotCard lot={SAMPLE_LOT} loading />,
        error: <LotCard lot={SAMPLE_LOT} error />,
        success: <p style={{ color: 'var(--console-success)', margin: 0 }}>Saved</p>,
      },
    },
    {
      label: 'DenseTable row',
      cells: {
        default: <MiniTable />,
        hover: <MiniTable forceHover />,
        focus: <p style={{ margin: 0, color: 'var(--console-ink-dim)' }}>Tab to sort</p>,
        active: NA,
        selected: <MiniTable selected />,
        disabled: <MiniTable disabledAction />,
        loading: <MiniTable loading />,
        error: <MiniTable error="Network" />,
        success: <p style={{ color: 'var(--console-success)', margin: 0 }}>Sorted</p>,
      },
    },
    {
      label: 'Card + SectionHeader (stages)',
      cells: {
        default: (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--console-space-2)' }}>
            {(['intake', 'lotting', 'auction', 'paid', 'pickup', null] as const).map((stage) => (
              <Card key={String(stage)}>
                <SectionHeader title={stage ?? 'Neutral'} stageHue={stage} subtitle="Sample data" />
              </Card>
            ))}
          </div>
        ),
        hover: NA,
        focus: NA,
        active: NA,
        selected: NA,
        disabled: NA,
        loading: NA,
        error: NA,
        success: NA,
      },
    },
    {
      label: 'ConfirmDialog',
      cells: {
        default: (
          <ConfirmDialog
            preview
            open
            title="Remove lot?"
            lot={SAMPLE_LOT}
            confirmDisabled
            confirmDisabledReason="Type sticker to enable (Sample data)"
          >
            Static open preview — sample data only.
          </ConfirmDialog>
        ),
        hover: <Button variant="secondary" forceState="hover">Cancel</Button>,
        focus: <ConfirmDialog preview open title="Focus cancel" forceFocusCancel onCancel={() => undefined}>Preview</ConfirmDialog>,
        active: <Button variant="primary-lime" forceState="active">Confirm</Button>,
        selected: NA,
        disabled: <Button variant="primary-lime" disabled>Confirm</Button>,
        loading: <ConfirmDialog preview open loading title="Saving…">Working…</ConfirmDialog>,
        error: <ConfirmDialog preview open error="Save failed" title="Error">Could not save.</ConfirmDialog>,
        success: <p style={{ color: 'var(--console-success)', margin: 0 }}>Committed</p>,
      },
    },
    {
      label: 'Toast',
      cells: {
        default: <Toast message="Default (Sample data)" onClose={() => undefined} />,
        hover: <Toast message="Action hover" actionLabel="Open" onAction={() => undefined} onClose={() => undefined} actionForceState="hover" />,
        focus: <Toast message="Focus close" onClose={() => undefined} forceFocusClose />,
        active: NA,
        selected: NA,
        disabled: NA,
        loading: <Toast message="Saving…" variant="loading" />,
        error: <Toast message="Failed" variant="error" onClose={() => undefined} />,
        success: <Toast message="Saved" variant="success" onClose={() => undefined} />,
      },
    },
    {
      label: 'Toast · info',
      cells: {
        default: <Toast message="Warehouse sync complete" variant="info" onClose={() => undefined} />,
        hover: NA,
        focus: NA,
        active: NA,
        selected: NA,
        disabled: NA,
        loading: NA,
        error: NA,
        success: NA,
      },
    },
    {
      label: 'LookupBar',
      cells: {
        default: <LookupBar />,
        hover: <LookupBar forceState="hover" />,
        focus: <LookupBar forceState="focus" value="" />,
        active: <LookupBar value="BRN4982227" resolvedLot={SAMPLE_LOT} />,
        selected: NA,
        disabled: <LookupBar disabledReason="Maintenance" value="BIN-031005" />,
        loading: <LookupBar loading value="BRN4982227" />,
        error: <LookupBar value="UNKNOWN" error="Not found" />,
        success: <LookupBar value="BRN4982227" resolvedLot={SAMPLE_LOT} />,
      },
    },
  ];

  return (
    <section aria-labelledby="matrix-title">
      <h2
        id="matrix-title"
        className="console-v2-display"
        style={{ fontSize: 'var(--console-text-section)', marginBottom: 'var(--console-space-3)' }}
      >
        Primitive state matrix
      </h2>
      <p style={{ color: 'var(--console-ink-secondary)', fontSize: 'var(--console-text-sm)', marginBottom: 'var(--console-space-4)' }}>
        Hover / focus / active columns use <code>data-state</code> hooks styled with the same rules as pseudo-classes. N/A = {NA}.
      </p>
      <div style={panelStyle}>
        <MatrixTable rows={rows} />
      </div>
    </section>
  );
}
