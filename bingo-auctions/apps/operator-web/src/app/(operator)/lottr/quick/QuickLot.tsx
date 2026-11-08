'use client';

// Quick Lot — no-manifest, no-AI rapid entry.
// Target: ~5 seconds per lot. Type title → tap preset → done.
//
// UI flow:
//   1. Title input (autofocused after each successful save)
//   2. Optional photo (compressed client-side to ≤1200px JPEG 0.75)
//   3. Optional brand / model / category
//   4. 9 preset buttons: tapping one IMMEDIATELY submits the lot
//   5. "Create Lot" button for keyboard-only flow (Cmd/Ctrl+Enter)
//   6. "Create N copies" toggle → multiples path (2/5/10/15/20/custom)

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from 'react';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import {
  Field,
  buttonStyle,
  inputStyle,
  secondaryButtonStyle,
} from '@/components/Form';
import {
  createQuickLot,
  createQuickLotMultiples,
  type CategoryOption,
  type QuickLotCondition,
} from './actions';

// ---------------------------------------------------------------------------
// Presets — exact values from the LotTR prototype (prices in cents)
// ---------------------------------------------------------------------------

type Preset = {
  name: string;
  condition: QuickLotCondition;
  starting_bid_cents: number;
  color: string;
};

const PRESETS: Preset[] = [
  { name: 'New/Sealed $5',   condition: 'New/Sealed',    starting_bid_cents:  500, color: 'var(--success, #34d39a)' },
  { name: 'New/Sealed $10',  condition: 'New/Sealed',    starting_bid_cents: 1000, color: 'var(--success, #34d39a)' },
  { name: 'New/Sealed $25',  condition: 'New/Sealed',    starting_bid_cents: 2500, color: 'var(--success, #34d39a)' },
  { name: 'Open Box $5',     condition: 'New/Open Box',  starting_bid_cents:  500, color: 'var(--accent)' },
  { name: 'Open Box $10',    condition: 'New/Open Box',  starting_bid_cents: 1000, color: 'var(--accent)' },
  { name: 'Open Box $25',    condition: 'New/Open Box',  starting_bid_cents: 2500, color: 'var(--accent)' },
  { name: 'Used Good $1',    condition: 'Good',          starting_bid_cents:  100, color: 'var(--fg-muted)' },
  { name: 'Used Fair $1',    condition: 'Fair',          starting_bid_cents:  100, color: 'var(--fg-muted)' },
  { name: 'Damaged $1',      condition: 'Damaged/Parts', starting_bid_cents:  100, color: 'var(--danger)' },
];

const MULTIPLES_COUNTS = [2, 5, 10, 15, 20] as const;

// ---------------------------------------------------------------------------
// Image compression helper
// ---------------------------------------------------------------------------

// Battery note (2026-08-03, reported by the lotters: tablets and phones
// draining fast during a lotting shift). capture="environment" hands back a
// full-sensor frame — 12–48 MP on current devices. The old path spent that
// budget three times per photo:
//
//   1. FileReader.readAsDataURL on the ORIGINAL file — a main-thread base64
//      encode of the whole 5–10 MB JPEG, held in React state as a ~7–13 MB
//      string until save.
//   2. The browser decoding that full-resolution data URL to paint a ~72 px
//      thumbnail. A 12 MP frame is ~48 MB of RGBA.
//   3. compressImage decoding the SAME file a second time, via a second <img>,
//      to produce the ≤1200 px upload.
//
// So: one big encode, two full-res decodes, ~50 MB of transient bitmap and a
// multi-MB string, per lot, on a device doing hundreds of lots a shift.
//
// Now it decodes ONCE. createImageBitmap decodes off the main thread and
// .close() frees the full-res bitmap the moment it has been scaled down;
// OffscreenCanvas keeps the resize off-thread too where it exists. The preview
// then points at the ~60 KB compressed result instead of the original, so the
// thumbnail paint is a 1200 px decode rather than a 12 MP one, and the upload
// reuses that same blob rather than redoing the work at save time.
async function compressImage(file: File, maxPx = 1200, quality = 0.75): Promise<Blob> {
  // Preferred path. Safari gained createImageBitmap late and OffscreenCanvas
  // later still, hence the capability checks rather than a version sniff.
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    try {
      const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
      const w = Math.round(bitmap.width * scale);
      const h = Math.round(bitmap.height * scale);

      if (typeof OffscreenCanvas === 'function') {
        const off = new OffscreenCanvas(w, h);
        const octx = off.getContext('2d');
        if (octx) {
          octx.drawImage(bitmap, 0, 0, w, h);
          return await off.convertToBlob({ type: 'image/jpeg', quality });
        }
      }

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas unavailable');
      ctx.drawImage(bitmap, 0, 0, w, h);
      return await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('compression failed'))),
          'image/jpeg',
          quality,
        );
      });
    } finally {
      // Do not wait for GC to reclaim tens of MB of bitmap.
      bitmap.close();
    }
  }

  // Fallback: <img> decode. Still one decode, and the object URL is revoked.
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) { reject(new Error('canvas unavailable')); return; }
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob(
        (blob) => {
          if (!blob) { reject(new Error('compression failed')); return; }
          resolve(blob);
        },
        'image/jpeg',
        quality,
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')); };
    img.src = url;
  });
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

type ToastEntry = { id: number; message: string; error: boolean };

function useToasts() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(0);

  const push = useCallback((message: string, error = false) => {
    const id = ++nextId.current;
    setToasts((prev) => [...prev, { id, message, error }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 3500);
  }, []);

  return { toasts, push };
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type Props = {
  categories: CategoryOption[];
  operatorId: string;
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function QuickLot({ categories, operatorId }: Props) {
  const titleRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // 0272 duplicate-lot fix. `busy` is async React state, so a rapid double-click
  // (or two preset taps in one tick) can pass the `if (busy)` check twice and
  // mint two lots — the (null)-source duplicate pairs seen in prod. A ref flips
  // synchronously, so the second caller is rejected before it can submit.
  const submittingRef = useRef(false);
  // Stable per-lot idempotency token. Sent to createQuickLot and reused until a
  // successful save clears it (resetForm), so a server-action retry for the
  // same item converges on one lot via the DB unique index.
  const dedupTokenRef = useRef<string | null>(null);

  // Form state
  const [title, setTitle] = useState('');
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [categoryId, setCategoryId] = useState('');
  // Object URL of the COMPRESSED blob (~60 KB), not a data URL of the original
  // multi-MB capture. Revoked on replace/reset/unmount — an un-revoked object
  // URL pins its blob in memory for the life of the document, and this page
  // stays open all shift.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  // Already compressed at selection time, so save does no image work.
  const [pendingFile, setPendingFile] = useState<Blob | null>(null);

  // Multiples toggle
  const [multiplesMode, setMultiplesMode] = useState(false);
  const [multiplesCount, setMultiplesCount] = useState<number>(2);
  const [customCount, setCustomCount] = useState('');

  // Session counter
  const [sessionCount, setSessionCount] = useState(0);

  // Busy / error
  const [busy, setBusy] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [_, startTransition] = useTransition();
  const { toasts, push: pushToast } = useToasts();

  // Focus title on mount and after each save
  useEffect(() => {
    titleRef.current?.focus();
  }, [sessionCount]);

  // Free the last preview blob when the page finally closes. Without this the
  // final object URL outlives the component and its blob is pinned until the
  // document goes away.
  useEffect(() => {
    return () => {
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  // Cmd/Ctrl+Enter global shortcut — submit with first preset
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        const canSubmit = title.trim().length > 0 && !busy && !uploadingPhoto;
        if (canSubmit) void submitWithPreset(PRESETS[0]!);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, busy, uploadingPhoto, pendingFile, multiplesMode, multiplesCount, customCount, brand, model, categoryId]);

  // -------------------------------------------------------------------------
  // Photo handling
  // -------------------------------------------------------------------------

  // Replace whatever the preview currently points at, freeing the old blob.
  const setPreview = useCallback((url: string | null) => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = url;
    setPreviewUrl(url);
  }, []);

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return;
    // Compress on selection, not at save: the ~5s-per-lot target wants the
    // save path free of image work, and it means the original full-resolution
    // frame is decoded once and dropped rather than living in state.
    setUploadingPhoto(true);
    try {
      const blob = await compressImage(file);
      setPendingFile(blob);
      setPreview(URL.createObjectURL(blob));
    } catch (err) {
      pushToast(`Photo failed: ${(err as Error).message}`, true);
      setPendingFile(null);
      setPreview(null);
      if (fileRef.current) fileRef.current.value = '';
    } finally {
      setUploadingPhoto(false);
    }
  }

  async function uploadPhoto(blob: Blob, lotId: string): Promise<string | null> {
    setUploadingPhoto(true);
    try {
      const supabase = getSupabaseBrowser();
      const path = `${operatorId}/${lotId}/${Date.now()}.jpg`;
      const { error: upErr } = await supabase.storage
        .from('lot-photos')
        .upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000', upsert: false });
      if (upErr) throw upErr;
      const { data } = supabase.storage.from('lot-photos').getPublicUrl(path);
      return data.publicUrl;
    } catch (err) {
      pushToast(`Photo upload failed: ${(err as Error).message}`, true);
      return null;
    } finally {
      setUploadingPhoto(false);
    }
  }

  // -------------------------------------------------------------------------
  // Reset form (keep preset selection for rapid-fire)
  // -------------------------------------------------------------------------

  function resetForm() {
    setTitle('');
    setBrand('');
    setModel('');
    setCategoryId('');
    setPreview(null);
    setPendingFile(null);
    if (fileRef.current) fileRef.current.value = '';
    // 0272: retire this lot's idempotency token so the next item gets a fresh
    // one. Only reached after a successful create, so a failed/retried save
    // keeps its token (and dedups against a lot that may have committed).
    dedupTokenRef.current = null;
    startTransition(() => setSessionCount((c) => c + 1));
  }

  // -------------------------------------------------------------------------
  // Effective multiples count
  // -------------------------------------------------------------------------

  function effectiveCount(): number {
    if (!multiplesMode) return 1;
    if (customCount !== '') {
      const n = parseInt(customCount, 10);
      if (!isNaN(n) && n >= 2 && n <= 20) return n;
    }
    return multiplesCount;
  }

  // -------------------------------------------------------------------------
  // Core submit
  // -------------------------------------------------------------------------

  async function submitWithPreset(preset: Preset) {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    // 0272: reject re-entry synchronously (ref) as well as across renders (busy).
    // uploadingPhoto also covers the compress-on-selection window: the photo is
    // no longer attached synchronously, so without this a fast preset tap would
    // save the lot before its image existed and silently drop the photo.
    if (submittingRef.current || busy || uploadingPhoto) return;
    submittingRef.current = true;

    setBusy(true);

    try {
      const count = effectiveCount();
      const baseInput = {
        title: trimmedTitle,
        brand: brand.trim() || undefined,
        model: model.trim() || undefined,
        category_id: categoryId || null,
        condition: preset.condition,
        starting_bid_cents: preset.starting_bid_cents,
      };

      if (count > 1) {
        // Multiples path — photo not supported for multiples (no lot ID yet
        // until after insert, and we'd need N uploads). Skip photo silently.
        const result = await createQuickLotMultiples({ ...baseInput, count });
        if (!result.ok) {
          pushToast(`Error: ${result.error}`, true);
          return;
        }
        const first = result.lots[0]!;
        const last = result.lots[result.lots.length - 1]!;
        pushToast(
          `${result.lots.length} lots created: ${first.lotCode} — ${last.lotCode}`,
        );
        resetForm();
      } else {
        // Single lot path. 0272: attach a stable idempotency token (minted once
        // per filled form, reused until resetForm) so a double-submit dedups.
        const clientToken = (dedupTokenRef.current ??= crypto.randomUUID());
        const result = await createQuickLot({ ...baseInput, client_token: clientToken });
        if (!result.ok) {
          pushToast(`Error: ${result.error}`, true);
          return;
        }

        // Upload photo after we have a lotId
        if (pendingFile) {
          const photoUrl = await uploadPhoto(pendingFile, result.lotId);
          // If upload succeeded, patch the lot's photo_urls. We do a best-effort
          // fire-and-forget via the Supabase browser client — no server action
          // round-trip needed, and a failure here is non-fatal.
          if (photoUrl) {
            const supabase = getSupabaseBrowser();
            await supabase
              .from('lots')
              .update({ photo_urls: [photoUrl] })
              .eq('id', result.lotId);
          }
        }

        pushToast(`${result.lotCode} created`);
        resetForm();
      }
    } finally {
      setBusy(false);
      submittingRef.current = false;
    }
  }

  const canSubmit = title.trim().length > 0 && !busy && !uploadingPhoto;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div style={{ maxWidth: 720, display: 'grid', gap: '1rem' }}>

      {/* Speed hint */}
      <div
        style={{
          padding: '0.5rem 0.75rem',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          fontSize: 12,
          color: 'var(--fg-muted)',
          textAlign: 'center',
          letterSpacing: 0.5,
        }}
      >
        NO AI · NO PRICE LOOKUP · Type title &rarr; Tap preset &rarr; Done
        &nbsp;&nbsp;|&nbsp;&nbsp;{sessionCount} created this session
      </div>

      {/* Photo + Title row */}
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
        {/* Photo thumbnail */}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          title="Tap to add photo (optional)"
          style={{
            flexShrink: 0,
            width: 72,
            height: 72,
            borderRadius: 6,
            border: '2px dashed var(--border)',
            background: 'var(--bg-elev)',
            cursor: 'pointer',
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
          }}
        >
          {previewUrl ? (
            // plain <img> — opennextjs has known edge cases with <Image> over CF resizing
            <img
              src={previewUrl}
              alt="preview"
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <span style={{ fontSize: 28, color: 'var(--fg-muted)', lineHeight: 1 }}>+</span>
          )}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: 'none' }}
          onChange={onFileChange}
        />

        {/* Title input — large for speed */}
        <input
          ref={titleRef}
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Item title (Cmd/Ctrl+Enter to lot with first preset)"
          style={{
            ...inputStyle,
            flex: 1,
            fontSize: 16,
            fontWeight: 600,
            padding: '1rem 0.75rem',
            minHeight: 72,
          }}
          disabled={busy}
          autoFocus
        />
      </div>

      {/* Optional: Brand + Model */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
        <Field label="Brand (optional)">
          <input
            type="text"
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            placeholder="e.g. DeWalt"
            style={inputStyle}
            disabled={busy}
          />
        </Field>
        <Field label="Model (optional)">
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="e.g. DCD771C2"
            style={inputStyle}
            disabled={busy}
          />
        </Field>
      </div>

      {/* Optional: Category */}
      {categories.length > 0 && (
        <Field label="Category (optional)">
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            style={inputStyle}
            disabled={busy}
          >
            <option value="">— select category —</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      {/* Multiples toggle */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          flexWrap: 'wrap',
        }}
      >
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            fontSize: 13,
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <input
            type="checkbox"
            checked={multiplesMode}
            onChange={(e) => setMultiplesMode(e.target.checked)}
            style={{ width: 16, height: 16, cursor: 'pointer' }}
          />
          Create N copies
        </label>

        {multiplesMode && (
          <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
            {MULTIPLES_COUNTS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => { setMultiplesCount(n); setCustomCount(''); }}
                style={{
                  ...secondaryButtonStyle,
                  padding: '0.35rem 0.65rem',
                  fontSize: 13,
                  fontWeight: 700,
                  background:
                    customCount === '' && multiplesCount === n
                      ? 'var(--bg-elev)'
                      : 'transparent',
                  border:
                    customCount === '' && multiplesCount === n
                      ? '1px solid var(--accent)'
                      : '1px solid var(--border)',
                  color:
                    customCount === '' && multiplesCount === n
                      ? 'var(--accent)'
                      : 'var(--fg-muted)',
                }}
              >
                {n}
              </button>
            ))}
            <input
              type="number"
              min={2}
              max={20}
              placeholder="custom"
              value={customCount}
              onChange={(e) => setCustomCount(e.target.value)}
              style={{
                ...inputStyle,
                width: 80,
                padding: '0.35rem 0.5rem',
                fontSize: 13,
              }}
            />
            <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              = {effectiveCount()} lots per preset tap
            </span>
          </div>
        )}
      </div>

      {/* Preset grid — THE MAIN UI */}
      <div>
        <div
          style={{
            fontSize: 11,
            letterSpacing: 1,
            textTransform: 'uppercase',
            color: 'var(--fg-muted)',
            fontWeight: 700,
            marginBottom: '0.5rem',
          }}
        >
          Tap a preset to create lot instantly
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '0.5rem',
          }}
        >
          {PRESETS.map((p, i) => (
            <button
              key={i}
              type="button"
              onClick={() => void submitWithPreset(p)}
              disabled={!canSubmit}
              style={{
                padding: '1rem 0.5rem',
                fontFamily: 'inherit',
                fontWeight: 700,
                fontSize: 13,
                borderRadius: 8,
                border: `1.5px solid ${canSubmit ? p.color : 'var(--border)'}`,
                background: canSubmit ? 'var(--bg-elev)' : 'transparent',
                color: canSubmit ? p.color : 'var(--fg-muted)',
                cursor: canSubmit ? 'pointer' : 'default',
                opacity: canSubmit ? 1 : 0.45,
                textAlign: 'center',
                lineHeight: 1.3,
                // ≥44px tap target per mobile-friendliness requirement
                minHeight: 52,
                transition: 'opacity 0.1s',
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>

      {/* "Create Lot" button — keyboard-only / explicit path */}
      <button
        type="button"
        onClick={() => void submitWithPreset(PRESETS[0]!)}
        disabled={!canSubmit}
        style={{
          ...buttonStyle,
          opacity: canSubmit ? 1 : 0.5,
          cursor: canSubmit ? 'pointer' : 'default',
          fontSize: 14,
          fontWeight: 700,
          padding: '0.75rem',
        }}
      >
        {busy
          ? uploadingPhoto
            ? 'Uploading photo…'
            : 'Creating…'
          : uploadingPhoto
            // Compression now runs at selection, so this state is reachable
            // with busy=false. Without a label the button just looks dead.
            ? 'Processing photo…'
            : 'Create Lot (uses first preset)'}
        {!busy && (
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)', marginLeft: '0.5rem' }}>
            Cmd/Ctrl+Enter
          </span>
        )}
      </button>

      {/* Toast stack */}
      <div
        aria-live="polite"
        style={{
          position: 'fixed',
          bottom: '1.5rem',
          right: '1.5rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.5rem',
          zIndex: 9999,
          pointerEvents: 'none',
        }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              padding: '0.6rem 1rem',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              background: t.error ? 'rgba(255,90,90,0.15)' : 'rgba(34,211,154,0.15)',
              border: `1px solid ${t.error ? 'var(--danger)' : 'var(--success, #34d39a)'}`,
              color: t.error ? 'var(--danger)' : 'var(--success, #34d39a)',
              boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            }}
          >
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
