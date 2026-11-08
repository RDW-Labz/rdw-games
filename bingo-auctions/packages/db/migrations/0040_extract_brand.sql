-- ============================================================================
-- 0040_extract_brand — brand_aliases lookup table + extract_brand() function
--                      + enrich_brands_batch() backfill RPC.
--
-- Mirror of: packages/domain-lotting/src/normalize/brand.ts → extractBrand()
--
-- Design:
--   brand_aliases        — seed table (alias TEXT PK → canonical TEXT).
--                          Populated with the same ~200 entries as the TS
--                          dictionary. Longest-alias-first sort is achieved
--                          via the generated alias_length column + ORDER BY.
--
--   extract_brand(text)  — IMMUTABLE PARALLEL SAFE function. Uses a
--                          regex whole-word match (\m … \M) to avoid partial
--                          hits (e.g. "applesauce" matching "apple"). Returns
--                          the canonical brand string or NULL.
--
--   enrich_brands_batch  — SECURITY DEFINER RPC. Updates a single table's
--                          rows where brand IS NULL in configurable batches.
--                          The caller loops until 0 rows updated.
--
-- DO NOT apply this migration directly — the operator applies it after merge.
-- ============================================================================

-- ── brand_aliases table ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS brand_aliases (
  alias        TEXT    PRIMARY KEY,   -- lowercase normalized alias
  canonical    TEXT    NOT NULL,      -- display-case canonical brand name
  alias_length INT     GENERATED ALWAYS AS (length(alias)) STORED
);

CREATE INDEX IF NOT EXISTS brand_aliases_canonical_idx ON brand_aliases(canonical);

COMMENT ON TABLE brand_aliases IS
  'Brand alias → canonical brand name lookup. Mirror of BRAND_DICTIONARY in normalize/brand.ts. Keep both in sync.';

-- ── Seed data ─────────────────────────────────────────────────────────────────
-- Matches BRAND_DICTIONARY entries in packages/domain-lotting/src/normalize/brand.ts.
-- Where the same alias appears in multiple categories (e.g. "bosch" for both
-- Tools and Appliances) the canonical is identical so the ON CONFLICT is a no-op.

INSERT INTO brand_aliases (alias, canonical) VALUES
  -- Tools & Hardware
  ('dewalt',              'DeWalt'),
  ('de walt',             'DeWalt'),
  ('de-walt',             'DeWalt'),
  ('milwaukee',           'Milwaukee'),
  ('milwaukee tool',      'Milwaukee'),
  ('makita',              'Makita'),
  ('bosch',               'Bosch'),
  ('ryobi',               'Ryobi'),
  ('craftsman',           'Craftsman'),
  ('black+decker',        'Black+Decker'),
  ('black & decker',      'Black+Decker'),
  ('black and decker',    'Black+Decker'),
  ('black decker',        'Black+Decker'),
  ('b&d',                 'Black+Decker'),
  ('ridgid',              'RIDGID'),
  ('skil',                'SKIL'),
  ('husky',               'Husky'),
  ('kobalt',              'Kobalt'),
  ('porter-cable',        'Porter-Cable'),
  ('porter cable',        'Porter-Cable'),
  ('portercable',         'Porter-Cable'),
  ('hilti',               'Hilti'),
  ('stanley',             'Stanley'),
  ('hart tools',          'Hart'),
  ('hart',                'Hart'),
  ('worx',                'Worx'),
  ('wen',                 'WEN'),
  ('dremel',              'Dremel'),
  ('irwin',               'Irwin'),
  ('irwin tools',         'Irwin'),
  ('klein tools',         'Klein Tools'),
  ('klein',               'Klein Tools'),
  ('channellock',         'Channellock'),
  ('wera',                'Wera'),
  ('fluke',               'Fluke'),

  -- Plumbing & Bath
  ('kohler',              'KOHLER'),
  ('moen',                'Moen'),
  ('delta faucet',        'Delta'),
  ('delta',               'Delta'),
  ('pfister',             'Pfister'),
  ('american standard',   'American Standard'),
  ('toto',                'Toto'),
  ('glacier bay',         'Glacier Bay'),
  ('symmons',             'Symmons'),
  ('grohe',               'Grohe'),
  ('hansgrohe',           'Hansgrohe'),
  ('brizo',               'Brizo'),

  -- Lighting
  ('progress lighting',   'Progress Lighting'),
  ('progress',            'Progress Lighting'),
  ('hampton bay',         'Hampton Bay'),
  ('generation lighting', 'Generation Lighting'),
  ('generation',          'Generation Lighting'),
  ('hubbardton forge',    'Hubbardton Forge'),
  ('kichler',             'Kichler'),
  ('hinkley',             'Hinkley'),
  ('lithonia',            'Lithonia'),
  ('lithonia lighting',   'Lithonia'),
  ('cree',                'Cree'),

  -- Outdoor Power Equipment
  ('toro',                'Toro'),
  ('honda',               'Honda'),
  ('husqvarna',           'Husqvarna'),
  ('ego power+',          'EGO'),
  ('ego',                 'EGO'),
  ('greenworks',          'Greenworks'),
  ('cub cadet',           'Cub Cadet'),
  ('cubcadet',            'Cub Cadet'),
  ('stihl',               'Stihl'),
  ('echo',                'Echo'),
  ('ariens',              'Ariens'),
  ('briggs & stratton',   'Briggs & Stratton'),
  ('briggs and stratton', 'Briggs & Stratton'),
  ('briggs',              'Briggs & Stratton'),
  ('sun joe',             'Sun Joe'),
  ('sunjoe',              'Sun Joe'),
  ('snow joe',            'Snow Joe'),
  ('snowjoe',             'Snow Joe'),

  -- Kitchen Appliances & Cookware
  ('vitamix',             'Vitamix'),
  ('kitchenaid',          'KitchenAid'),
  ('kitchen aid',         'KitchenAid'),
  ('cuisinart',           'Cuisinart'),
  ('ninja',               'Ninja'),
  ('instant pot',         'Instant Pot'),
  ('instantpot',          'Instant Pot'),
  ('keurig',              'Keurig'),
  ('breville',            'Breville'),
  ('hamilton beach',      'Hamilton Beach'),
  ('hamiltonbeach',       'Hamilton Beach'),
  ('oster',               'Oster'),
  ('mr. coffee',          'Mr. Coffee'),
  ('mr coffee',           'Mr. Coffee'),
  ('mrcoffee',            'Mr. Coffee'),
  ('pyrex',               'Pyrex'),
  ('anchor hocking',      'Anchor Hocking'),
  ('lodge',               'Lodge'),
  ('all-clad',            'All-Clad'),
  ('all clad',            'All-Clad'),
  ('calphalon',           'Calphalon'),
  ('nespresso',           'Nespresso'),
  ('nutribullet',         'Nutribullet'),
  ('nutri bullet',        'Nutribullet'),
  ('magic bullet',        'Magic Bullet'),
  ('shark',               'Shark'),
  ('irobot',              'iRobot'),
  ('i robot',             'iRobot'),
  ('roomba',              'iRobot'),

  -- Major Appliances
  ('whirlpool',           'Whirlpool'),
  ('ge appliances',       'GE'),
  ('ge profile',          'GE'),
  ('general electric',    'GE'),
  ('ge',                  'GE'),
  ('maytag',              'Maytag'),
  ('lg',                  'LG'),
  ('samsung',             'Samsung'),
  ('frigidaire',          'Frigidaire'),
  ('kenmore',             'Kenmore'),
  ('electrolux',          'Electrolux'),
  ('speed queen',         'Speed Queen'),
  ('amana',               'Amana'),
  ('miele',               'Miele'),
  ('sub-zero',            'Sub-Zero'),
  ('sub zero',            'Sub-Zero'),

  -- Consumer Electronics
  ('apple',               'Apple'),
  ('sony',                'Sony'),
  ('insignia',            'Insignia'),
  ('tcl',                 'TCL'),
  ('hisense',             'Hisense'),
  ('vizio',               'Vizio'),
  ('roku',                'Roku'),
  ('amazon',              'Amazon'),
  ('microsoft',           'Microsoft'),
  ('dell',                'Dell'),
  ('hp',                  'HP'),
  ('lenovo',              'Lenovo'),
  ('asus',                'Asus'),
  ('acer',                'Acer'),
  ('logitech',            'Logitech'),
  ('bose',                'Bose'),
  ('jbl',                 'JBL'),
  ('beats by dre',        'Beats'),
  ('beats by dr. dre',    'Beats'),
  ('beats',               'Beats'),
  ('sonos',               'Sonos'),
  ('anker',               'Anker'),
  ('belkin',              'Belkin'),
  ('razer',               'Razer'),
  ('corsair',             'Corsair'),
  ('fitbit',              'Fitbit'),
  ('garmin',              'Garmin'),
  ('gopro',               'GoPro'),
  ('go pro',              'GoPro'),
  ('ring',                'Ring'),
  ('nest',                'Nest'),
  ('philips',             'Philips'),
  ('philips hue',         'Philips'),
  ('wyze',                'Wyze'),
  ('arlo',                'Arlo'),
  ('canon',               'Canon'),
  ('nikon',               'Nikon'),
  ('fujifilm',            'Fujifilm'),
  ('fuji film',           'Fujifilm'),
  ('fuji',                'Fujifilm'),

  -- Auto & Motorsports
  ('mopar',               'Mopar'),
  ('acdelco',             'ACDelco'),
  ('ac delco',            'ACDelco'),
  ('ac-delco',            'ACDelco'),
  ('denso',               'Denso'),
  ('ngk',                 'NGK'),
  ('mobil 1',             'Mobil 1'),
  ('mobil1',              'Mobil 1'),
  ('castrol',             'Castrol'),
  ('pennzoil',            'Pennzoil'),
  ('valvoline',           'Valvoline'),
  ('moog',                'Moog'),
  ('monroe',              'Monroe'),
  ('dorman',              'Dorman'),
  ('optima batteries',    'Optima'),
  ('optima',              'Optima'),
  ('weathertech',         'WeatherTech'),
  ('weather tech',        'WeatherTech'),

  -- Outdoor / Camping / BBQ
  ('weber',               'Weber'),
  ('traeger',             'Traeger'),
  ('big green egg',       'Big Green Egg'),
  ('bge',                 'Big Green Egg'),
  ('yeti',                'YETI'),
  ('coleman',             'Coleman'),
  ('rtic',                'RTIC'),
  ('igloo',               'Igloo'),
  ('ozark trail',         'Ozark Trail'),
  ('camp chef',           'Camp Chef'),
  ('campchef',            'Camp Chef'),
  ('blackstone',          'Blackstone'),
  ('char-broil',          'Char-Broil'),
  ('char broil',          'Char-Broil'),
  ('charbroil',           'Char-Broil'),
  ('pit boss',            'Pit Boss'),
  ('pitboss',             'Pit Boss'),

  -- Apparel & Footwear
  ('nike',                'Nike'),
  ('adidas',              'Adidas'),
  ('under armour',        'Under Armour'),
  ('under armor',         'Under Armour'),
  ('ua',                  'Under Armour'),
  ('levi''s',             'Levi''s'),
  ('levis',               'Levi''s'),
  ('levi strauss',        'Levi''s'),
  ('carhartt',            'Carhartt'),
  ('columbia',            'Columbia'),
  ('patagonia',           'Patagonia'),
  ('the north face',      'The North Face'),
  ('north face',          'The North Face'),
  ('tnf',                 'The North Face'),
  ('wrangler',            'Wrangler'),
  ('dickies',             'Dickies'),
  ('crocs',               'Crocs'),
  ('skechers',            'Skechers'),
  ('timberland',          'Timberland'),
  ('ugg',                 'UGG'),
  ('new balance',         'New Balance'),
  ('puma',                'Puma'),
  ('champion',            'Champion'),
  ('hanes',               'Hanes'),

  -- Beauty & Personal Care
  ('olay',                'Olay'),
  ('oil of olay',         'Olay'),
  ('l''oreal',            'L''Oréal'),
  ('loreal',              'L''Oréal'),
  ('l''oréal',            'L''Oréal'),
  ('maybelline',          'Maybelline'),
  ('revlon',              'Revlon'),
  ('dove',                'Dove'),
  ('pantene',             'Pantene'),
  ('cerave',              'CeraVe'),
  ('cetaphil',            'Cetaphil'),
  ('neutrogena',          'Neutrogena'),
  ('aveeno',              'Aveeno'),
  ('conair',              'Conair'),
  ('dyson',               'Dyson'),
  ('remington',           'Remington'),
  ('babyliss',            'BaByliss'),
  ('babylisspro',         'BaByliss'),
  ('chi',                 'Chi'),

  -- Health & OTC
  ('tylenol',             'Tylenol'),
  ('advil',               'Advil'),
  ('aleve',               'Aleve'),
  ('centrum',             'Centrum'),
  ('one a day',           'One A Day'),
  ('oneaday',             'One A Day'),
  ('pepto-bismol',        'Pepto-Bismol'),
  ('pepto bismol',        'Pepto-Bismol'),
  ('pepto',               'Pepto-Bismol'),
  ('ibuprofen',           'Ibuprofen'),
  ('omron',               'Omron'),
  ('braun',               'Braun'),

  -- Toys & Games
  ('lego',                'LEGO'),
  ('mattel',              'Mattel'),
  ('hasbro',              'Hasbro'),
  ('fisher-price',        'Fisher-Price'),
  ('fisher price',        'Fisher-Price'),
  ('fisherprice',         'Fisher-Price'),
  ('hot wheels',          'Hot Wheels'),
  ('hotwheels',           'Hot Wheels'),
  ('barbie',              'Barbie'),
  ('nerf',                'Nerf'),
  ('play-doh',            'Play-Doh'),
  ('play doh',            'Play-Doh'),
  ('playdoh',             'Play-Doh'),
  ('crayola',             'Crayola'),
  ('melissa & doug',      'Melissa & Doug'),
  ('melissa and doug',    'Melissa & Doug'),
  ('melissa doug',        'Melissa & Doug'),
  ('vtech',               'VTech'),
  ('leapfrog',            'LeapFrog'),
  ('funko',               'Funko'),
  ('funko pop',           'Funko'),
  ('nintendo',            'Nintendo'),
  ('playstation',         'PlayStation'),
  ('ps5',                 'PlayStation'),
  ('ps4',                 'PlayStation'),
  ('xbox',                'Xbox'),

  -- Sports & Fitness
  ('wilson',              'Wilson'),
  ('spalding',            'Spalding'),
  ('rawlings',            'Rawlings'),
  ('bowflex',             'Bowflex'),
  ('nordictrack',         'NordicTrack'),
  ('nordic track',        'NordicTrack'),
  ('schwinn',             'Schwinn'),
  ('trek',                'Trek'),
  ('callaway',            'Callaway'),
  ('taylormade',          'TaylorMade'),
  ('taylor made',         'TaylorMade'),
  ('titleist',            'Titleist'),
  ('peloton',             'Peloton'),
  ('nautilus',            'Nautilus'),
  ('life fitness',        'Life Fitness'),

  -- Baby & Kids
  ('graco',               'Graco'),
  ('britax',              'Britax'),
  ('pampers',             'Pampers'),
  ('huggies',             'Huggies'),
  ('gerber',              'Gerber'),
  ('enfamil',             'Enfamil'),
  ('similac',             'Similac'),
  ('chicco',              'Chicco'),
  ('uppababy',            'UPPAbaby'),
  ('uppa baby',           'UPPAbaby'),
  ('bob stroller',        'BOB'),
  ('bob revolution',      'BOB'),

  -- Pet
  ('purina',              'Purina'),
  ('pedigree',            'Pedigree'),
  ('kong',                'KONG'),
  ('petmate',             'Petmate'),
  ('iams',                'IAMS'),
  ('royal canin',         'Royal Canin'),
  ('hill''s science diet','Hill''s Science Diet'),
  ('hills science diet',  'Hill''s Science Diet'),
  ('blue buffalo',        'Blue Buffalo'),
  ('petsafe',             'PetSafe'),
  ('pet safe',            'PetSafe'),
  ('furminator',          'Furminator'),

  -- Office & Stationery
  ('brother',             'Brother'),
  ('epson',               'Epson'),
  ('sharpie',             'Sharpie'),
  ('bic',                 'BIC'),
  ('pilot',               'Pilot'),
  ('pentel',              'Pentel'),
  ('3m',                  '3M'),
  ('avery',               'Avery'),
  ('scotch',              'Scotch'),
  ('post-it',             'Post-it'),
  ('post it',             'Post-it'),
  ('postit',              'Post-it'),
  ('swingline',           'Swingline'),

  -- Furniture & Home Décor
  ('ashley',              'Ashley'),
  ('ashley furniture',    'Ashley'),
  ('la-z-boy',            'La-Z-Boy'),
  ('lazy boy',            'La-Z-Boy'),
  ('la z boy',            'La-Z-Boy'),
  ('ikea',                'IKEA'),
  ('west elm',            'West Elm'),
  ('pottery barn',        'Pottery Barn'),
  ('serta',               'Serta'),
  ('sealy',               'Sealy'),
  ('tempur-pedic',        'Tempur-Pedic'),
  ('tempurpedic',         'Tempur-Pedic'),
  ('tempur pedic',        'Tempur-Pedic'),
  ('purple mattress',     'Purple'),
  ('simmons beautyrest',  'Simmons'),
  ('simmons',             'Simmons'),
  ('zinus',               'Zinus'),
  ('lifetime products',   'Lifetime'),
  ('lifetime',            'Lifetime'),
  ('rubbermaid',          'Rubbermaid'),
  ('sterilite',           'Sterilite'),
  ('keter',               'Keter')

ON CONFLICT (alias) DO UPDATE SET canonical = EXCLUDED.canonical;

-- ── extract_brand(text) ───────────────────────────────────────────────────────
-- Returns the canonical brand name by whole-word matching against brand_aliases,
-- ordered by alias length DESC so multi-word aliases win over shorter ones.
-- IMMUTABLE + PARALLEL SAFE — safe for use in index expressions if desired.
--
-- Postgres word-boundary metacharacters:
--   \m  = start of word   (equivalent to JS \b before a word char)
--   \M  = end of word     (equivalent to JS \b after a word char)
--
-- Special regex characters in aliases (e.g. "+", ".") are escaped via
-- regexp_replace before embedding in the pattern.

CREATE OR REPLACE FUNCTION extract_brand(p_title TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_lower  TEXT;
  v_brand  TEXT;
  v_alias  TEXT;
  v_pat    TEXT;
BEGIN
  IF p_title IS NULL OR length(trim(p_title)) = 0 THEN
    RETURN NULL;
  END IF;

  v_lower := lower(p_title);

  -- Match longest alias first (alias_length DESC) so "black & decker" beats
  -- "black". Use Postgres \m / \M word-boundary markers and case-insensitive
  -- operator ~* for the regex test.
  SELECT ba.canonical INTO v_brand
  FROM   brand_aliases ba
  WHERE  v_lower ~* (
           '\m' ||
           regexp_replace(ba.alias, '([+.()\\\[\]{}|^$])', '\\\1', 'g') ||
           '\M'
         )
  ORDER BY ba.alias_length DESC
  LIMIT 1;

  RETURN v_brand;  -- NULL when no alias matched
END;
$$;

COMMENT ON FUNCTION extract_brand(TEXT) IS
  'Dictionary-based brand extraction from a free-text product title. Whole-word match, longest alias first. Mirror of normalize/brand.ts extractBrand(). NULL when no brand recognized.';

-- ── enrich_brands_batch(table_name, batch_size) ──────────────────────────────
-- Backfill RPC. Updates up to p_batch_size rows where brand IS NULL.
-- Returns the number of rows updated. Caller loops until 0 is returned.
--
-- Supported tables: competitor_lots, import_rows, lots, product_lookups.
-- All other values raise an exception (allowlist guards against SQL injection).
--
-- competitor_lots uses a composite PK (source, source_id) — handled via a CTE
-- that captures the ctid for the target rows before updating.
--
-- SECURITY DEFINER + explicit allowlist: safe to expose to service_role only.

CREATE OR REPLACE FUNCTION enrich_brands_batch(
  p_table     TEXT,
  p_batch_size INT DEFAULT 5000
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INT;
BEGIN
  -- Allowlist guard — prevents arbitrary SQL injection via the table name.
  IF p_table NOT IN ('competitor_lots', 'import_rows', 'lots', 'product_lookups') THEN
    RAISE EXCEPTION 'enrich_brands_batch: unsupported table "%". '
      'Allowed: competitor_lots, import_rows, lots, product_lookups.', p_table;
  END IF;

  IF p_table = 'competitor_lots' THEN
    -- competitor_lots has a composite PK (source, source_id) — no integer id.
    -- Use a CTE to lock candidate rows via ctid then update them.
    WITH candidates AS (
      SELECT ctid
      FROM   competitor_lots
      WHERE  brand IS NULL
        AND  title IS NOT NULL
      LIMIT  p_batch_size
      FOR UPDATE SKIP LOCKED
    )
    UPDATE competitor_lots cl
    SET    brand = extract_brand(cl.title)
    FROM   candidates c
    WHERE  cl.ctid = c.ctid
      AND  extract_brand(cl.title) IS NOT NULL;

  ELSIF p_table = 'import_rows' THEN
    WITH candidates AS (
      SELECT id
      FROM   import_rows
      WHERE  brand IS NULL
        AND  title IS NOT NULL
      LIMIT  p_batch_size
      FOR UPDATE SKIP LOCKED
    )
    UPDATE import_rows ir
    SET    brand = extract_brand(ir.title)
    FROM   candidates c
    WHERE  ir.id = c.id
      AND  extract_brand(ir.title) IS NOT NULL;

  ELSIF p_table = 'lots' THEN
    WITH candidates AS (
      SELECT id
      FROM   lots
      WHERE  brand IS NULL
        AND  title IS NOT NULL
      LIMIT  p_batch_size
      FOR UPDATE SKIP LOCKED
    )
    UPDATE lots l
    SET    brand = extract_brand(l.title)
    FROM   candidates c
    WHERE  l.id = c.id
      AND  extract_brand(l.title) IS NOT NULL;

  ELSIF p_table = 'product_lookups' THEN
    WITH candidates AS (
      SELECT upc
      FROM   product_lookups
      WHERE  brand IS NULL
        AND  title IS NOT NULL
      LIMIT  p_batch_size
      FOR UPDATE SKIP LOCKED
    )
    UPDATE product_lookups pl
    SET    brand = extract_brand(pl.title)
    FROM   candidates c
    WHERE  pl.upc = c.upc
      AND  extract_brand(pl.title) IS NOT NULL;

  END IF;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION enrich_brands_batch(TEXT, INT) IS
  'Backfill RPC: sets brand = extract_brand(title) for up to p_batch_size rows where brand IS NULL. Loop until 0 returned. Service-role only.';

-- ── Permissions ───────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION extract_brand(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION extract_brand(TEXT) TO service_role;
-- Also grant to authenticated so operator-web server actions can call it
-- when wiring it into SELECT queries on the fly.
GRANT  EXECUTE ON FUNCTION extract_brand(TEXT) TO authenticated;

REVOKE ALL ON FUNCTION enrich_brands_batch(TEXT, INT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION enrich_brands_batch(TEXT, INT) TO service_role;

-- brand_aliases is reference data — read-only for authenticated, no writes.
REVOKE ALL ON TABLE brand_aliases FROM PUBLIC;
GRANT  SELECT ON TABLE brand_aliases TO service_role, authenticated;

-- ── Self-mark ─────────────────────────────────────────────────────────────────

INSERT INTO _schema_migrations (filename, applied_by)
VALUES ('0040_extract_brand.sql', 'manual')
ON CONFLICT (filename) DO NOTHING;
