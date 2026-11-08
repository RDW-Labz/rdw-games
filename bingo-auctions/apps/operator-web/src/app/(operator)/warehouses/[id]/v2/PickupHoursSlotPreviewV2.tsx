// mirrors v1 warehouses/[id]/pickup-hours/page.tsx slot preview section — keep in sync
export function PickupHoursSlotPreviewV2({
  tz,
  previewDays,
}: {
  tz: string;
  previewDays: { label: string; slots: string[] }[];
}) {
  return (
    <section
      style={{
        marginTop: '2rem',
        padding: '1rem',
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 6,
      }}
    >
      <h2 style={{ fontSize: '0.95rem', margin: '0 0 0.75rem' }}>
        Slot preview — next 7 days ({tz})
      </h2>
      <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '0 0 1rem' }}>
        Reflects the currently saved schedule, not unsaved changes.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '0.75rem' }}>
        {previewDays.map(({ label, slots }) => (
          <div key={label}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: '0.4rem' }}>{label}</div>
            {slots.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Closed</div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                {slots.slice(0, 12).map((s) => (
                  <span
                    key={s}
                    style={{
                      fontSize: 11,
                      padding: '0.1rem 0.35rem',
                      background: 'var(--bg)',
                      border: '1px solid var(--border)',
                      borderRadius: 3,
                    }}
                  >
                    {s}
                  </span>
                ))}
                {slots.length > 12 && (
                  <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>+{slots.length - 12} more</span>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
