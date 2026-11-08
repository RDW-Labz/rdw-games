'use client';

// Manager UI for warehouse PIN workers (#2 phase 3). Add workers, set/reset
// their PINs, and activate/deactivate them. Reads come pre-fetched from the
// server page (list_workers_admin); mutations go through the server actions.

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Field, buttonStyle, inputStyle, secondaryButtonStyle } from '@/components/Form';
import { DataTable, type Column } from '@/components/console';
import {
  createWorkerAction,
  setWorkerPinAction,
  setWorkerActiveAction,
  setWorkerWarehouseAction,
} from './actions';

type WorkerRow = {
  id: string;
  display_name: string;
  role: 'admin' | 'manager' | 'picker' | 'lead';
  is_active: boolean;
  locked_until: string | null;
  created_at: string;
  /** NULL = works at every location. Added 0293, made settable in 0346. */
  warehouse_id: string | null;
  warehouse_name: string | null;
};

const PIN_RE = /^[0-9]{4,8}$/;

export function WorkersManager({
  workers,
  warehouses,
}: {
  workers: WorkerRow[];
  warehouses: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [role, setRole] = useState<WorkerRow['role']>('picker');
  const [error, setError] = useState<string | null>(null);

  function run(fn: () => Promise<void>) {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (e) {
        setError((e as Error).message);
      }
    });
  }

  function add() {
    if (!name.trim()) {
      setError('Enter a name.');
      return;
    }
    if (!PIN_RE.test(pin)) {
      setError('PIN must be 4–8 digits.');
      return;
    }
    run(async () => {
      await createWorkerAction({ displayName: name, pin, role });
      setName('');
      setPin('');
      setRole('picker');
      setShowAdd(false);
    });
  }

  function resetPin(w: WorkerRow) {
    const p = window.prompt(`New 4–8 digit PIN for ${w.display_name}:`) ?? '';
    if (!p) return;
    if (!PIN_RE.test(p)) {
      alert('PIN must be 4–8 digits.');
      return;
    }
    run(() => setWorkerPinAction({ workerId: w.id, pin: p }));
  }

  function toggleActive(w: WorkerRow) {
    if (
      w.is_active &&
      !window.confirm(`Deactivate ${w.display_name}? They won't be able to clock in.`)
    ) {
      return;
    }
    run(() => setWorkerActiveAction({ workerId: w.id, active: !w.is_active }));
  }

  const columns: Column<WorkerRow>[] = [
    {
      key: 'name',
      header: 'Worker',
      cell: (w) => (
        <div>
          <div style={{ fontWeight: 500, opacity: w.is_active ? 1 : 0.5 }}>{w.display_name}</div>
          {w.locked_until && new Date(w.locked_until) > new Date() && (
            <div style={{ fontSize: 12, color: 'var(--danger)' }}>Locked — too many PIN tries</div>
          )}
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      width: 130,
      cell: (w) => <span style={{ textTransform: 'capitalize' }}>{w.role}</span>,
    },
    // Only shown when there is more than one location — a single-warehouse
    // operator would get a picker with one real option and a meaningless
    // "All locations" alternative.
    ...(warehouses.length > 1
      ? [
          {
            key: 'location',
            header: 'Location',
            width: 190,
            cell: (w: WorkerRow) => (
              <select
                value={w.warehouse_id ?? ''}
                disabled={pending}
                onChange={(e) =>
                  run(() =>
                    setWorkerWarehouseAction({
                      workerId: w.id,
                      // '' is the "All locations" option — send NULL, not the
                      // empty string, or the RPC would look for a warehouse
                      // with a blank id.
                      warehouseId: e.target.value === '' ? null : e.target.value,
                    }),
                  )
                }
                style={{ ...inputStyle, padding: '0.3rem 0.4rem', fontSize: 13, width: '100%' }}
              >
                <option value="">All locations</option>
                {warehouses.map((wh) => (
                  <option key={wh.id} value={wh.id}>
                    {wh.name}
                  </option>
                ))}
              </select>
            ),
          } as Column<WorkerRow>,
        ]
      : []),
    {
      key: 'status',
      header: 'Status',
      width: 110,
      cell: (w) => (
        <span style={{ fontSize: 13, color: w.is_active ? 'var(--fg)' : 'var(--fg-muted)' }}>
          {w.is_active ? 'Active' : 'Inactive'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: 240,
      cell: (w) => (
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          {w.is_active && (
            <button onClick={() => resetPin(w)} disabled={pending} style={secondaryButtonStyle}>
              Reset PIN
            </button>
          )}
          <button
            onClick={() => toggleActive(w)}
            disabled={pending}
            style={{ ...secondaryButtonStyle, color: w.is_active ? 'var(--danger)' : 'var(--accent)' }}
          >
            {w.is_active ? 'Deactivate' : 'Reactivate'}
          </button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <p style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: 0, maxWidth: 640 }}>
        Workers clock in on the shared warehouse phones with a name + PIN — no personal email needed.
        Their PIN identifies who lotted each item (Worker Productivity) and gates actions by role. PINs
        are hashed; you can&apos;t see them later, but you can reset one here anytime.
      </p>

      {error && <div style={{ color: 'var(--danger)', marginBottom: 12 }}>{error}</div>}

      <div style={{ marginBottom: '1.5rem' }}>
        {showAdd ? (
          <div
            style={{
              padding: '1rem',
              background: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              display: 'grid',
              gap: '0.75rem',
              maxWidth: 460,
            }}
          >
            <h3 style={{ marginTop: 0 }}>Add worker</h3>
            <Field label="Name">
              <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
            </Field>
            <Field label="Role">
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as WorkerRow['role'])}
                style={inputStyle}
              >
                <option value="picker">Picker</option>
                <option value="lead">Lead / Key holder</option>
                <option value="manager">Manager</option>
                <option value="admin">Admin</option>
              </select>
            </Field>
            <Field
              label="PIN (4–8 digits)"
              hint="The worker types this to clock in. It's hashed — reset it here if they forget."
            >
              <input
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
                inputMode="numeric"
                placeholder="••••"
                style={{ ...inputStyle, fontFamily: 'ui-monospace, Menlo, monospace', letterSpacing: 4 }}
              />
            </Field>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={add} disabled={pending} style={buttonStyle}>
                {pending ? 'Working…' : 'Add worker'}
              </button>
              <button
                onClick={() => {
                  setShowAdd(false);
                  setError(null);
                }}
                style={secondaryButtonStyle}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button onClick={() => setShowAdd(true)} style={buttonStyle}>
            Add worker
          </button>
        )}
      </div>

      <DataTable
        columns={columns}
        rows={workers}
        rowKey={(w) => w.id}
        empty="No workers yet. Add one so staff can clock in with a PIN."
      />
    </div>
  );
}
