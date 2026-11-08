'use client';

// Staff per-lot outcome controls on the pickup-session counter page
// (mig 0243). Each item: Collected ✓ / Missing / Later — tap to set, tap
// again to clear. Undecided rows count as collected when the session
// completes, so a clean pickup needs zero taps here.

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { setLotOutcome } from './actions';
import type { SessionItem } from '@/lib/pickup-session';
import { lotAsListedHref } from '@/lib/console-links';
import {
  MISSING_QUICK_REASONS,
  missingNoteBudget,
  missingLocationText,
  validateMissingNote,
} from './missing-confirm';
import { runOutcomeSave } from './outcome-save';

type Outcome = 'collected' | 'missing' | 'left_behind';

type MissingDraft = { lotId: string; reason: string | null; note: string };

const OUTCOME_META: Record<Outcome, { label: string; color: string }> = {
  collected: { label: 'Collected ✓', color: 'var(--accent)' },
  missing: { label: 'Missing', color: 'var(--danger)' },
  left_behind: { label: 'Later', color: 'var(--warn-yellow, #eab308)' },
};

export function SessionItems({
  token,
  items,
  customerCollected,
}: {
  token: string;
  items: SessionItem[];
  customerCollected: string[];
}) {
  const router = useRouter();
  const [outcomes, setOutcomes] = useState<Record<string, Outcome | null>>(
    Object.fromEntries(items.map((i) => [i.lotId, i.outcome])),
  );
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [draft, setDraft] = useState<MissingDraft | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const saveLock = useRef(false);
  const [, startTransition] = useTransition();
  const customer = new Set(customerCollected);

  const save = (item: SessionItem, next: Outcome | null, note: string | null) => {
    if (saving || saveLock.current) return;
    // Take the lock synchronously so a fast repeat tap cannot queue a second
    // write before the transition starts. `runOutcomeSave` releases it in
    // every branch (success, structured failure and transport rejection).
    saveLock.current = true;
    setSaving(item.lotId);
    setError(null);
    startTransition(async () => {
      try {
        await runOutcomeSave({
          next,
          previous: item.outcome,
          submit: () =>
            setLotOutcome({
              token,
              pickupId: item.pickupId,
              lotId: item.lotId,
              outcome: next,
              note,
            }),
          setOutcome: (value) => setOutcomes((prev) => ({ ...prev, [item.lotId]: value })),
          setSaving: (value) => setSaving(value ? item.lotId : null),
          setError,
          onSaved: () => {
            setDraft(null);
            setFormError(null);
            router.refresh();
          },
        });
      } finally {
        saveLock.current = false;
      }
    });
  };

  const toggle = (item: SessionItem, next: Outcome) => {
    if (saving) return;
    if (next === 'missing' && outcomes[item.lotId] !== 'missing') {
      // #849: confirm against the current bin before writing it off. A tap on
      // an already-missing lot still clears it, as before.
      setError(null);
      setFormError(null);
      setDraft({ lotId: item.lotId, reason: null, note: '' });
      return;
    }
    setDraft(null);
    setFormError(null);
    const value = outcomes[item.lotId] === next ? null : next;
    save(item, value, null);
  };

  const selectReason = (item: SessionItem, reason: string) => {
    if (saving || draft?.lotId !== item.lotId) return;
    const nextReason = draft.reason === reason ? null : reason;
    const budget = missingNoteBudget(nextReason);
    if (nextReason && draft.note.trim().length > budget) {
      setFormError(`Shorten the note to ${budget} characters to keep "${nextReason}".`);
      return;
    }
    setFormError(null);
    setDraft({ ...draft, reason: nextReason });
  };

  const changeNote = (item: SessionItem, value: string) => {
    if (saving || draft?.lotId !== item.lotId) return;
    setFormError(null);
    setDraft({ ...draft, note: value });
  };

  const confirmMissing = (item: SessionItem) => {
    if (saving || draft?.lotId !== item.lotId) return;
    const check = validateMissingNote(draft.reason, draft.note);
    if (!check.ok) {
      setFormError(check.error);
      return;
    }
    setFormError(null);
    save(item, 'missing', check.note);
  };

  return (
    <div style={{ marginBottom: '1.5rem' }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: 1.5,
          textTransform: 'uppercase',
          color: 'var(--fg-dim)',
          marginBottom: 6,
        }}
      >
        Items — ✅ = customer marked collected · unmarked rows count as collected on complete
      </div>
      {error && (
        <div style={{ color: 'var(--danger)', fontSize: 13, marginBottom: 6 }}>{error}</div>
      )}
      {items.map((item) => {
        const outcome = outcomes[item.lotId] ?? null;
        return (
          <div
            key={item.lotId}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              padding: '0.45rem 0.5rem',
              borderBottom: '1px solid var(--border)',
              fontSize: 13,
              opacity: outcome === 'missing' ? 0.7 : 1,
            }}
          >
            <span style={{ width: 20, textAlign: 'center' }}>
              {customer.has(item.lotId) ? '✅' : '⬜'}
            </span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--fg-dim)', fontSize: 12 }}>
              {item.displayCode}
            </span>
            <Link
              href={lotAsListedHref(item.invoiceId, item.lotId)}
              style={{
                flex: 1,
                minWidth: 120,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: 'inherit',
                textDecoration: 'underline',
                textDecorationColor: 'var(--border)',
              }}
              title="View as listed (read-only)"
            >
              {item.title}
            </Link>
            <span style={{ flexShrink: 0, color: 'var(--accent)', fontWeight: 700, fontSize: 12 }}>
              {item.binCode ??
                (item.aisle ? `A${item.aisle}${item.bay ? `/B${item.bay}` : ''}` : '—')}
            </span>
            <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
              {(Object.keys(OUTCOME_META) as Outcome[]).map((key) => {
                const meta = OUTCOME_META[key];
                const active = outcome === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => toggle(item, key)}
                    disabled={saving !== null}
                    style={{
                      padding: '3px 9px',
                      borderRadius: 999,
                      fontSize: 11,
                      fontWeight: 800,
                      cursor: saving !== null ? 'not-allowed' : 'pointer',
                      border: `1px solid ${active ? meta.color : 'var(--border)'}`,
                      background: active ? meta.color : 'transparent',
                      color: active ? '#10141c' : 'var(--fg-muted)',
                    }}
                  >
                    {meta.label}
                  </button>
                );
              })}
            </span>
            {draft?.lotId === item.lotId && (
              <MissingConfirmPanel
                item={item}
                reason={draft.reason}
                note={draft.note}
                busy={saving === item.lotId}
                error={formError}
                onReason={(reason) => selectReason(item, reason)}
                onNote={(value) => changeNote(item, value)}
                onConfirm={() => confirmMissing(item)}
                onCancel={() => {
                  setFormError(null);
                  setDraft(null);
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * #849 RED TEAM follow-up: the confirmation panel owns the note budget. The
 * typed note is capped by what is left after the selected reason, so the
 * client and the server can never disagree about an accepted length.
 */
export function MissingConfirmPanel({
  item,
  reason,
  note,
  busy,
  error,
  onReason,
  onNote,
  onConfirm,
  onCancel,
}: {
  item: SessionItem;
  reason: string | null;
  note: string;
  busy: boolean;
  error: string | null;
  onReason: (reason: string) => void;
  onNote: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const loc = missingLocationText(item.binCode, item.warehouseName);
  const budget = missingNoteBudget(reason);
  const validation = validateMissingNote(reason, note);
  const message = error ?? (validation.ok ? null : validation.error);

  return (
    <div
      role="group"
      aria-label="Confirm missing"
      style={{
        flexBasis: '100%',
        display: 'grid',
        gap: 6,
        marginTop: 4,
        padding: '8px 10px',
        border: '1px solid var(--danger)',
        borderRadius: 8,
        background: 'var(--surface-2, #222)',
      }}
    >
      <span style={{ fontWeight: 700, color: 'var(--danger)', fontSize: 12 }}>
        Mark {item.displayCode} missing?
      </span>
      <span style={{ fontSize: 12, color: loc.hasBin ? 'var(--fg)' : 'var(--fg-muted)' }}>
        Current bin: <strong>{loc.text}</strong>
      </span>
      <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
        Note is optional — confirm now if you are sure.
      </span>
      <div
        role="group"
        aria-label="Quick reason"
        style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}
      >
        {MISSING_QUICK_REASONS.map((quick) => {
          const active = reason === quick;
          return (
            <button
              key={quick}
              type="button"
              aria-pressed={active}
              disabled={busy}
              onClick={() => onReason(quick)}
              style={{
                padding: '2px 8px',
                borderRadius: 999,
                fontSize: 11,
                cursor: busy ? 'not-allowed' : 'pointer',
                border: `1px solid ${active ? 'var(--danger)' : 'var(--border)'}`,
                background: active ? 'var(--danger)' : 'transparent',
                color: active ? '#10141c' : 'var(--fg-muted)',
              }}
            >
              {quick}
            </button>
          );
        })}
      </div>
      <input
        aria-label="Missing note (optional)"
        placeholder="Note (optional)"
        maxLength={budget}
        value={note}
        disabled={busy}
        onChange={(e) => onNote(e.target.value)}
        style={{
          padding: '4px 8px',
          fontSize: 12,
          borderRadius: 6,
          border: '1px solid var(--border)',
          background: 'var(--bg)',
          color: 'var(--fg)',
          minWidth: 0,
        }}
      />
      <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
        {budget} characters available
        {reason ? ` with "${reason}"` : ''}.
      </span>
      {message && (
        <span role="alert" style={{ fontSize: 12, color: 'var(--danger)' }}>
          {message}
        </span>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <button
          type="button"
          disabled={busy || !validation.ok}
          onClick={onConfirm}
          style={{
            padding: '4px 10px',
            fontSize: 12,
            fontWeight: 700,
            borderRadius: 6,
            border: '1px solid transparent',
            background: 'var(--danger)',
            color: '#10141c',
            cursor: busy || !validation.ok ? 'not-allowed' : 'pointer',
            opacity: busy || !validation.ok ? 0.5 : 1,
          }}
        >
          {busy ? 'Saving…' : 'Confirm missing'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          style={{
            padding: '4px 10px',
            fontSize: 12,
            fontWeight: 600,
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'transparent',
            color: 'var(--fg)',
            cursor: busy ? 'not-allowed' : 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
