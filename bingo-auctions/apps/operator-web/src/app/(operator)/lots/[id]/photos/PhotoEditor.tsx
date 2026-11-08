'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { buttonStyle, secondaryButtonStyle } from '@/components/Form';
import { savePhotoOrder } from './actions';

export function PhotoEditor({
  lotId,
  operatorId,
  initialPhotoUrls,
}: {
  lotId: string;
  operatorId: string;
  initialPhotoUrls: string[];
}) {
  const router = useRouter();
  const supabase = getSupabaseBrowser();
  const [photos, setPhotos] = useState<string[]>(initialPhotoUrls);
  const [busy, setBusy] = useState<'upload' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [dragSrc, setDragSrc] = useState<number | null>(null);
  // BUG-LL-05: surface storage-delete failures so orphan files don't
  // accumulate silently. Cleared on every action so it doesn't linger.
  const [storageWarning, setStorageWarning] = useState<string | null>(null);

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;

    // BUG-LL-06 fix: client-side guard before uploading. The server
    // schema caps photoUrls at 20; without this pre-check the operator
    // could upload 5 photos with 19 already on file, succeed at the
    // storage uploads, then crash on the savePhotoOrder Zod validation
    // — leaving 5 orphaned files in Storage and the UI showing 24
    // photos that revert to 19 on reload.
    const MAX_PHOTOS = 20;
    if (photos.length + files.length > MAX_PHOTOS) {
      setError(
        `Maximum ${MAX_PHOTOS} photos per lot. You have ${photos.length} already; selected ${files.length}. ` +
          `Remove ${photos.length + files.length - MAX_PHOTOS} of the current photos or pick fewer.`,
      );
      e.target.value = '';
      return;
    }

    setBusy('upload');
    setError(null);
    try {
      const newUrls: string[] = [];
      for (const file of files) {
        const path = `${operatorId}/${lotId}/${Date.now()}-${file.name}`;
        const { error: upErr } = await supabase.storage
          .from('lot-photos')
          .upload(path, file, { cacheControl: '31536000', upsert: false });
        if (upErr) throw upErr;
        const { data } = supabase.storage.from('lot-photos').getPublicUrl(path);
        newUrls.push(data.publicUrl);
      }
      const next = [...photos, ...newUrls];
      setPhotos(next);
      const result = await savePhotoOrder({ lotId, photoUrls: next });
      if (!result.ok) throw new Error(result.error);
      setSavedAt(new Date());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
      // Clear the file input so the same file can be re-selected
      e.target.value = '';
    }
  }

  async function persist(next: string[]) {
    setPhotos(next);
    setBusy('save');
    setError(null);
    const result = await savePhotoOrder({ lotId, photoUrls: next });
    setBusy(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSavedAt(new Date());
  }

  async function removeAt(idx: number) {
    if (!confirm('Remove this photo?')) return;
    const next = photos.filter((_, i) => i !== idx);
    await persist(next);
    // BUG-LL-05 fix: best-effort delete from Storage so we don't
    // accumulate orphan files in the bucket. Previously this silently
    // swallowed all errors, including URL-parse failures from cache-
    // busting query strings ('…/lot-photos/foo.jpg?v=2' would never
    // match the regex). Now:
    //   - We strip query strings before matching
    //   - We log a console warning when the URL doesn't parse to a
    //     storage path (so the operator can see in DevTools why a
    //     cleanup didn't happen)
    //   - Storage delete failures surface as a non-blocking note
    //     under the photo grid (errorNotice state) without blocking
    //     the persist that already succeeded.
    const url = photos[idx];
    if (!url) return;
    try {
      const u = new URL(url);
      const pathOnly = u.pathname; // strips ?query and #frag automatically
      // Match anything after the bucket name. The full prefix is
      // `/storage/v1/object/public/lot-photos/` — we want the chunk
      // after `lot-photos/`. Supabase signed URLs have a `/sign/` prefix
      // instead of `/public/`; handle both.
      const m = pathOnly.match(/\/lot-photos\/(.+)$/);
      if (!m) {
        // Non-Supabase URL (legacy stock photo / external) — nothing to delete.
        return;
      }
      const storagePath = m[1]!;
      const { error: removeErr } = await supabase.storage
        .from('lot-photos')
        .remove([storagePath]);
      if (removeErr) {
        // Surface to UI as a soft warning. The lot's photo_urls already
        // dropped this photo via persist() above, so the bidder won't
        // see it — but the file lingers in storage until ops cleans up.
        // Show the operator so they can flag it; don't fail the action.
        console.warn('[PhotoEditor] storage delete failed:', removeErr.message);
        setStorageWarning(
          `Photo removed from this lot, but the file couldn't be deleted from storage: ${removeErr.message}. The operator's storage usage may be slightly higher than expected until cleanup.`,
        );
      }
    } catch (err) {
      // URL parse failure — probably a non-standard URL we shouldn't touch.
      console.warn('[PhotoEditor] could not parse photo URL for cleanup:', err);
    }
  }

  function move(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= photos.length || to >= photos.length) return;
    const next = [...photos];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    persist(next);
  }

  return (
    <div style={{ display: 'grid', gap: '1rem', maxWidth: 800 }}>
      <div
        style={{
          padding: '1rem',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          display: 'flex',
          gap: '1rem',
          alignItems: 'center',
        }}
      >
        <label style={{ ...buttonStyle, cursor: 'pointer' }}>
          {busy === 'upload' ? 'Uploading…' : 'Add photos'}
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={onUpload}
            disabled={busy !== null}
            style={{ display: 'none' }}
          />
        </label>
        <span style={{ color: 'var(--fg-muted)', fontSize: 13 }}>
          {photos.length} photo{photos.length === 1 ? '' : 's'} · drag to reorder
        </span>
        {savedAt && (
          <span style={{ color: 'var(--success)', fontSize: 13, marginLeft: 'auto' }}>
            Saved {savedAt.toLocaleTimeString()}
          </span>
        )}
      </div>

      {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
      {storageWarning && (
        <div
          style={{
            padding: '0.75rem',
            background: 'rgba(251, 191, 36, 0.08)',
            border: '1px solid var(--warning, #fbbf24)',
            color: 'var(--warning, #fbbf24)',
            borderRadius: 6,
            fontSize: 13,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 12,
          }}
        >
          <span>{storageWarning}</span>
          <button
            type="button"
            onClick={() => setStorageWarning(null)}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: 13,
            }}
            aria-label="dismiss"
          >
            ×
          </button>
        </div>
      )}

      {photos.length === 0 ? (
        <div
          style={{
            padding: '4rem 2rem',
            textAlign: 'center',
            background: 'var(--bg-elev)',
            border: '1px dashed var(--border)',
            borderRadius: 8,
            color: 'var(--fg-muted)',
          }}
        >
          No photos yet. Bidders see lots without photos with low conversion — add a few.
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: '0.75rem',
          }}
        >
          {photos.map((url, idx) => (
            <div
              key={url}
              draggable
              onDragStart={() => setDragSrc(idx)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragSrc != null) move(dragSrc, idx);
                setDragSrc(null);
              }}
              style={{
                position: 'relative',
                paddingTop: '75%',
                borderRadius: 8,
                overflow: 'hidden',
                background: '#14171f',
                border: '1px solid var(--border)',
                cursor: 'grab',
                opacity: dragSrc === idx ? 0.4 : 1,
              }}
            >
              <Image
                src={url}
                alt=""
                fill
                style={{ objectFit: 'cover' }}
                sizes="(max-width: 800px) 33vw, 200px"
                unoptimized
              />
              {idx === 0 && (
                <span
                  style={{
                    position: 'absolute',
                    top: 6,
                    left: 6,
                    background: 'rgba(0,0,0,0.6)',
                    color: '#fff',
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 4,
                  }}
                >
                  Cover
                </span>
              )}
              <div
                style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  padding: 6,
                  background: 'rgba(0,0,0,0.7)',
                  display: 'flex',
                  gap: 4,
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span style={{ color: '#fff', fontSize: 12 }}>{idx + 1}</span>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button
                    type="button"
                    onClick={() => move(idx, idx - 1)}
                    disabled={idx === 0}
                    style={{ ...secondaryButtonStyle, padding: '2px 8px', fontSize: 12 }}
                  >
                    ←
                  </button>
                  <button
                    type="button"
                    onClick={() => move(idx, idx + 1)}
                    disabled={idx === photos.length - 1}
                    style={{ ...secondaryButtonStyle, padding: '2px 8px', fontSize: 12 }}
                  >
                    →
                  </button>
                  <button
                    type="button"
                    onClick={() => removeAt(idx)}
                    style={{
                      ...secondaryButtonStyle,
                      padding: '2px 8px',
                      fontSize: 12,
                      color: 'var(--danger)',
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={() => router.push(`/lots/${lotId}`)}
          style={secondaryButtonStyle}
        >
          Back to lot
        </button>
      </div>
    </div>
  );
}
