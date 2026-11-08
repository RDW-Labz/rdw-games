'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { buttonStyle } from '@/components/Form';
import { exportReportCsv, type ReportCsvFormat } from './actions';

const MONTH_NAMES = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

export function ExportCsvButton({
  operatorId,
  year,
  month,
}: {
  operatorId: string;
  year: number;
  month: number;
}) {
  const [pending, startTransition] = useTransition();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingFormat, setPendingFormat] = useState<ReportCsvFormat | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close the menu when clicking outside or hitting Escape.
  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  function handleExport(format: ReportCsvFormat) {
    setMenuOpen(false);
    setPendingFormat(format);
    startTransition(async () => {
      try {
        const csvText = await exportReportCsv(operatorId, year, month, format);
        const blob = new Blob([csvText], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const monthName = MONTH_NAMES[month - 1] ?? String(month).padStart(2, '0');
        const suffix = format === 'lot' ? 'lots' : 'invoices';
        a.download = `bingo-${monthName}-${year}-${suffix}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      } finally {
        setPendingFormat(null);
      }
    });
  }

  const label = pending
    ? pendingFormat === 'lot'
      ? 'Generating lots…'
      : 'Generating…'
    : 'Export CSV ▾';

  return (
    <div
      ref={wrapperRef}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', position: 'relative' }}
    >
      <button
        type="button"
        onClick={() => setMenuOpen((o) => !o)}
        disabled={pending}
        style={buttonStyle}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        {label}
      </button>

      <span
        title='Invoice-level CSV has one row per checkout; Lot-level CSV matches QuickBooks Sales Receipt line items so each item lines up to a QB line.'
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          color: 'var(--fg-muted)',
          fontSize: 11,
          cursor: 'help',
          userSelect: 'none',
        }}
        aria-label="What's the difference?"
      >
        ?
      </span>

      {menuOpen && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            minWidth: 280,
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
            zIndex: 20,
            padding: 4,
          }}
        >
          <MenuItem
            onSelect={() => handleExport('invoice')}
            title="Invoice-level"
            subtitle="1 row per invoice"
          />
          <MenuItem
            onSelect={() => handleExport('lot')}
            title="Lot-level"
            subtitle="1 row per item, QuickBooks-ready"
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  onSelect,
  title,
  subtitle,
}: {
  onSelect: () => void;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      role="menuitem"
      type="button"
      onClick={onSelect}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '0.55rem 0.75rem',
        background: 'transparent',
        color: 'var(--fg)',
        border: 'none',
        borderRadius: 4,
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: 14,
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
      }}
    >
      <div style={{ fontWeight: 500 }}>{title}</div>
      <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{subtitle}</div>
    </button>
  );
}
