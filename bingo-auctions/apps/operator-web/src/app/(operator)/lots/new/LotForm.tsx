'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { dollarsToCents } from '@auction-platform/shared/money';
import { getSupabaseBrowser } from '@/lib/supabase-browser';
import { Field, buttonStyle, inputStyle } from '@/components/Form';
import { createLot } from './actions';

type Auction = {
  id: string;
  title: string;
  warehouse_id: string;
  ends_at: string;
  starts_at: string;
  format: 'standard' | 'dutch' | 'last_chance';
};

export function LotForm({
  auctions,
  defaultAuctionId,
}: {
  auctions: Auction[];
  defaultAuctionId: string | null;
}) {
  const router = useRouter();
  const supabase = getSupabaseBrowser();

  const [auctionId, setAuctionId] = useState(defaultAuctionId ?? auctions[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [condition, setCondition] = useState<'appears_new' | 'open_box' | 'good' | 'as_is'>('good');
  const [msrp, setMsrp] = useState('');
  const [startingBid, setStartingBid] = useState('1');
  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  // Per-format inputs (only the relevant ones are submitted)
  const [flatPrice, setFlatPrice] = useState('');
  const [dutchStart, setDutchStart] = useState('');
  const [dutchFloor, setDutchFloor] = useState('');
  const [dutchDeclinePerMin, setDutchDeclinePerMin] = useState('');
  const [earlyAccessMinutes, setEarlyAccessMinutes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const auction = auctions.find((a) => a.id === auctionId);

  async function uploadPhotos(operatorId: string, lotId: string): Promise<string[]> {
    const urls: string[] = [];
    for (const file of photoFiles) {
      const path = `${operatorId}/${lotId}/${Date.now()}-${file.name}`;
      const { error: upErr } = await supabase.storage.from('lot-photos').upload(path, file, {
        cacheControl: '31536000',
        upsert: false,
      });
      if (upErr) throw upErr;
      const { data } = supabase.storage.from('lot-photos').getPublicUrl(path);
      urls.push(data.publicUrl);
    }
    return urls;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!auction) {
      setError('Pick an auction');
      return;
    }

    setLoading(true);

    try {
      // Per-format validation: only send fields relevant to the auction format.
      let flatPriceCents: number | undefined;
      let dutchStartCents: number | undefined;
      let dutchFloorCents: number | undefined;
      let dutchDeclinePerMinuteCents: number | undefined;

      if (auction.format === 'last_chance') {
        if (!flatPrice) {
          setError('Last Chance lots need a flat price');
          setLoading(false);
          return;
        }
        flatPriceCents = dollarsToCents(flatPrice);
      }
      if (auction.format === 'dutch') {
        if (!dutchStart || !dutchDeclinePerMin) {
          setError('Dutch lots need a starting price and a per-minute decline');
          setLoading(false);
          return;
        }
        dutchStartCents = dollarsToCents(dutchStart);
        if (dutchFloor) dutchFloorCents = dollarsToCents(dutchFloor);
        // dutchDeclinePerMin is also a dollar amount the operator typed
        dutchDeclinePerMinuteCents = dollarsToCents(dutchDeclinePerMin);
      }

      // 2026-05-20 BUG-LL-01 fix: early-access now lands in the canonical
      // createLot insert instead of a separate client-side patch. The
      // patch was vulnerable to silent failure on network drop.
      let earlyAccessUntil: string | undefined;
      if (earlyAccessMinutes) {
        const mins = Number(earlyAccessMinutes);
        if (Number.isFinite(mins) && mins > 0) {
          earlyAccessUntil = new Date(
            new Date(auction.starts_at).getTime() - mins * 60_000,
          ).toISOString();
        }
      }

      const result = await createLot({
        auctionId: auction.id,
        warehouseId: auction.warehouse_id,
        title,
        description: description || undefined,
        category: category || undefined,
        condition,
        msrpCents: msrp ? dollarsToCents(msrp) : undefined,
        startingBidCents: dollarsToCents(startingBid),
        closeAt: auction.ends_at,
        photoUrls: [],
        flatPriceCents,
        dutchStartCents,
        dutchFloorCents,
        dutchDeclinePerMinuteCents,
        earlyAccessUntil,
      });

      if (!result.ok) {
        setError(result.error);
        setLoading(false);
        return;
      }

      // Upload photos and patch the lot row with the URLs
      if (photoFiles.length) {
        const operatorId = result.operatorId;
        const photoUrls = await uploadPhotos(operatorId, result.lotId);
        await supabase.from('lots').update({ photo_urls: photoUrls }).eq('id', result.lotId);
      }

      router.push(`/auctions/${auction.id}`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} style={{ display: 'grid', gap: '1rem', maxWidth: 640 }}>
      <Field label="Auction" hint={auction ? `Format: ${auction.format}` : undefined}>
        <select
          style={inputStyle}
          value={auctionId}
          onChange={(e) => setAuctionId(e.target.value)}
          required
        >
          {auctions.map((a) => (
            <option key={a.id} value={a.id}>
              {a.title} ({a.format})
            </option>
          ))}
        </select>
      </Field>
      <Field label="Title">
        <input style={inputStyle} value={title} onChange={(e) => setTitle(e.target.value)} required />
      </Field>
      <Field label="Description">
        <textarea
          style={{ ...inputStyle, minHeight: 80 }}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '0.75rem' }}>
        <Field label="Category">
          <input
            style={inputStyle}
            placeholder="e.g. electronics, tools, home"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          />
        </Field>
        <Field label="Condition">
          <select
            style={inputStyle}
            value={condition}
            onChange={(e) => setCondition(e.target.value as typeof condition)}
          >
            <option value="appears_new">Appears new</option>
            <option value="open_box">Open box</option>
            <option value="good">Good</option>
            <option value="as_is">As-is</option>
          </select>
        </Field>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
        <Field label="MSRP ($)" hint="Optional">
          <input
            style={inputStyle}
            type="number"
            step="0.01"
            value={msrp}
            onChange={(e) => setMsrp(e.target.value)}
          />
        </Field>
        <Field label="Starting bid ($)" hint={auction?.format !== 'standard' ? 'Used as a fallback if format-specific price is missing' : undefined}>
          <input
            style={inputStyle}
            type="number"
            step="0.01"
            min="0.01"
            value={startingBid}
            onChange={(e) => setStartingBid(e.target.value)}
            required
          />
        </Field>
      </div>

      {auction?.format === 'last_chance' && (
        <Field label="Flat price ($)" hint="Last-Chance lots: bidder buys at this price.">
          <input
            style={inputStyle}
            type="number"
            step="0.01"
            min="1"
            value={flatPrice}
            onChange={(e) => setFlatPrice(e.target.value)}
            required
          />
        </Field>
      )}

      {auction?.format === 'dutch' && (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
            <Field label="Dutch start price ($)" hint="Price at auction.starts_at">
              <input
                style={inputStyle}
                type="number"
                step="0.01"
                min="1"
                value={dutchStart}
                onChange={(e) => setDutchStart(e.target.value)}
                required
              />
            </Field>
            <Field label="Dutch floor price ($)" hint="Optional. Decline stops here.">
              <input
                style={inputStyle}
                type="number"
                step="0.01"
                value={dutchFloor}
                onChange={(e) => setDutchFloor(e.target.value)}
              />
            </Field>
          </div>
          <Field label="Decline rate ($/minute)" hint="How fast the price drops per minute">
            <input
              style={inputStyle}
              type="number"
              step="0.01"
              min="0.01"
              value={dutchDeclinePerMin}
              onChange={(e) => setDutchDeclinePerMin(e.target.value)}
              required
            />
          </Field>
        </div>
      )}

      <Field
        label="Early access (minutes before public)"
        hint="Optional. Pro subscribers see the lot this many minutes earlier."
      >
        <input
          style={inputStyle}
          type="number"
          min="0"
          step="1"
          value={earlyAccessMinutes}
          onChange={(e) => setEarlyAccessMinutes(e.target.value)}
        />
      </Field>

      <Field label="Photos" hint="Multiple. Uploaded to Supabase Storage on submit.">
        <input
          type="file"
          accept="image/*"
          multiple
          onChange={(e) => setPhotoFiles(Array.from(e.target.files ?? []))}
          style={{ color: 'var(--fg-muted)' }}
        />
      </Field>
      {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
      <div>
        <button type="submit" disabled={loading} style={buttonStyle}>
          {loading ? 'Creating…' : 'Create lot'}
        </button>
      </div>
    </form>
  );
}
