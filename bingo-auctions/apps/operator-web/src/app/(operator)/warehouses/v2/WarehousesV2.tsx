import Link from 'next/link';
import { ConsoleV2Page } from '@/components/console-v2/ConsoleV2Page';
import { rowMotion } from '@/components/console-v2/motion';
import type { WarehousesV2Props } from './warehouse-types';

// Warehouses list, v2 skin on the v1 structure (Braden 2026-10-13: lists keep
// the v1 layout, not cards). v1 shows, per warehouse: name (+ Inactive),
// "City, ST · floor plan uploaded / no floor plan · pickup mode", and a
// Setup → button. Here those are table columns in the same order — Name ·
// Location · Floor plan · Pickup mode · Setup — with v2's Off-site pill beside
// Inactive under the name. v1 has no images on this list, so neither does v2.

export function WarehousesV2({ rows }: WarehousesV2Props) {
  return (
    <ConsoleV2Page className="console-v2-warehouses-list">
      <header className="console-v2-motion-reveal">
        <div className="console-v2-warehouses-list-head">
          <h1 className="console-v2-display">Warehouses</h1>
          <Link href="/warehouses/new" className="console-v2-btn console-v2-btn--primary-lime console-v2-pressable">
            New warehouse
          </Link>
        </div>
      </header>

      {rows.length === 0 ? (
        <p className="console-v2-warehouses-empty console-v2-motion-reveal">
          No warehouses yet.{' '}
          <Link href="/warehouses/new" className="console-v2-code">
            Add one
          </Link>{' '}
          to start placing bins.
        </p>
      ) : (
        <div className="console-v2-list-table-wrap console-v2-motion-reveal">
          <table className="console-v2-list-table console-v2-warehouses-table">
            <caption className="console-v2-sr-only">Warehouses, newest first</caption>
            <colgroup>
              <col />
              <col className="console-v2-warehouses-col-location" />
              <col className="console-v2-warehouses-col-plan" />
              <col className="console-v2-warehouses-col-mode" />
              <col className="console-v2-warehouses-col-setup" />
            </colgroup>
            <thead>
              <tr>
                <th scope="col" data-col="title">Name</th>
                <th scope="col" data-col="location">Location</th>
                <th scope="col" data-col="plan">Floor plan</th>
                <th scope="col" data-col="mode">Pickup mode</th>
                <th scope="col" data-col="setup">
                  <span className="console-v2-sr-only">Setup</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => {
                const motion = rowMotion(idx);
                return (
                  <tr key={row.id} className={`console-v2-list-row ${motion.className}`} style={motion.style}>
                    <td data-col="title">
                      <Link href={`/warehouses/${row.id}`} className="console-v2-list-title">
                        {row.name}
                      </Link>
                      {row.inactive || row.offSite ? (
                        <div className="console-v2-list-meta">
                          {row.inactive ? <span className="console-v2-list-inactive">Inactive</span> : null}
                          {row.offSite ? <span className="console-v2-list-offsite">Off-site</span> : null}
                        </div>
                      ) : null}
                    </td>
                    <td data-col="location">
                      {row.city}, {row.state}
                    </td>
                    <td data-col="plan">{row.hasFloorPlan ? 'Floor plan uploaded' : 'No floor plan'}</td>
                    <td data-col="mode">{row.pickupModeLabel}</td>
                    <td data-col="setup" className="console-v2-warehouses-setup">
                      <Link
                        href={`/warehouses/${row.id}`}
                        className="console-v2-btn console-v2-btn--secondary console-v2-pressable"
                        aria-label={`Setup ${row.name}`}
                      >
                        Setup →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </ConsoleV2Page>
  );
}
