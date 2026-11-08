// PickupMap — the wedge feature.
//
// Renders the warehouse floor plan as a zoomable image with bin overlays.
// The bidder's bins are highlighted in accent color; other bins are dimmed.
// A dashed route line connects the bidder's bins in walking order (sorted
// by aisle, then x_px) starting from a fixed entrance point.
//
// Pan/zoom: use a horizontal+vertical ScrollView wrapping the image; iOS
// supports pinch via maximumZoomScale. Android doesn't natively pinch a
// ScrollView, but for an MVP a single-finger pan is enough — operators can
// design floor plans wide enough to be readable without aggressive zoom.
// Future: gesture-handler + Reanimated for true Android pinch; tracked in
// the post-launch backlog as it requires a fresh TestFlight build to
// validate.
//
// Interactivity additions (2026-05-20, Phase 4):
//   - Numbered route pill rail above the map ("Stop 1: A → Stop 2: B …")
//     so the bidder can plan their walk before opening the map.
//   - Tapping a landmark card highlights the corresponding bin pin
//     briefly so the bidder's eye finds it on the floor plan.

import { useCallback, useState } from 'react';
import { Dimensions, ScrollView, View, Image, Text, Pressable } from 'react-native';
import Svg, {
  Circle,
  G,
  Line,
  SvgUri,
  Text as SvgText,
} from 'react-native-svg';

export type BinPin = {
  binId: string;
  code: string;
  aisle: string;
  xPx: number;
  yPx: number;
  isMine: boolean;
  pickedUp?: boolean;
  /** Landmark photo of the bin in situ. When present, the pickup map
   *  renders it in the "your bins" rail so the bidder recognises the
   *  shelf instead of just decoding a code on a map. */
  landmarkPhotoUrl?: string | null;
  /** 2026-05-21: walk-mode absolute coordinates in METERS, populated by
   *  the ARKit-equipped walk-and-scan flow. When useMetricCoords is true
   *  on the parent and these are non-null, the map renders bins at real
   *  scale instead of pixel-on-floorplan. Mixed warehouses (some bins
   *  ARKit-stamped, some not) fall back to grid interpolation from the
   *  bin code for the un-stamped ones. */
  coordXm?: number | null;
  coordYm?: number | null;
};

export type PickupMapProps = {
  floorPlanUrl: string;
  widthPx: number;
  heightPx: number;
  bins: BinPin[];
  /** Optional entrance coordinate. Default: bottom-center of the floor plan. */
  entrance?: { x: number; y: number };
  /** When true, ignore floorPlanUrl + xPx/yPx and project bins from their
   *  walk-mode meter coordinates. Caller should set this when any bin in
   *  the warehouse has coord_x_m (i.e. the walk-and-scan flow has been
   *  run at least partially). Default: false. */
  useMetricCoords?: boolean;
  /** Safety guard — migration 0165 maps four pickup modes.
   *  PickupMap is only meaningful for 'self_serve_floor_plan'.
   *  When explicitly set to any other value the component returns null.
   *  Callers that omit this prop retain the current behaviour (no guard). */
  pickupMode?: 'counter_pickup' | 'staff_assisted' | 'self_serve_floor_plan' | 'hybrid' | string;
};

export function PickupMap({
  floorPlanUrl,
  widthPx,
  heightPx,
  bins,
  entrance,
  useMetricCoords,
  pickupMode,
}: PickupMapProps) {
  // Guard: only render for self_serve_floor_plan (or when pickupMode is not
  // specified — backward compat). Other modes have no floor-plan map.
  if (pickupMode !== undefined && pickupMode !== 'self_serve_floor_plan') {
    return null;
  }

  const screen = Dimensions.get('window');

  // 2026-05-21: metric-mode projection. When useMetricCoords is true we
  // build a synthetic pixel-space from the bins' meter coordinates and
  // remap each bin's xPx/yPx into that space. Bins without ARKit coords
  // fall back to a grid interpolation parsed from their code. The rest
  // of the rendering code stays pixel-oriented — only the inputs change.
  const projected = useMetricCoords
    ? projectMetricBinsToPixelSpace(bins, widthPx, heightPx)
    : { bins, entry: entrance ?? { x: widthPx / 2, y: heightPx - 40 } };

  const displayBins = projected.bins;

  // Fit the (synthetic or real) floor plan to screen width by default;
  // the ScrollView allows panning when zoomed in.
  const scale = Math.min(screen.width / widthPx, screen.height / heightPx);
  const renderWidth = widthPx * scale;
  const renderHeight = heightPx * scale;

  // Only route through bins that are mine AND not yet picked up. Already
  // picked-up bins still render in the map (green) but don't show in the
  // line — drawing them would imply the bidder still needs to walk there.
  const myUnpicked = displayBins.filter((b) => b.isMine && !b.pickedUp);
  const entry = projected.entry;
  // Walking order: nearest-neighbor heuristic from the entrance. For ~10
  // bins this is near-optimal and runs in microseconds. For large-scale
  // routes (50+) swap for a server-side optimizer later.
  const route = nearestNeighborRoute(entry, myUnpicked);
  const path = [entry, ...route.map((b) => ({ x: b.xPx, y: b.yPx }))];

  // In metric mode we render against a plain dark background (no floor
  // plan image), with a subtle 2m grid overlay. This is the auto-generated
  // map from the walk-and-scan positions; no operator-uploaded floor plan
  // is involved.
  const showFloorPlanImage = !useMetricCoords && floorPlanUrl;

  const binRadius = Math.max(8, widthPx / 100);

  // Focused bin: set when the bidder taps a landmark card or a route pill.
  // The bin pin draws a halo for ~1.5s so the eye can find it on the map.
  const [focusedBinId, setFocusedBinId] = useState<string | null>(null);
  const focusBin = useCallback((binId: string) => {
    setFocusedBinId(binId);
    // Clear after a beat — short enough that rapid taps re-fire the halo,
    // long enough to spot it on a busy floor plan.
    setTimeout(() => {
      setFocusedBinId((current) => (current === binId ? null : current));
    }, 1500);
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: '#0b0d12' }}>
      {/* Numbered route rail — only render when there are 2+ stops, since
          "Stop 1: A" alone is just visual noise. */}
      {route.length >= 2 && <RoutePillRail route={route} onPillPress={focusBin} />}
      <ScrollView
        style={{ flex: 1 }}
        maximumZoomScale={4}
        minimumZoomScale={0.8}
        contentContainerStyle={{ alignItems: 'center', justifyContent: 'center' }}
        horizontal={false}
      >
        <ScrollView
          horizontal
          maximumZoomScale={4}
          minimumZoomScale={0.8}
          contentContainerStyle={{ alignItems: 'center' }}
        >
          <View style={{ width: renderWidth, height: renderHeight }}>
          {/* SVG floor plans (sketch builder output) render via SvgUri.
              Raster floor plans (camera / photo import) render via the
              standard Image component. We branch on URL extension —
              the upload path always preserves it.
              2026-05-21: in metric mode (useMetricCoords) we skip the
              floor plan image entirely. The bins ARE the map. */}
          {showFloorPlanImage && (
            isSvgUrl(floorPlanUrl) ? (
              <SvgUri
                uri={floorPlanUrl}
                width={renderWidth}
                height={renderHeight}
                style={{ position: 'absolute' }}
                preserveAspectRatio="xMidYMid meet"
              />
            ) : (
              <Image
                source={{ uri: floorPlanUrl }}
                style={{ position: 'absolute', width: renderWidth, height: renderHeight }}
                resizeMode="contain"
              />
            )
          )}
          <Svg
            viewBox={`0 0 ${widthPx} ${heightPx}`}
            preserveAspectRatio="xMidYMid meet"
            width={renderWidth}
            height={renderHeight}
            style={{ position: 'absolute' }}
          >
            {/* Route line through the bidder's bins */}
            {path.length > 1 && (
              <G>
                {path.slice(0, -1).map((p, i) => {
                  const next = path[i + 1]!;
                  return (
                    <Line
                      key={`seg-${i}`}
                      x1={p.x}
                      y1={p.y}
                      x2={next.x}
                      y2={next.y}
                      stroke="#4f8cff"
                      strokeWidth={3}
                      strokeDasharray="8,6"
                      opacity={0.7}
                    />
                  );
                })}
              </G>
            )}

            {/* Entrance marker */}
            <G>
              <Circle cx={entry.x} cy={entry.y} r={binRadius * 0.7} fill="#ffb87a" stroke="#fff" strokeWidth={2} />
              <SvgText
                x={entry.x}
                y={entry.y + binRadius + 16}
                textAnchor="middle"
                fill="#ffb87a"
                fontSize={Math.max(10, widthPx / 130)}
                fontWeight="bold"
              >
                Entrance
              </SvgText>
            </G>

            {/* All bins — render from displayBins, which has had its
                xPx/yPx remapped from meters when in metric mode. */}
            {displayBins.map((b) => {
              const fill = b.pickedUp ? '#34d39a' : b.isMine ? '#4f8cff' : '#232839';
              const opacity = b.isMine ? 1 : 0.4;
              const isFocused = focusedBinId === b.binId;
              return (
                <G key={b.binId} opacity={opacity}>
                  {/* Focus halo — drawn behind the bin pin when the user
                      taps the corresponding landmark card or route pill. */}
                  {isFocused && (
                    <Circle
                      cx={b.xPx}
                      cy={b.yPx}
                      r={binRadius * 2.4}
                      fill="none"
                      stroke="#ffd166"
                      strokeWidth={4}
                      opacity={0.85}
                    />
                  )}
                  <Circle
                    cx={b.xPx}
                    cy={b.yPx}
                    r={binRadius}
                    fill={fill}
                    stroke={b.isMine ? '#fff' : 'transparent'}
                    strokeWidth={b.isMine ? 2 : 0}
                  />
                  {b.isMine && (
                    <SvgText
                      x={b.xPx}
                      y={b.yPx + binRadius + 14}
                      textAnchor="middle"
                      fill="#e8eaf0"
                      fontSize={Math.max(10, widthPx / 130)}
                    >
                      {b.code}
                    </SvgText>
                  )}
                </G>
              );
            })}
          </Svg>
          </View>
        </ScrollView>
        <Text style={{ color: '#8a93a6', fontSize: 12, padding: 12 }}>
          Pinch to zoom · {myUnpicked.length} bin{myUnpicked.length === 1 ? '' : 's'} remaining
        </Text>
        {/* Landmark rail — recognising the shelf from a photo beats
            decoding a code from a map. Only renders when at least one of
            the user's bins has a landmark photo. */}
        <BinLandmarkRail bins={displayBins.filter((b) => b.isMine)} onPress={focusBin} />
      </ScrollView>
    </View>
  );
}

function RoutePillRail({
  route,
  onPillPress,
}: {
  route: BinPin[];
  onPillPress: (binId: string) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ borderBottomWidth: 1, borderBottomColor: '#1a1e29' }}
      contentContainerStyle={{ paddingHorizontal: 10, paddingVertical: 10, gap: 8, alignItems: 'center' }}
    >
      {route.map((b, idx) => (
        <View key={b.binId} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Pressable
            onPress={() => onPillPress(b.binId)}
            style={{
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: 999,
              backgroundColor: b.pickedUp ? '#0e2a1c' : '#14213d',
              borderWidth: 1,
              borderColor: b.pickedUp ? '#34d39a' : '#4f8cff',
            }}
          >
            <Text style={{ color: '#e8eaf0', fontSize: 12, fontWeight: '700' }}>
              {b.pickedUp ? '✓ ' : ''}Stop {idx + 1}: {b.code}
            </Text>
            <Text style={{ color: '#8a93a6', fontSize: 10, marginTop: 1 }}>Aisle {b.aisle}</Text>
          </Pressable>
          {idx < route.length - 1 && <Text style={{ color: '#8a93a6', fontSize: 14 }}>→</Text>}
        </View>
      ))}
    </ScrollView>
  );
}

function BinLandmarkRail({
  bins,
  onPress,
}: {
  bins: BinPin[];
  onPress?: (binId: string) => void;
}) {
  const withPhotos = bins.filter((b) => b.landmarkPhotoUrl);
  if (withPhotos.length === 0) return null;
  return (
    <View
      style={{
        paddingVertical: 12,
        paddingHorizontal: 8,
        borderTopWidth: 1,
        borderTopColor: '#1a1e29',
      }}
    >
      <Text
        style={{
          color: '#8a93a6',
          fontSize: 11,
          fontWeight: '700',
          letterSpacing: 0.6,
          paddingHorizontal: 4,
          marginBottom: 8,
          textTransform: 'uppercase',
        }}
      >
        Look for these spots — tap to highlight on map
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, paddingHorizontal: 4 }}
      >
        {withPhotos.map((b) => (
          <Pressable
            key={b.binId}
            onPress={() => onPress?.(b.binId)}
            style={{
              width: 120,
              borderRadius: 10,
              backgroundColor: '#13161e',
              borderWidth: 1,
              borderColor: b.pickedUp ? '#22c55e' : '#2a3040',
              overflow: 'hidden',
              opacity: b.pickedUp ? 0.55 : 1,
            }}
          >
            <Image
              source={{ uri: b.landmarkPhotoUrl! }}
              style={{ width: '100%', height: 90, backgroundColor: '#1a1e29' }}
              resizeMode="cover"
            />
            <View style={{ padding: 8 }}>
              <Text
                style={{
                  color: b.pickedUp ? '#34d399' : '#22c55e',
                  fontFamily: 'monospace',
                  fontSize: 11,
                  fontWeight: '900',
                  letterSpacing: 0.4,
                }}
              >
                {b.code}
              </Text>
              <Text
                style={{
                  color: '#8a93a6',
                  fontSize: 10,
                  marginTop: 2,
                }}
                numberOfLines={1}
              >
                Aisle {b.aisle}
                {b.pickedUp ? ' · picked up' : ''}
              </Text>
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

function isSvgUrl(url: string): boolean {
  // Strip query string before extension check so cache-busters don't
  // confuse the matcher.
  const pathOnly = url.split('?')[0]?.toLowerCase() ?? '';
  return pathOnly.endsWith('.svg');
}

// Nearest-neighbor TSP heuristic. Greedy from the start point, always
// jumping to the unvisited bin closest by Euclidean distance. Result is
// typically within 25% of optimal and runs in O(n²) — fine for n ≤ 50.
function nearestNeighborRoute(
  start: { x: number; y: number },
  pins: BinPin[],
): BinPin[] {
  if (pins.length <= 1) return [...pins];
  const remaining = [...pins];
  const ordered: BinPin[] = [];
  let cursor = start;
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const p = remaining[i]!;
      const dx = p.xPx - cursor.x;
      const dy = p.yPx - cursor.y;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    const next = remaining.splice(bestIdx, 1)[0]!;
    ordered.push(next);
    cursor = { x: next.xPx, y: next.yPx };
  }
  return ordered;
}

// ─────────────────────────────────────────────────────────────────────
// 2026-05-21: Walk-mode metric coordinate projection.
//
// When the operator has walked the warehouse with ARKit on, some/all
// bins have coord_x_m / coord_y_m relative to the walk origin. This
// helper takes the bin list (some metric, some not) and projects
// everyone into a synthetic pixel space sized (widthPx, heightPx) so
// the existing render pipeline (SVG circles + route lines) works
// unchanged.
//
// Mixed warehouses (some bins ARKit-stamped, some pristine bulk-add):
//   - For ARKit bins, normalize by bounding box of all metric coords.
//   - For un-stamped bins, parse the bin code (e.g. "A-3-2") into
//     aisle / bay / level and place on an idealized grid.
//   - Both projections share the same pixel-space ranges so a mixed
//     map renders coherently (no scale jumps between adjacent bins).
//
// Pure warehouses (all bins ARKit OR no bins ARKit) work too —
// the helper just degenerates to one path or the other.
// ─────────────────────────────────────────────────────────────────────

type ProjectionResult = {
  bins: BinPin[];
  entry: { x: number; y: number };
};

function projectMetricBinsToPixelSpace(
  bins: BinPin[],
  widthPx: number,
  heightPx: number,
): ProjectionResult {
  const PADDING_PCT = 0.1;
  const arBins = bins.filter(
    (b) => typeof b.coordXm === 'number' && typeof b.coordYm === 'number',
  );

  // Compute metric bounding box (only from ARKit-stamped bins; un-stamped
  // bins live on a separate aisle/bay grid that gets normalized to the
  // same pixel range below).
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const b of arBins) {
    if (b.coordXm! < minX) minX = b.coordXm!;
    if (b.coordXm! > maxX) maxX = b.coordXm!;
    if (b.coordYm! < minY) minY = b.coordYm!;
    if (b.coordYm! > maxY) maxY = b.coordYm!;
  }
  if (arBins.length === 0) {
    // No ARKit bins at all — fall back to grid-only. Use a 10m × 10m
    // synthetic frame so the grid interpolation below still produces
    // reasonable spacing.
    minX = 0;
    maxX = 10;
    minY = 0;
    maxY = 10;
  } else if (arBins.length === 1) {
    // Single ARKit bin — give it some breathing room in pixel space.
    minX -= 2;
    maxX += 2;
    minY -= 2;
    maxY += 2;
  }

  const rangeX = Math.max(1, maxX - minX);
  const rangeY = Math.max(1, maxY - minY);
  const padX = widthPx * PADDING_PCT;
  const padY = heightPx * PADDING_PCT;
  const innerW = widthPx - 2 * padX;
  const innerH = heightPx - 2 * padY;

  function projectMetric(x: number, y: number): { x: number; y: number } {
    return {
      x: padX + ((x - minX) / rangeX) * innerW,
      // ARKit's z grows forward; treat that as "up" on the bidder map
      // (smaller pixel y = top of screen). Flip the axis so a bidder
      // facing the warehouse entrance reads the map as they'd walk it.
      y: padY + (1 - (y - minY) / rangeY) * innerH,
    };
  }

  // For non-ARKit bins, parse the code (e.g. "A-3-2") and place on an
  // idealized grid. The aisle ordering and bay/level numbering map to
  // metric-ish positions on the SAME bounding box used for ARKit bins,
  // so mixed renders stay coherent.
  function projectGrid(code: string): { x: number; y: number } {
    // Code format: "{Aisle letter}-{bay}-{level}" — e.g. "A-3-2".
    // Aisle letter → column index (A=0, B=1, ...)
    // Bay → row index
    // Level → tiebreaker (close levels stack tightly)
    const parts = code.split('-');
    const aisle = parts[0] ?? 'A';
    const bay = parseInt(parts[1] ?? '1', 10) || 1;
    const level = parseInt(parts[2] ?? '1', 10) || 1;
    const col = (aisle.toUpperCase().charCodeAt(0) - 65) * 2; // 2m per aisle
    const row = bay * 1.5; // 1.5m per bay
    const x = minX + col + level * 0.2;
    const y = minY + row;
    return projectMetric(x, y);
  }

  const projectedBins: BinPin[] = bins.map((b) => {
    if (typeof b.coordXm === 'number' && typeof b.coordYm === 'number') {
      const p = projectMetric(b.coordXm, b.coordYm);
      return { ...b, xPx: p.x, yPx: p.y };
    }
    const p = projectGrid(b.code);
    return { ...b, xPx: p.x, yPx: p.y };
  });

  // Entrance: use the centroid of ARKit bins projected to the bottom
  // edge of the inner pixel space, since the operator's walk origin is
  // typically near the entrance.
  const entry: { x: number; y: number } =
    arBins.length > 0
      ? { x: widthPx / 2, y: padY + innerH }
      : { x: widthPx / 2, y: heightPx - padY };

  return { bins: projectedBins, entry };
}
