// WorkflowIcon — stroke-based SVG glyphs for the staff-home workflow
// cards (replaces the raw emoji 📦 ✅ 🗺️ 🔎 📍). Brand style: stroke
// ~1.75, round caps/joins, 24x24 viewBox, single color via the `color`
// prop so each card passes its own text/accent color.

import Svg, { Circle, Path } from 'react-native-svg';

export type WorkflowIconName =
  | 'putaway' // box + down arrow (receiving / put-away)
  | 'checkout' // check circle (check out / hand over)
  | 'layout' // folded map (warehouse layout)
  | 'lotting' // barcode scan (scan UPC → identify + price)
  | 'binlookup' // map pin (bin lookup)
  | 'feedback'; // speech bubble + spark (report a bug / suggest an idea)

function glyphFor(name: WorkflowIconName) {
  switch (name) {
    case 'putaway':
      return (
        <>
          <Path d="M12 2v8.5" />
          <Path d="m8.5 7.5 3.5 3.5 3.5-3.5" />
          <Path d="M21 12.5v4.5l-9 4.5-9-4.5v-4.5" />
          <Path d="m3 12.5 9 4.5 9-4.5" />
        </>
      );
    case 'checkout':
      return (
        <>
          <Circle cx="12" cy="12" r="9" />
          <Path d="m8 12.2 2.8 2.8L16 9.5" />
        </>
      );
    case 'layout':
      return (
        <>
          <Path d="M3 6.5 9 4l6 2.5L21 4v13.5L15 20l-6-2.5L3 20V6.5z" />
          <Path d="M9 4v13.5M15 6.5V20" />
        </>
      );
    case 'lotting':
      return (
        <>
          <Path d="M3 7V5a2 2 0 0 1 2-2h2" />
          <Path d="M17 3h2a2 2 0 0 1 2 2v2" />
          <Path d="M21 17v2a2 2 0 0 1-2 2h-2" />
          <Path d="M7 21H5a2 2 0 0 1-2-2v-2" />
          <Path d="M8 8.5v7M11.5 8.5v7M14.5 8.5v7M16.5 8.5v7" />
        </>
      );
    case 'binlookup':
      return (
        <>
          <Path d="M20 10.2c0 5.8-8 11.8-8 11.8s-8-6-8-11.8a8 8 0 0 1 16 0z" />
          <Circle cx="12" cy="10" r="3" />
        </>
      );
    // Speech bubble with a tail. Deliberately not an exclamation mark or a
    // bug glyph — the same entry point carries ideas, and an alarm icon would
    // read as "only report emergencies here".
    case 'feedback':
      return (
        <>
          <Path d="M20.5 12.5a7.5 7.5 0 0 1-7.5 7.5H8.2L4 22.5v-4.3a7.5 7.5 0 0 1-.5-2.7v-3a7.5 7.5 0 0 1 7.5-7.5h2a7.5 7.5 0 0 1 7.5 7.5v0z" />
          <Path d="M9 11.5h6M9 15h4" />
        </>
      );
  }
}

export function WorkflowIcon({
  name,
  size = 24,
  color,
}: {
  name: WorkflowIconName;
  size?: number;
  color: string;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {glyphFor(name)}
    </Svg>
  );
}
