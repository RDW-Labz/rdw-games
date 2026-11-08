// normalize/brand.ts — static brand dictionary + title extraction.
//
// extractBrand(title) infers a brand from a free-text product title using a
// ~200-entry dictionary across 18 top-level category groups. No LLM calls —
// pure dictionary lookup + one lightweight heuristic fallback.
//
// Key design decisions:
//   1. Each dictionary entry carries a list of aliases (all lowercase). Aliases
//      are matched as whole words via word-boundary regex (\b) to avoid false
//      positives like "applesauce" → Apple or "saturn" → Saturn.
//   2. The working dictionary is sorted by alias length DESC before any
//      matching so "Black+Decker" wins over a bare "Black" match.
//   3. The regex is built at module load time (SORTED_DICTIONARY construction)
//      so per-row cost is just iterating pre-compiled RegExp objects.
//   4. When the dictionary misses, a lightweight heuristic tries to infer a
//      brand from a "ProperCase ProperCase MODEL#" title structure. It returns
//      null rather than guessing poorly — false positives are worse than nulls.
//
// DB mirror: extract_brand(text) in 0040_extract_brand.sql + brand_aliases
// table. Keep both in sync when adding new entries.

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Escape characters that are special in a RegExp pattern.
 * Used so alias strings like "Black+Decker" or "3M" are matched literally.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Dictionary ───────────────────────────────────────────────────────────────
//
// Canonical-capitalization canonical → one or more lowercase aliases.
// Add new brands here AND in the corresponding SQL migration (0040).

interface BrandEntry {
  canonical: string;
  aliases: string[];
}

const BRAND_DICTIONARY: BrandEntry[] = [
  // ── Tools & Hardware ───────────────────────────────────────────────────────
  { canonical: 'DeWalt',         aliases: ['dewalt', 'de walt', 'de-walt'] },
  { canonical: 'Milwaukee',      aliases: ['milwaukee', 'milwaukee tool'] },
  { canonical: 'Makita',         aliases: ['makita'] },
  { canonical: 'Bosch',          aliases: ['bosch'] },
  { canonical: 'Ryobi',          aliases: ['ryobi'] },
  { canonical: 'Craftsman',      aliases: ['craftsman'] },
  { canonical: 'Black+Decker',   aliases: ['black+decker', 'black & decker', 'black and decker', 'black decker', 'b&d'] },
  { canonical: 'RIDGID',         aliases: ['ridgid'] },
  { canonical: 'SKIL',           aliases: ['skil'] },
  { canonical: 'Husky',          aliases: ['husky'] },
  { canonical: 'Kobalt',         aliases: ['kobalt'] },
  { canonical: 'Porter-Cable',   aliases: ['porter-cable', 'porter cable', 'portercable'] },
  { canonical: 'Hilti',          aliases: ['hilti'] },
  { canonical: 'Stanley',        aliases: ['stanley'] },
  { canonical: 'Hart',           aliases: ['hart tools', 'hart'] },
  { canonical: 'Worx',           aliases: ['worx'] },
  { canonical: 'WEN',            aliases: ['wen'] },
  { canonical: 'Dremel',         aliases: ['dremel'] },
  { canonical: 'Irwin',          aliases: ['irwin', 'irwin tools'] },
  { canonical: 'Klein Tools',    aliases: ['klein tools', 'klein'] },
  { canonical: 'Channellock',    aliases: ['channellock'] },
  { canonical: 'Wera',           aliases: ['wera'] },
  { canonical: 'Fluke',          aliases: ['fluke'] },

  // ── Plumbing & Bath ────────────────────────────────────────────────────────
  { canonical: 'KOHLER',         aliases: ['kohler'] },
  { canonical: 'Moen',           aliases: ['moen'] },
  { canonical: 'Delta',          aliases: ['delta faucet', 'delta'] },
  { canonical: 'Pfister',        aliases: ['pfister'] },
  { canonical: 'American Standard', aliases: ['american standard'] },
  { canonical: 'Toto',           aliases: ['toto'] },
  { canonical: 'Glacier Bay',    aliases: ['glacier bay'] },
  { canonical: 'Symmons',        aliases: ['symmons'] },
  { canonical: 'Grohe',          aliases: ['grohe'] },
  { canonical: 'Hansgrohe',      aliases: ['hansgrohe'] },
  { canonical: 'Brizo',          aliases: ['brizo'] },

  // ── Lighting ──────────────────────────────────────────────────────────────
  { canonical: 'Progress Lighting', aliases: ['progress lighting', 'progress'] },
  { canonical: 'Hampton Bay',    aliases: ['hampton bay'] },
  { canonical: 'Generation Lighting', aliases: ['generation lighting', 'generation'] },
  { canonical: 'Hubbardton Forge', aliases: ['hubbardton forge'] },
  { canonical: 'Kichler',        aliases: ['kichler'] },
  { canonical: 'Hinkley',        aliases: ['hinkley'] },
  { canonical: 'Lithonia',       aliases: ['lithonia', 'lithonia lighting'] },
  { canonical: 'Cree',           aliases: ['cree'] },

  // ── Outdoor Power Equipment ────────────────────────────────────────────────
  { canonical: 'Toro',           aliases: ['toro'] },
  { canonical: 'Honda',          aliases: ['honda'] },
  { canonical: 'Husqvarna',      aliases: ['husqvarna'] },
  { canonical: 'EGO',            aliases: ['ego power+', 'ego'] },
  { canonical: 'Greenworks',     aliases: ['greenworks'] },
  { canonical: 'Cub Cadet',      aliases: ['cub cadet', 'cubcadet'] },
  { canonical: 'Stihl',          aliases: ['stihl'] },
  { canonical: 'Echo',           aliases: ['echo'] },
  { canonical: 'Ariens',         aliases: ['ariens'] },
  { canonical: 'Briggs & Stratton', aliases: ['briggs & stratton', 'briggs and stratton', 'briggs'] },
  { canonical: 'Sun Joe',        aliases: ['sun joe', 'sunjoe'] },
  { canonical: 'Snow Joe',       aliases: ['snow joe', 'snowjoe'] },

  // ── Kitchen Appliances & Cookware ──────────────────────────────────────────
  { canonical: 'Vitamix',        aliases: ['vitamix'] },
  { canonical: 'KitchenAid',     aliases: ['kitchenaid', 'kitchen aid'] },
  { canonical: 'Cuisinart',      aliases: ['cuisinart'] },
  { canonical: 'Ninja',          aliases: ['ninja'] },
  { canonical: 'Instant Pot',    aliases: ['instant pot', 'instantpot'] },
  { canonical: 'Keurig',         aliases: ['keurig'] },
  { canonical: 'Breville',       aliases: ['breville'] },
  { canonical: 'Hamilton Beach', aliases: ['hamilton beach', 'hamiltonbeach'] },
  { canonical: 'Oster',          aliases: ['oster'] },
  { canonical: 'Mr. Coffee',     aliases: ['mr. coffee', 'mr coffee', 'mrcoffee'] },
  { canonical: 'Pyrex',          aliases: ['pyrex'] },
  { canonical: 'Anchor Hocking', aliases: ['anchor hocking'] },
  { canonical: 'Lodge',          aliases: ['lodge'] },
  { canonical: 'All-Clad',       aliases: ['all-clad', 'all clad'] },
  { canonical: 'Calphalon',      aliases: ['calphalon'] },
  { canonical: 'Nespresso',      aliases: ['nespresso'] },
  { canonical: 'Nutribullet',    aliases: ['nutribullet', 'nutri bullet'] },
  { canonical: 'Magic Bullet',   aliases: ['magic bullet'] },
  { canonical: 'Shark',          aliases: ['shark'] },
  { canonical: 'iRobot',         aliases: ['irobot', 'i robot', 'roomba'] },

  // ── Major Appliances ──────────────────────────────────────────────────────
  { canonical: 'Whirlpool',      aliases: ['whirlpool'] },
  { canonical: 'GE',             aliases: ['ge appliances', 'ge profile', 'general electric', 'ge'] },
  { canonical: 'Maytag',         aliases: ['maytag'] },
  { canonical: 'LG',             aliases: ['lg'] },
  { canonical: 'Samsung',        aliases: ['samsung'] },
  { canonical: 'Frigidaire',     aliases: ['frigidaire'] },
  { canonical: 'Kenmore',        aliases: ['kenmore'] },
  { canonical: 'Electrolux',     aliases: ['electrolux'] },
  { canonical: 'Speed Queen',    aliases: ['speed queen'] },
  { canonical: 'Amana',          aliases: ['amana'] },
  { canonical: 'Miele',          aliases: ['miele'] },
  { canonical: 'Sub-Zero',       aliases: ['sub-zero', 'sub zero'] },

  // ── Electronics (Consumer) ─────────────────────────────────────────────────
  { canonical: 'Apple',          aliases: ['apple'] },
  { canonical: 'Sony',           aliases: ['sony'] },
  { canonical: 'Insignia',       aliases: ['insignia'] },
  { canonical: 'TCL',            aliases: ['tcl'] },
  { canonical: 'Hisense',        aliases: ['hisense'] },
  { canonical: 'Vizio',          aliases: ['vizio'] },
  { canonical: 'Roku',           aliases: ['roku'] },
  { canonical: 'Amazon',         aliases: ['amazon'] },
  { canonical: 'Microsoft',      aliases: ['microsoft'] },
  { canonical: 'Dell',           aliases: ['dell'] },
  { canonical: 'HP',             aliases: ['hp'] },
  { canonical: 'Lenovo',         aliases: ['lenovo'] },
  { canonical: 'Asus',           aliases: ['asus'] },
  { canonical: 'Acer',           aliases: ['acer'] },
  { canonical: 'Logitech',       aliases: ['logitech'] },
  { canonical: 'Bose',           aliases: ['bose'] },
  { canonical: 'JBL',            aliases: ['jbl'] },
  { canonical: 'Beats',          aliases: ['beats by dre', 'beats by dr. dre', 'beats'] },
  { canonical: 'Sonos',          aliases: ['sonos'] },
  { canonical: 'Anker',          aliases: ['anker'] },
  { canonical: 'Belkin',         aliases: ['belkin'] },
  { canonical: 'Razer',          aliases: ['razer'] },
  { canonical: 'Corsair',        aliases: ['corsair'] },
  { canonical: 'Fitbit',         aliases: ['fitbit'] },
  { canonical: 'Garmin',         aliases: ['garmin'] },
  { canonical: 'GoPro',          aliases: ['gopro', 'go pro'] },
  { canonical: 'Ring',           aliases: ['ring'] },
  { canonical: 'Nest',           aliases: ['nest'] },
  { canonical: 'Philips',        aliases: ['philips', 'philips hue'] },
  { canonical: 'Wyze',           aliases: ['wyze'] },
  { canonical: 'Arlo',           aliases: ['arlo'] },
  { canonical: 'Canon',          aliases: ['canon'] },
  { canonical: 'Nikon',          aliases: ['nikon'] },
  { canonical: 'Fujifilm',       aliases: ['fujifilm', 'fuji film', 'fuji'] },

  // ── Auto & Motorsports ─────────────────────────────────────────────────────
  { canonical: 'Mopar',          aliases: ['mopar'] },
  { canonical: 'ACDelco',        aliases: ['acdelco', 'ac delco', 'ac-delco'] },
  { canonical: 'Denso',          aliases: ['denso'] },
  { canonical: 'NGK',            aliases: ['ngk'] },
  { canonical: 'Mobil 1',        aliases: ['mobil 1', 'mobil1'] },
  { canonical: 'Castrol',        aliases: ['castrol'] },
  { canonical: 'Pennzoil',       aliases: ['pennzoil'] },
  { canonical: 'Valvoline',      aliases: ['valvoline'] },
  { canonical: 'Moog',           aliases: ['moog'] },
  { canonical: 'Monroe',         aliases: ['monroe'] },
  { canonical: 'Dorman',         aliases: ['dorman'] },
  { canonical: 'Optima',         aliases: ['optima batteries', 'optima'] },
  { canonical: 'Bosch',          aliases: ['bosch'] },   // also Tools — same canonical
  { canonical: 'WeatherTech',    aliases: ['weathertech', 'weather tech'] },
  { canonical: 'Husky',          aliases: ['husky'] },   // also Tools

  // ── Outdoor / Camping / BBQ ────────────────────────────────────────────────
  { canonical: 'Weber',          aliases: ['weber'] },
  { canonical: 'Traeger',        aliases: ['traeger'] },
  { canonical: 'Big Green Egg',  aliases: ['big green egg', 'bge'] },
  { canonical: 'YETI',           aliases: ['yeti'] },
  { canonical: 'Coleman',        aliases: ['coleman'] },
  { canonical: 'RTIC',           aliases: ['rtic'] },
  { canonical: 'Igloo',          aliases: ['igloo'] },
  { canonical: 'Ozark Trail',    aliases: ['ozark trail'] },
  { canonical: 'Camp Chef',      aliases: ['camp chef', 'campchef'] },
  { canonical: 'Blackstone',     aliases: ['blackstone'] },
  { canonical: 'Char-Broil',     aliases: ['char-broil', 'char broil', 'charbroil'] },
  { canonical: 'Pit Boss',       aliases: ['pit boss', 'pitboss'] },

  // ── Apparel & Footwear ─────────────────────────────────────────────────────
  { canonical: 'Nike',           aliases: ['nike'] },
  { canonical: 'Adidas',         aliases: ['adidas'] },
  { canonical: 'Under Armour',   aliases: ['under armour', 'under armor', 'ua'] },
  { canonical: "Levi's",         aliases: ["levi's", 'levis', "levi strauss"] },
  { canonical: 'Carhartt',       aliases: ['carhartt'] },
  { canonical: 'Columbia',       aliases: ['columbia'] },
  { canonical: 'Patagonia',      aliases: ['patagonia'] },
  { canonical: 'The North Face', aliases: ['the north face', 'north face', 'tnf'] },
  { canonical: 'Wrangler',       aliases: ['wrangler'] },
  { canonical: 'Dickies',        aliases: ['dickies'] },
  { canonical: 'Crocs',          aliases: ['crocs'] },
  { canonical: 'Skechers',       aliases: ['skechers'] },
  { canonical: 'Timberland',     aliases: ['timberland'] },
  { canonical: 'UGG',            aliases: ['ugg'] },
  { canonical: 'New Balance',    aliases: ['new balance'] },
  { canonical: 'Puma',           aliases: ['puma'] },
  { canonical: 'Champion',       aliases: ['champion'] },
  { canonical: 'Hanes',          aliases: ['hanes'] },

  // ── Beauty & Personal Care ─────────────────────────────────────────────────
  { canonical: 'Olay',           aliases: ['olay', 'oil of olay'] },
  { canonical: "L'Oréal",        aliases: ["l'oreal", 'loreal', "l'oréal"] },
  { canonical: 'Maybelline',     aliases: ['maybelline'] },
  { canonical: 'Revlon',         aliases: ['revlon'] },
  { canonical: 'Dove',           aliases: ['dove'] },
  { canonical: 'Pantene',        aliases: ['pantene'] },
  { canonical: 'CeraVe',         aliases: ['cerave'] },
  { canonical: 'Cetaphil',       aliases: ['cetaphil'] },
  { canonical: 'Neutrogena',     aliases: ['neutrogena'] },
  { canonical: 'Aveeno',         aliases: ['aveeno'] },
  { canonical: 'Conair',         aliases: ['conair'] },
  { canonical: 'Dyson',          aliases: ['dyson'] },
  { canonical: 'Remington',      aliases: ['remington'] },
  { canonical: 'BaByliss',       aliases: ['babyliss', 'babylisspro'] },
  { canonical: 'Chi',            aliases: ['chi'] },

  // ── Health & OTC ──────────────────────────────────────────────────────────
  { canonical: 'Tylenol',        aliases: ['tylenol'] },
  { canonical: 'Advil',          aliases: ['advil'] },
  { canonical: 'Aleve',          aliases: ['aleve'] },
  { canonical: 'Centrum',        aliases: ['centrum'] },
  { canonical: 'One A Day',      aliases: ['one a day', 'oneaday'] },
  { canonical: 'Pepto-Bismol',   aliases: ['pepto-bismol', 'pepto bismol', 'pepto'] },
  { canonical: 'Ibuprofen',      aliases: ['ibuprofen'] },
  { canonical: 'Omron',          aliases: ['omron'] },
  { canonical: 'Braun',          aliases: ['braun'] },
  { canonical: 'Philips',        aliases: ['philips'] },   // also Electronics

  // ── Toys & Games ──────────────────────────────────────────────────────────
  { canonical: 'LEGO',           aliases: ['lego'] },
  { canonical: 'Mattel',         aliases: ['mattel'] },
  { canonical: 'Hasbro',         aliases: ['hasbro'] },
  { canonical: 'Fisher-Price',   aliases: ['fisher-price', 'fisher price', 'fisherprice'] },
  { canonical: 'Hot Wheels',     aliases: ['hot wheels', 'hotwheels'] },
  { canonical: 'Barbie',         aliases: ['barbie'] },
  { canonical: 'Nerf',           aliases: ['nerf'] },
  { canonical: 'Play-Doh',       aliases: ['play-doh', 'play doh', 'playdoh'] },
  { canonical: 'Crayola',        aliases: ['crayola'] },
  { canonical: 'Melissa & Doug', aliases: ['melissa & doug', 'melissa and doug', 'melissa doug'] },
  { canonical: 'VTech',          aliases: ['vtech'] },
  { canonical: 'LeapFrog',       aliases: ['leapfrog'] },
  { canonical: 'Funko',          aliases: ['funko', 'funko pop'] },
  { canonical: 'Nintendo',       aliases: ['nintendo'] },
  { canonical: 'PlayStation',    aliases: ['playstation', 'ps5', 'ps4'] },
  { canonical: 'Xbox',           aliases: ['xbox'] },

  // ── Sports & Fitness ──────────────────────────────────────────────────────
  { canonical: 'Wilson',         aliases: ['wilson'] },
  { canonical: 'Spalding',       aliases: ['spalding'] },
  { canonical: 'Rawlings',       aliases: ['rawlings'] },
  { canonical: 'Bowflex',        aliases: ['bowflex'] },
  { canonical: 'NordicTrack',    aliases: ['nordictrack', 'nordic track'] },
  { canonical: 'Schwinn',        aliases: ['schwinn'] },
  { canonical: 'Trek',           aliases: ['trek'] },
  { canonical: 'Callaway',       aliases: ['callaway'] },
  { canonical: 'TaylorMade',     aliases: ['taylormade', 'taylor made'] },
  { canonical: 'Titleist',       aliases: ['titleist'] },
  { canonical: 'Peloton',        aliases: ['peloton'] },
  { canonical: 'Nautilus',       aliases: ['nautilus'] },
  { canonical: 'Life Fitness',   aliases: ['life fitness'] },

  // ── Baby & Kids ───────────────────────────────────────────────────────────
  { canonical: 'Graco',          aliases: ['graco'] },
  { canonical: 'Britax',         aliases: ['britax'] },
  { canonical: 'Pampers',        aliases: ['pampers'] },
  { canonical: 'Huggies',        aliases: ['huggies'] },
  { canonical: 'Gerber',         aliases: ['gerber'] },
  { canonical: 'Enfamil',        aliases: ['enfamil'] },
  { canonical: 'Similac',        aliases: ['similac'] },
  { canonical: 'Chicco',         aliases: ['chicco'] },
  { canonical: 'UPPAbaby',       aliases: ['uppababy', 'uppa baby'] },
  { canonical: 'BOB',            aliases: ['bob stroller', 'bob revolution'] },

  // ── Pet ───────────────────────────────────────────────────────────────────
  { canonical: 'Purina',         aliases: ['purina'] },
  { canonical: 'Pedigree',       aliases: ['pedigree'] },
  { canonical: 'KONG',           aliases: ['kong'] },
  { canonical: 'Petmate',        aliases: ['petmate'] },
  { canonical: 'IAMS',           aliases: ['iams'] },
  { canonical: 'Royal Canin',    aliases: ['royal canin'] },
  { canonical: 'Hill\'s Science Diet', aliases: ["hill's science diet", 'hills science diet'] },
  { canonical: 'Blue Buffalo',   aliases: ['blue buffalo'] },
  { canonical: 'PetSafe',        aliases: ['petsafe', 'pet safe'] },
  { canonical: 'Furminator',     aliases: ['furminator'] },

  // ── Office & Stationery ───────────────────────────────────────────────────
  { canonical: 'Brother',        aliases: ['brother'] },
  { canonical: 'Epson',          aliases: ['epson'] },
  { canonical: 'Sharpie',        aliases: ['sharpie'] },
  { canonical: 'BIC',            aliases: ['bic'] },
  { canonical: 'Pilot',          aliases: ['pilot'] },
  { canonical: 'Pentel',         aliases: ['pentel'] },
  { canonical: '3M',             aliases: ['3m'] },
  { canonical: 'Avery',          aliases: ['avery'] },
  { canonical: 'Scotch',         aliases: ['scotch'] },
  { canonical: 'Post-it',        aliases: ['post-it', 'post it', 'postit'] },
  { canonical: 'Swingline',      aliases: ['swingline'] },

  // ── Furniture & Home Décor ────────────────────────────────────────────────
  { canonical: 'Ashley',         aliases: ['ashley', 'ashley furniture'] },
  { canonical: 'La-Z-Boy',       aliases: ['la-z-boy', 'lazy boy', 'la z boy'] },
  { canonical: 'IKEA',           aliases: ['ikea'] },
  { canonical: 'West Elm',       aliases: ['west elm'] },
  { canonical: 'Pottery Barn',   aliases: ['pottery barn'] },
  { canonical: 'Serta',          aliases: ['serta'] },
  { canonical: 'Sealy',          aliases: ['sealy'] },
  { canonical: 'Tempur-Pedic',   aliases: ['tempur-pedic', 'tempurpedic', 'tempur pedic'] },
  { canonical: 'Purple',         aliases: ['purple mattress'] },
  { canonical: 'Simmons',        aliases: ['simmons beautyrest', 'simmons'] },
  { canonical: 'Zinus',          aliases: ['zinus'] },
  { canonical: 'Lifetime',       aliases: ['lifetime products', 'lifetime'] },
  { canonical: 'Rubbermaid',     aliases: ['rubbermaid'] },
  { canonical: 'Sterilite',      aliases: ['sterilite'] },
  { canonical: 'Keter',          aliases: ['keter'] },
];

// ── Pre-processed sorted dictionary ──────────────────────────────────────────
//
// Each alias is compiled into a { canonical, re } object. Sort longest alias
// first so "Black+Decker" beats "Black". Pre-compile the regex so construction
// cost is paid once at module load, not per row.

interface CompiledEntry {
  canonical: string;
  re: RegExp;
}

function buildSortedDictionary(entries: BrandEntry[]): CompiledEntry[] {
  const compiled: CompiledEntry[] = [];

  for (const entry of entries) {
    for (const alias of entry.aliases) {
      // \b word boundary is a zero-width assertion between a \w and a \W
      // character. It does NOT fire when the alias starts or ends with a
      // non-word character (e.g. "ego power+" ends with "+", "black+decker"
      // contains "+" mid-string). In those cases omit the boundary anchor so
      // the match still works; the escaped "+" already anchors the text.
      const escaped = escapeRegex(alias);
      const leadBoundary = /^\w/.test(alias) ? '\\b' : '';
      const trailBoundary = /\w$/.test(alias) ? '\\b' : '';
      compiled.push({
        canonical: entry.canonical,
        re: new RegExp(`${leadBoundary}${escaped}${trailBoundary}`, 'i'),
      });
    }
  }

  // Longest alias first (longest alias string → most specific match wins).
  compiled.sort((a, b) => {
    // Extract the alias string from the source (between \b and \b).
    const lenA = a.re.source.length;
    const lenB = b.re.source.length;
    return lenB - lenA;
  });

  return compiled;
}

const SORTED_DICTIONARY: CompiledEntry[] = buildSortedDictionary(BRAND_DICTIONARY);

// ── Heuristic fallback regex ──────────────────────────────────────────────────
//
// When the dictionary misses, try to detect a brand from a "ProperCase
// ProperCase MODEL#" pattern at the start of the title. Examples that hit:
//   "Weber Spirit II E-310 3-Burner ..."    → "Weber"
//   "Traeger Ironwood 885 Wood Pellet ..."   → "Traeger"
//   "NordicTrack T 6.5 Si Treadmill ..."     → "NordicTrack"
//
// The pattern requires:
//   - First token starts with an uppercase letter followed by at least one
//     lowercase letter (rules out all-caps abbreviations like "GE" or "TCL"
//     which are already in the dictionary).
//   - Second token either starts with uppercase+lowercase (two-word brand like
//     "Big Green") OR is a model-number-shaped string (uppercase letters/digits
//     and hyphens: E-310, T6.5, 885, DCD771C2).
//   - We capture only the first proper word as the candidate brand so we don't
//     return a two-word phrase that happens to be wrong.
//
// Conservative: returns null if the second token is a plain lowercase word,
// which usually means the first word is an adjective, not a brand.
//
// NOTE: The heuristic intentionally does NOT fire on single-word titles or on
// titles where the second token is all lowercase — false positives are more
// damaging than false negatives because they get stored in the DB.

const HEURISTIC_RE = /^([A-Z][a-z]+(?:[+\-][A-Za-z]+)?)\s+(?:[A-Z0-9][A-Za-z0-9+\-]*(?:\s|$)|[A-Z][a-z])/;

/**
 * Attempt to extract a brand name from a free-text product title.
 *
 * Strategy:
 *  1. Dictionary lookup (whole-word match, longest alias wins).
 *  2. Heuristic: "ProperCase" start + model-number-ish or ProperCase second
 *     token — returns captured first word only.
 *  3. null if neither fires.
 *
 * Result passes through normalizeBrand() before storage — callers should do
 * that step so sentinel stripping and whitespace trimming apply.
 */
export function extractBrand(title: string | null | undefined): string | null {
  if (!title) return null;

  // 1. Dictionary pass.
  for (const entry of SORTED_DICTIONARY) {
    if (entry.re.test(title)) return entry.canonical;
  }

  // 2. Heuristic fallback: ProperCase prefix before a model-number-ish token.
  const m = HEURISTIC_RE.exec(title);
  if (m) {
    const candidate = m[1];
    // Reject if the candidate is a common English word that appears in titles.
    if (candidate && !COMMON_WORDS.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  return null;
}

// Words that look ProperCase but are never brands — guards the heuristic from
// misfiring on adjectives / prepositions at the start of marketing copy.
const COMMON_WORDS = new Set([
  'new', 'used', 'open', 'box', 'sealed', 'set', 'pack', 'kit', 'bundle',
  'the', 'for', 'and', 'with', 'from', 'black', 'white', 'red', 'blue',
  'gray', 'grey', 'large', 'medium', 'small', 'extra', 'premium', 'deluxe',
  'ultra', 'pro', 'plus', 'max', 'mini', 'super', 'heavy', 'duty',
  'rechargeable', 'portable', 'wireless', 'cordless', 'electric',
  'digital', 'smart', 'automatic', 'manual', 'professional', 'commercial',
  'indoor', 'outdoor', 'original', 'genuine', 'replacement', 'compatible',
]);

// ── Alias → canonical reverse-lookup map ─────────────────────────────────────
// Built once at module load from BRAND_DICTIONARY. Keys are lowercased aliases.

const ALIAS_TO_CANONICAL: ReadonlyMap<string, string> = new Map(
  BRAND_DICTIONARY.flatMap((entry) =>
    entry.aliases.map((alias) => [alias.toLowerCase(), entry.canonical] as const),
  ),
);

/**
 * Normalize a user/scraper-supplied brand string to its canonical form.
 *
 * Strategy:
 *  1. Trim and strip null-sentinel values (empty, "N/A", "unknown", etc.).
 *  2. Compare the lowercased input against every alias in BRAND_DICTIONARY.
 *     An exact match returns the canonical display form.
 *  3. If no alias matches, return the trimmed input as-is (preserving the
 *     caller's casing) rather than null — the value is at least real data.
 *  4. Return null only when the input itself is null/empty/sentinel.
 *
 * This function normalizes brand fields that arrive from scrapers in forms
 * like "BLACK & DECKER", "dewalt", "DEWALT INC", and maps them to the
 * canonical display string. It does NOT do fuzzy / substring matching —
 * use extractBrand() on the product title for that.
 */
export function normalizeBrandFromInput(input: string | null | undefined): string | null {
  if (input == null) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Strip common null-sentinel values that scrapers emit.
  const lower = trimmed.toLowerCase();
  if (
    lower === 'null' ||
    lower === 'n/a' ||
    lower === 'na' ||
    lower === 'none' ||
    lower === 'unknown' ||
    lower === '-' ||
    lower === '--' ||
    lower === 'n.a.' ||
    lower === 'n.a' ||
    lower === 'not available' ||
    lower === 'not applicable'
  ) {
    return null;
  }

  // Exact alias match → canonical form.
  const canonical = ALIAS_TO_CANONICAL.get(lower);
  if (canonical !== undefined) return canonical;

  // No dictionary match — return the trimmed original value as-is.
  // This preserves data from sources with brands not yet in the dictionary
  // rather than silently discarding them.
  return trimmed;
}

// ── Dictionary invariant check ────────────────────────────────────────────────
//
// Exported so TypeScript evaluates this at module-load time during CI / tsc
// --noEmit runs. The assertion is cheap (O(n) over ~350 alias entries) and
// catches the most common dictionary authoring mistake: same alias appearing
// under two different canonical names (e.g. adding 'bosch' a second time
// pointing to 'Bosch Home' instead of 'Bosch').
//
// Usage: import { __test__BRAND_DICTIONARY_INVARIANTS } from './brand';
// The value is always true at runtime; the export exists for the side-effect.

export const __test__BRAND_DICTIONARY_INVARIANTS: true = (() => {
  const seen = new Map<string, string>(); // alias → canonical (first occurrence)

  for (const entry of BRAND_DICTIONARY) {
    for (const alias of entry.aliases) {
      const key = alias.toLowerCase();
      const existing = seen.get(key);
      if (existing === undefined) {
        seen.set(key, entry.canonical);
      } else if (existing !== entry.canonical) {
        // Two different canonicals claim the same alias — dictionary is corrupt.
        throw new Error(
          `BRAND_DICTIONARY invariant violation: alias "${alias}" maps to ` +
          `both "${existing}" and "${entry.canonical}". ` +
          `Remove the duplicate or unify the canonical names.`,
        );
      }
      // Same alias → same canonical is fine (e.g. 'bosch' in Tools and Auto).
    }
  }

  return true as const;
})();

/*
 * Expected extractBrand() behavior (spot-check — full test suite in __tests__/brand.test.ts):
 *
 *   extractBrand('DEWALT 20V Cordless Drill')              → 'DeWalt'
 *   extractBrand('Black & Decker 20V MAX Drill')           → 'Black+Decker'
 *   extractBrand('Roomba i3+ Self-Emptying Robot Vacuum')  → 'iRobot'
 *   extractBrand('Instant Pot Duo 7-in-1 Cooker')          → 'Instant Pot'
 *   extractBrand('The North Face Apex Jacket')             → 'The North Face'
 *   extractBrand('Organic applesauce 24 oz')               → null  (word-boundary guard)
 *   extractBrand(null)                                     → null
 *   extractBrand('')                                       → null
 *
 * Expected normalizeBrandFromInput() behavior:
 *
 *   normalizeBrandFromInput('BLACK & DECKER')              → 'Black+Decker'
 *   normalizeBrandFromInput('dewalt')                      → 'DeWalt'
 *   normalizeBrandFromInput('N/A')                         → null
 *   normalizeBrandFromInput('Acme Tools')                  → 'Acme Tools'  (not in dict, passthrough)
 *   normalizeBrandFromInput(null)                          → null
 */
