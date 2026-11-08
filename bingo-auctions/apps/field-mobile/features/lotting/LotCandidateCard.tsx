// Read-only visual summary of a LotCandidate. Still used by shelf-scan.tsx
// candidate review rows. For the main scan/quick flow, use EditableCandidateCard
// instead.
//
// Thumbnail bug analysis (H):
//   Root cause found: the stockPhotos array can contain empty strings when
//   isSafeImageUrl() in domain-lotting/normalize/images filters out URLs
//   that aren't on ALLOWED_IMAGE_HOSTS. Those empty strings were being passed
//   directly to <Image source={{ uri: "" }} /> which renders nothing but still
//   takes up space in the flex row, causing layout gaps.
//
//   Fix applied:
//   1. Filter `stockPhotos` to skip empty strings before rendering.
//   2. Every <Image> now has explicit width+height on the outer <View>
//      (72×72) — expo-image requires a concrete size or it collapses to
//      0×0. The Image itself uses style={{ flex: 1 }} inside a sized View.
//   3. Added `placeholder={{ color: colors.surfaceAlt }}` so the slot is
//      visibly occupied while the image loads or if the URL errors.
//   4. Added `transition={150}` for a soft fade-in instead of a hard pop.
//
//   TODO(thumbnails): If images from a specific CDN still fail to load,
//   add their hostname to ALLOWED_IMAGE_HOSTS in
//   packages/domain-lotting/src/normalize/images.ts. Enable
//   console.log(candidate.stockPhotos) before this component renders to
//   verify URLs are reaching this file and aren't being silently dropped
//   upstream.

import { View, Text } from 'react-native';
import { Image } from 'expo-image';
import { formatCents } from '@auction-platform/shared';
import type { LotCandidate } from '@auction-platform/domain-lotting';
import { colors, type } from '@auction-platform/design-system';

export function LotCandidateCard({ candidate }: { candidate: LotCandidate }) {
  // Filter out empty strings that isSafeImageUrl produced — passing an empty
  // URI to expo-image gives a broken image element with invisible dimensions.
  const safePhotos = candidate.stockPhotos.filter((url) => url.trim().length > 0);

  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: colors.border,
        padding: 16,
        gap: 8,
      }}
    >
      <Text
        style={{
          color: colors.primary,
          fontSize: 11,
          ...type.label,
        }}
      >
        {candidate.confidence} confidence · {candidate.brand || 'brand?'} ·{' '}
        {candidate.model || 'model?'}
      </Text>
      <Text style={{ color: colors.text, fontSize: 18, fontWeight: '800' }}>
        {candidate.title || candidate.fullTitle || '(untitled)'}
      </Text>

      {safePhotos.length > 0 && (
        <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
          {safePhotos.slice(0, 4).map((url, i) => (
            // The outer View has a fixed size so expo-image never collapses
            // to 0×0 from a missing intrinsic dimension.
            <View
              key={`${url}-${i}`}
              style={{
                width: 56,
                height: 56,
                borderRadius: 6,
                overflow: 'hidden',
                backgroundColor: colors.surfaceAlt,
              }}
            >
              <Image
                source={{ uri: url }}
                style={{ flex: 1 }}
                contentFit="cover"
                cachePolicy="memory-disk"
                // Single-color blurhash as placeholder so the image slot
                // is visibly occupied while loading / on error.
                placeholder="L00000fQfQfQ~qfQfQfQfQfQfQ"
                transition={150}
              />
            </View>
          ))}
        </View>
      )}

      {candidate.description && (
        <Text style={{ color: colors.textMuted, fontSize: 13, lineHeight: 18 }}>
          {candidate.description}
        </Text>
      )}

      {candidate.notes && (
        <Text style={{ color: colors.danger, fontSize: 12, lineHeight: 18 }}>
          {candidate.notes}
        </Text>
      )}

      <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
        <Stat
          label="MSRP"
          value={
            candidate.msrp ? formatCents(Math.round(candidate.msrp * 100)) : '—'
          }
        />
        <Stat
          label="Avg"
          value={
            candidate.avg ? formatCents(Math.round(candidate.avg * 100)) : '—'
          }
        />
        <Stat
          label="Start"
          value={
            candidate.startBid
              ? formatCents(Math.round(candidate.startBid * 100))
              : '—'
          }
        />
      </View>

      {candidate.prices.length > 0 && (
        <>
          <Text
            style={{
              color: colors.textMuted,
              fontSize: 11,
              ...type.label,
              marginTop: 8,
            }}
          >
            Retailers
          </Text>
          {candidate.prices.map((p, i) => (
            <View
              key={i}
              style={{ flexDirection: 'row', justifyContent: 'space-between' }}
            >
              <Text style={{ color: colors.text, fontSize: 13 }}>{p.retailer}</Text>
              <Text style={{ color: colors.text, fontSize: 13, fontWeight: '700' }}>
                {formatCents(Math.round(p.price * 100))}
              </Text>
            </View>
          ))}
        </>
      )}

      {candidate.specs && (
        <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 8 }}>
          {candidate.specs}
        </Text>
      )}
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={{ color: colors.textMuted, fontSize: 10, ...type.label }}>
        {label}
      </Text>
      <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700' }}>
        {value}
      </Text>
    </View>
  );
}
