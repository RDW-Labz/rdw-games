'use client';

// One feedback submission, with its triage control.
//
// The diagnostics line is rendered at the same weight as the message body on
// purpose. When someone reads "the scanner spins forever", the next question
// is always "on which build?" — putting the answer on the same card is the
// whole reason those columns exist (see 0317, and #248 for what it costs when
// they don't).

import { useState, useTransition } from 'react';
import { formatInTimeZone } from '@/lib/datetime';
import { emailFeedbackReply, triageFeedback, type TriageStatus } from './actions';
import type { FeedbackRecord } from './page';

/** 0327 added 'web' — a customer on the website, often with no account. */
const APP_LABEL: Record<string, string> = {
  staff: 'Staff app',
  bidder: 'Bidder app',
  web: 'Website',
};

const STATUS_OPTIONS: { value: TriageStatus; label: string }[] = [
  { value: 'new', label: 'New' },
  { value: 'triaged', label: 'Triaged' },
  { value: 'planned', label: 'Planned' },
  { value: 'fixed', label: 'Fixed' },
  { value: 'wont_fix', label: "Won't fix" },
];

export function FeedbackRow({ record }: { record: FeedbackRecord }) {
  const [status, setStatus] = useState<TriageStatus>(record.status as TriageStatus);
  const [note, setNote] = useState(record.triage_note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const dirty = status !== record.status || note !== (record.triage_note ?? '');

  const [emailed, setEmailed] = useState<string | null>(record.reply_emailed_at ?? null);
  const [emailPending, startEmail] = useTransition();

  function emailReply() {
    setError(null);
    startEmail(async () => {
      const result = await emailFeedbackReply({ id: record.id });
      if (!result.ok) setError(result.error);
      else setEmailed(result.sentAt);
    });
  }

  function save() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await triageFeedback({
        id: record.id,
        status,
        note: note.trim() ? note.trim() : null,
      });
      if (!result.ok) setError(result.error);
      else setSaved(true);
    });
  }

  const isBug = record.kind === 'bug';
  const updateShort =
    record.update_id && record.update_id !== 'embedded'
      ? record.update_id.slice(0, 8)
      : 'embedded';

  return (
    <li
      id={`fb-${record.id}`}
      style={{
        padding: '1rem',
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${isBug ? 'var(--danger)' : 'var(--accent)'}`,
        borderRadius: 6,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.5rem',
          alignItems: 'center',
          marginBottom: '0.5rem',
        }}
      >
        <Tag tone={isBug ? 'danger' : 'accent'}>{isBug ? 'BUG' : 'IDEA'}</Tag>
        <Tag>{APP_LABEL[record.app] ?? record.app}</Tag>
        <span style={{ color: 'var(--fg-muted)', fontSize: 13 }}>
          {formatInTimeZone(record.created_at, null)}
        </span>
        {record.reporter_label ? (
          <span style={{ color: 'var(--fg)', fontSize: 13, fontWeight: 600 }}>
            {record.reporter_label}
          </span>
        ) : null}
      </div>

      <p
        style={{
          margin: '0 0 0.6rem',
          fontSize: 14,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
        }}
      >
        {record.message}
      </p>

      {record.attachment_urls.length > 0 && (
        <div
          style={{
            display: 'flex',
            gap: '0.5rem',
            flexWrap: 'wrap',
            margin: '0 0 0.75rem',
          }}
        >
          {record.attachment_urls.map((a) =>
            a.content_type.startsWith('video') ? (
              // Inline rather than a download link: the point of a recording is
              // to watch the failure happen while reading the report next to it.
              <video
                key={a.url}
                src={a.url}
                controls
                preload="metadata"
                style={{ maxWidth: 320, maxHeight: 320, borderRadius: 6, border: '1px solid var(--border)' }}
              />
            ) : (
              <a key={a.url} href={a.url} target="_blank" rel="noreferrer">
                {/* Plain <img>: the src is a signed, expiring Storage URL,
                    which next/image cannot optimize anyway. */}
                <img
                  src={a.url}
                  alt="Reporter screenshot"
                  style={{ maxWidth: 200, maxHeight: 320, borderRadius: 6, border: '1px solid var(--border)' }}
                />
              </a>
            ),
          )}
        </div>
      )}

      {/* The only reply path on an anonymous web report — worth its own line
          rather than buried in the diagnostics run-on. */}
      {record.contact_email ? (
        <p style={{ margin: '0 0 0.5rem', fontSize: 13 }}>
          Reply to{' '}
          <a href={`mailto:${record.contact_email}`} style={{ color: 'var(--accent)' }}>
            {record.contact_email}
          </a>
        </p>
      ) : null}

      <p style={{ margin: '0 0 0.75rem', fontSize: 12, color: 'var(--fg-muted)' }}>
        v{record.app_version ?? '?'} · {updateShort}
        {record.device_model ? ` · ${record.device_model}` : ''}
        {record.os_version
          ? ` · ${record.platform === 'ios' ? 'iOS' : 'Android'} ${record.os_version}`
          : ''}
        {record.screen ? ` · ${record.screen}` : ''}
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as TriageStatus)}
          aria-label="Triage status"
          style={{
            padding: '0.4rem 0.5rem',
            background: 'var(--bg)',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            fontSize: 13,
          }}
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={
            record.app === 'staff'
              ? 'Reply — the worker sees this under "Your reports" in the staff app'
              : 'Reply — save, then email it to the customer'
          }
          aria-label="Reply"
          style={{
            flex: '1 1 16rem',
            padding: '0.4rem 0.5rem',
            background: 'var(--bg)',
            color: 'var(--fg)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            fontSize: 13,
          }}
        />

        <button
          type="button"
          onClick={save}
          disabled={pending || !dirty}
          style={{
            padding: '0.4rem 0.9rem',
            background: dirty ? 'var(--accent)' : 'var(--bg)',
            color: dirty ? '#000' : 'var(--fg-muted)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            fontSize: 13,
            fontWeight: 600,
            cursor: pending || !dirty ? 'default' : 'pointer',
            opacity: pending ? 0.6 : 1,
          }}
        >
          {pending ? 'Saving…' : 'Save'}
        </button>

        {record.can_email_reply ? (
          <button
            type="button"
            onClick={emailReply}
            disabled={emailPending || dirty || !(record.triage_note ?? '').trim()}
            title={dirty ? 'Save the reply first' : undefined}
            style={{
              padding: '0.4rem 0.9rem',
              background: 'var(--bg)',
              color: 'var(--fg)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontSize: 13,
              cursor: emailPending || dirty ? 'default' : 'pointer',
              opacity: emailPending ? 0.6 : 1,
            }}
          >
            {emailPending ? 'Sending…' : emailed ? 'Email reply again' : 'Email reply to customer'}
          </button>
        ) : null}
        {emailed ? (
          <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
            Emailed {formatInTimeZone(emailed, 'America/Chicago')}
          </span>
        ) : null}

        {saved && !dirty ? (
          <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>Saved</span>
        ) : null}
        {error ? (
          <span style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</span>
        ) : null}
      </div>
    </li>
  );
}

function Tag({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: 'danger' | 'accent';
}) {
  const color =
    tone === 'danger' ? 'var(--danger)' : tone === 'accent' ? 'var(--accent)' : 'var(--fg-muted)';
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.6,
        color,
        border: `1px solid ${color}`,
        borderRadius: 4,
        padding: '0.1rem 0.4rem',
        textTransform: 'uppercase',
      }}
    >
      {children}
    </span>
  );
}
