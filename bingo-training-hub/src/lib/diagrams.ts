/* Line diagrams for the demo lessons, drawn like sheets on a drafting table:
   graph paper, ink line work, numbered callouts with leader lines, and a
   small legend. Returned as data: URIs so they behave like uploaded images. */

const INK = '#1b2440';
const NAVY = '#283f7d';
const COBALT = '#024cb8';
const STONE = '#d6cfc2';
const ORANGE = '#ec633d';

function sheet(title: string, body: string, legend: string[], w = 640, h = 440) {
  const grid = Array.from({ length: Math.ceil(w / 12) }, (_, i) => `<line x1="${i * 12}" y1="0" x2="${i * 12}" y2="${h}"/>`).join('') + Array.from({ length: Math.ceil(h / 12) }, (_, i) => `<line x1="0" y1="${i * 12}" x2="${w}" y2="${i * 12}"/>`).join('');
  const legendY = h - 22 - (Math.ceil(legend.length / 2) - 1) * 20;
  const leg = legend
    .map((l, i) => {
      const x = 36 + (i % 2) * ((w - 72) / 2);
      const y = legendY + Math.floor(i / 2) * 20;
      return `<g transform="translate(${x} ${y})"><rect x="0" y="-12" width="16" height="16" rx="1.5" fill="${NAVY}"/><text x="8" y="0.5" font-size="10" fill="#fff" text-anchor="middle" font-family="ui-monospace,Menlo,monospace">${i + 1}</text><text x="24" y="0" font-size="12" fill="${INK}" font-family="ui-monospace,Menlo,monospace">${l}</text></g>`;
    })
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" fill="#fdf8f0"/><g stroke="#ece3d1" stroke-width="1">${grid}</g>
<rect x="14" y="14" width="${w - 28}" height="${h - 28}" fill="none" stroke="${INK}" stroke-width="1.2"/>
<text x="32" y="44" font-size="16" fill="${INK}" font-family="ui-monospace,Menlo,monospace" letter-spacing="-0.3">${title}</text>
<line x1="32" y1="56" x2="${w - 32}" y2="56" stroke="${INK}" stroke-dasharray="2 3" stroke-opacity=".6"/>
${body}
<line x1="32" y1="${legendY - 26}" x2="${w - 32}" y2="${legendY - 26}" stroke="${INK}" stroke-dasharray="2 3" stroke-opacity=".6"/>
${leg}</svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

const callout = (n: number, x: number, y: number, tx: number, ty: number) =>
  `<line x1="${x}" y1="${y}" x2="${tx}" y2="${ty}" stroke="${INK}" stroke-width="1"/><circle cx="${x}" cy="${y}" r="3" fill="${INK}"/><rect x="${tx - 11}" y="${ty - 11}" width="22" height="22" rx="2" fill="${NAVY}"/><text x="${tx}" y="${ty + 4.5}" font-size="12" fill="#fff" text-anchor="middle" font-family="ui-monospace,Menlo,monospace">${n}</text>`;

/** Side view of a manual pallet jack. */
export function jackDiagram() {
  const s = `stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"`;
  const body = `
<g transform="translate(70 70)">
  <!-- forks -->
  <rect x="40" y="196" width="300" height="14" fill="${STONE}" ${s}/>
  <rect x="40" y="196" width="300" height="5" fill="#fff" fill-opacity=".5"/>
  <!-- load rollers -->
  <circle cx="62" cy="218" r="9" fill="${COBALT}" ${s}/><circle cx="96" cy="218" r="9" fill="${COBALT}" ${s}/>
  <!-- pump body -->
  <rect x="340" y="160" width="56" height="50" fill="${ORANGE}" ${s}/>
  <rect x="352" y="132" width="32" height="30" fill="${ORANGE}" ${s}/>
  <!-- steer wheel -->
  <circle cx="380" cy="222" r="17" fill="${INK}"/><circle cx="380" cy="222" r="6" fill="#fdf8f0"/>
  <!-- handle -->
  <path d="M368 132 L330 20" stroke="${INK}" stroke-width="9" stroke-linecap="round"/>
  <path d="M368 132 L330 20" stroke="${ORANGE}" stroke-width="5.5" stroke-linecap="round"/>
  <path d="M312 22 h40" stroke="${INK}" stroke-width="10" stroke-linecap="round"/>
  <!-- release lever -->
  <path d="M340 34 l-18 14" stroke="${COBALT}" stroke-width="4" stroke-linecap="round"/>
  <!-- floor -->
  <line x1="0" y1="241" x2="470" y2="241" stroke="${INK}" stroke-width="1.2"/>
  <g stroke="${INK}" stroke-opacity=".35">${Array.from({ length: 16 }, (_, i) => `<line x1="${i * 30}" y1="241" x2="${i * 30 - 10}" y2="251"/>`).join('')}</g>
  <!-- dimension: lift height -->
  <path d="M20 196 v-0 M20 210 v-14" stroke="${INK}"/>
  <text x="440" y="186" font-size="11" fill="${INK}" font-family="ui-monospace,Menlo,monospace">~1 in lift</text>
  <path d="M432 196 h-28 M432 210 h-28" stroke="${INK}" stroke-dasharray="2 2"/>
</g>
${callout(1, 250, 270, 250, 336)}
${callout(2, 132, 288, 132, 336)}
${callout(3, 400, 92, 470, 92)}
${callout(4, 395, 110, 470, 130)}`;
  return sheet('Pallet jack — pre-shift check', body, ['Forks straight, no cracks', 'Load rollers spin freely', 'Handle returns to neutral', 'Release lever lowers smoothly']);
}

/** Front elevation of a rack bay with heavy/light zones. */
export function rackDiagram() {
  const s = `stroke="${INK}" stroke-width="1.6"`;
  const levels = [300, 220, 140, 70];
  const body = `
<g transform="translate(90 0)">
  <rect x="0" y="66" width="12" height="244" fill="${STONE}" ${s}/>
  <rect x="300" y="66" width="12" height="244" fill="${STONE}" ${s}/>
  ${levels.slice(1).map((y) => `<rect x="0" y="${y}" width="312" height="8" fill="${ORANGE}" ${s}/>`).join('')}
  <!-- heavy zone (bottom two beams) -->
  <rect x="12" y="228" width="288" height="72" fill="${COBALT}" fill-opacity=".18"/>
  <rect x="12" y="148" width="288" height="72" fill="${COBALT}" fill-opacity=".1"/>
  <rect x="28" y="246" width="96" height="54" fill="#d9c6a0" ${s}/><rect x="136" y="258" width="74" height="42" fill="#d9c6a0" ${s}/><rect x="222" y="240" width="64" height="60" fill="#ccb68c" ${s}/>
  <rect x="34" y="176" width="70" height="44" fill="#d9c6a0" ${s}/><rect x="120" y="186" width="110" height="34" fill="#ccb68c" ${s}/>
  <rect x="40" y="110" width="40" height="30" fill="#ece6dc" ${s}/><rect x="96" y="116" width="54" height="24" fill="#ece6dc" ${s}/><rect x="226" y="104" width="60" height="36" fill="#ece6dc" ${s}/>
  <!-- overhang limit -->
  <path d="M286 104 h24" stroke="${ORANGE}" stroke-width="2" stroke-dasharray="3 2"/>
  <line x1="-20" y1="310" x2="340" y2="310" stroke="${INK}"/>
  <text x="352" y="276" font-size="11" fill="${COBALT}" font-family="ui-monospace,Menlo,monospace">HEAVY</text>
  <text x="352" y="128" font-size="11" fill="${INK}" font-family="ui-monospace,Menlo,monospace">LIGHT</text>
</g>
${callout(1, 220, 272, 520, 230)}
${callout(2, 392, 106, 520, 96)}
${callout(3, 160, 222, 520, 164)}`;
  return sheet('Rack loading — rule of thumb', body, ['Heavy low, light high', 'No overhang over 3 in', 'Report bent beams — do not load'], 640, 420);
}

/** A lot tag with its fields called out. */
export function lotTagDiagram() {
  const s = `stroke="${INK}" stroke-width="1.6"`;
  const body = `
<g transform="translate(150 78) rotate(-3)">
  <rect x="0" y="0" width="300" height="200" rx="4" fill="#fffdf6" ${s}/>
  <circle cx="24" cy="24" r="8" fill="#fdf8f0" ${s}/>
  <text x="48" y="32" font-size="13" fill="${INK}" font-family="ui-monospace,Menlo,monospace">BINGO AUCTIONS · LOT</text>
  <text x="48" y="86" font-size="44" fill="${INK}" font-family="ui-monospace,Menlo,monospace" font-weight="bold">04-218</text>
  <line x1="20" y1="104" x2="280" y2="104" stroke="${INK}" stroke-dasharray="3 3"/>
  <text x="20" y="130" font-size="12" fill="${INK}" font-family="ui-monospace,Menlo,monospace">PCS: 6    MISSING: 1 lid</text>
  <text x="20" y="156" font-size="12" fill="${INK}" font-family="ui-monospace,Menlo,monospace">TOTE: T-112</text>
  <rect x="200" y="140" width="80" height="44" fill="${COBALT}" fill-opacity=".12" ${s}/>
  <text x="240" y="167" font-size="11" fill="${COBALT}" text-anchor="middle" font-family="ui-monospace,Menlo,monospace">PHOTO ✓</text>
</g>
${callout(1, 300, 140, 520, 120)}
${callout(2, 214, 210, 120, 300)}
${callout(3, 274, 236, 330, 318)}
${callout(4, 400, 238, 520, 260)}`;
  return sheet('Lot tag — what goes where', body, ['Lot # on two sides', 'Piece count', 'Missing parts noted', 'Photo taken before it moves'], 640, 420);
}
