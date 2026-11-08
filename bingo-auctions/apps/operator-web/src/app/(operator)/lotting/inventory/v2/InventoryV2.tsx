import Link from 'next/link';
import { formatCount } from '@/app/(operator)/dashboard/v2/floor-story';
import { SectionHeader } from '@/components/console-v2/SectionHeader';
import { revealStyle } from '@/components/console-v2/motion';
import { InventoryV2List } from './InventoryV2List';
import type { InventoryV2Props } from './inventory-types';

export function InventoryV2(props: InventoryV2Props) {
  const {
    bucketLabel,
    bucketTabs,
    rows,
    shownCount,
    totalCount,
    cappedAt500,
    searchQ,
    warehouseId,
    warehouseOptions,
    sourceFilter,
    sourceOptions,
    vendorFilter,
    vendorOptions,
    missing,
    buildHref,
    exportHref,
    emptyMessage,
    canEdit,
    canAssign,
    openAuctions,
  } = props;

  return (
    <div
      data-console-v2
      className="console-v2-inventory console-v2-motion-page-in"
      style={{
        fontFamily: 'var(--console-font-body)',
        color: 'var(--console-ink)',
        margin: 'calc(-2rem)',
        padding: 'var(--console-page-gutter)',
        background: 'var(--console-gradient-frame)',
        minHeight: '100%',
      }}
    >
      <header className="console-v2-motion-reveal" style={revealStyle(0)}>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--console-space-3)',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 'var(--console-space-4)',
          }}
        >
          <h1
            className="console-v2-display"
            style={{ margin: 0, fontSize: 'var(--console-text-title)', lineHeight: 'var(--console-leading-tight)' }}
          >
            Inventory
          </h1>
          <a href={exportHref} className="console-v2-btn console-v2-btn--secondary console-v2-pressable">
            Export CSV
          </a>
        </div>
      </header>

      <nav aria-label="Lifecycle buckets" className="console-v2-inventory-tabs console-v2-motion-reveal" style={revealStyle(1)}>
        {bucketTabs.map((tab) => (
          <Link
            key={tab.id}
            href={tab.href}
            className={`console-v2-inventory-tab${tab.active ? ' console-v2-inventory-tab--active' : ''}`}
            aria-current={tab.active ? 'page' : undefined}
          >
            <span>{tab.label}</span>
            <span className="console-v2-inventory-tab__count">{formatCount(tab.count)}</span>
          </Link>
        ))}
      </nav>

      <p
        className="console-v2-motion-reveal"
        style={{
          ...revealStyle(2),
          margin: 'var(--console-space-4) 0',
          fontSize: 'var(--console-text-sm)',
          color: 'var(--console-ink-secondary)',
        }}
      >
        Showing {formatCount(shownCount)} of {formatCount(totalCount)} in <strong>{bucketLabel}</strong>
        {cappedAt500 ? ' (most recent 500 loaded)' : ''}
      </p>

      {cappedAt500 ? (
        <p
          className="console-v2-inventory-cap console-v2-motion-reveal"
          style={{
            ...revealStyle(3),
            margin: '0 0 var(--console-space-4)',
            padding: 'var(--console-space-3)',
            borderRadius: 'var(--console-radius-panel)',
            border: 'var(--console-border-width) solid var(--console-warning)',
            color: 'var(--console-warning)',
            fontSize: 'var(--console-text-sm)',
          }}
        >
          Showing the most recent 500 of {formatCount(totalCount)} items. Narrow with search or filters, or use CSV export for up to 5,000 rows.
        </p>
      ) : null}

      <form
        method="GET"
        className="console-v2-inventory-filters console-v2-motion-reveal"
        style={revealStyle(4)}
        action="/lotting/inventory"
      >
        {missing ? <input type="hidden" name="missing" value={missing} /> : null}
        {props.bucket !== 'inventory' ? (
          <input type="hidden" name="bucket" value={props.bucket} />
        ) : null}
        <label className="console-v2-sr-only" htmlFor="inventory-v2-search">Search lots</label>
        <input
          id="inventory-v2-search"
          type="search"
          name="q"
          defaultValue={searchQ}
          placeholder="Lot code, title, sticker, UPC, or bin…"
          className="console-v2-field console-v2-input-fill console-v2-search-input"
        />
        {warehouseOptions.length > 0 ? (
          <select
            name="warehouse"
            defaultValue={warehouseId}
            className="console-v2-field console-v2-input-fill console-v2-filter-select"
            aria-label="Filter by warehouse"
          >
            <option value="">All warehouses</option>
            {warehouseOptions.map((w) => (
              <option key={w.value} value={w.value}>{w.label}</option>
            ))}
          </select>
        ) : null}
        {sourceOptions.length > 0 ? (
          <select
            name="source"
            defaultValue={sourceFilter}
            className="console-v2-field console-v2-input-fill console-v2-filter-select"
            aria-label="Filter by source"
          >
            <option value="">All sources</option>
            {sourceOptions.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        ) : null}
        {vendorOptions.length > 0 ? (
          <select
            name="vendor"
            defaultValue={vendorFilter}
            className="console-v2-field console-v2-input-fill console-v2-filter-select"
            aria-label="Filter by vendor"
          >
            <option value="">All vendors</option>
            {vendorOptions.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        ) : null}
        <button type="submit" className="console-v2-btn console-v2-btn--primary-lime console-v2-pressable">
          Apply
        </button>
        <Link href={buildHref({ q: null, source: null, vendor: null, missing: null, warehouse: null })} className="console-v2-btn console-v2-btn--ghost console-v2-pressable">
          Clear
        </Link>
      </form>

      <div className="console-v2-inventory-quality console-v2-motion-reveal" style={revealStyle(5)} aria-label="Quality filters">
        <span style={{ fontSize: 'var(--console-text-xs)', color: 'var(--console-ink-secondary)', textTransform: 'uppercase' }}>
          Quality
        </span>
        <Link
          href={buildHref({ missing: missing === 'photos' ? null : 'photos' })}
          className={`console-v2-chip${missing === 'photos' ? ' console-v2-chip--selected' : ''}`}
        >
          No photos
        </Link>
        <Link
          href={buildHref({ missing: missing === 'msrp' ? null : 'msrp' })}
          className={`console-v2-chip${missing === 'msrp' ? ' console-v2-chip--selected' : ''}`}
        >
          No MSRP
        </Link>
        <Link
          href={buildHref({ missing: missing === 'category' ? null : 'category' })}
          className={`console-v2-chip${missing === 'category' ? ' console-v2-chip--selected' : ''}`}
        >
          No category
        </Link>
      </div>

      <section className="console-v2-motion-reveal" style={revealStyle(6)} aria-labelledby="inventory-v2-list-heading">
        <SectionHeader title="Lots" stageHue="lotting" />
        <h2 id="inventory-v2-list-heading" className="console-v2-sr-only">
          {bucketLabel} lots
        </h2>
        <InventoryV2List
          bucketLabel={bucketLabel}
          rows={rows}
          canEdit={canEdit}
          canAssign={canAssign}
          openAuctions={openAuctions}
          emptyMessage={emptyMessage}
        />
      </section>
    </div>
  );
}
