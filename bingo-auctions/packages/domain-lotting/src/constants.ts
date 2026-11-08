// Categories + condition values — ported from the LotTR standalone app
// (src/constants.js). The auction-platform uses richer category and
// condition taxonomies in the database (see migration 0018), so these
// strings map across loosely. The classifier/AI layer outputs one of
// these values, then a thin adapter maps to the platform's category_id.

// Top-level categories used by:
//   - the AI VISION_PROMPT to constrain identification output
//   - the category chip selector in EditableCandidateCard
//   - the lots.category text column (free-form for forward compat,
//     constrained by normalizeIdentification to this list)
//
// Picked for the US liquidation / Amazon-returns market: each one
// names a category where at least a few hundred SKUs per truckload
// commonly appear. Operators reported (2026-05-13) that the prior
// 14-item list lumped too much into 'Other'. The extra 8 split out
// the largest liquidation buckets the AI was previously dumping
// into 'Other' or 'Home & Garden': Baby & Kids and Pet Supplies
// (massive Amazon-returns volume), Bath and Bedding & Linens
// (substantial home-goods sub-segments), Books & Media + Musical
// Instruments (easy to spot from the photo), Jewelry & Watches
// (high-value, deserves its own bucket), and Crafts & Hobbies
// (Cricut / sewing / art — Hobby Lobby pallets).
//
// Loose top-level grouping below is for human readability when
// editing the chip row; the AI receives them as a flat list.
export const CATEGORIES = [
  // Electronics + appliances
  'Electronics',
  'Appliances',
  // Home
  'Furniture',
  'Tools & Hardware',
  'Home & Garden',
  'Kitchen',
  'Bath',
  'Bedding & Linens',
  // People
  'Clothing',
  'Health & Beauty',
  'Jewelry & Watches',
  'Baby & Kids',
  // Recreation
  'Toys & Games',
  'Sporting Goods',
  'Musical Instruments',
  'Crafts & Hobbies',
  'Books & Media',
  // Vehicles + working
  'Automotive',
  'Office',
  // Specialty
  'Collectibles',
  'Pet Supplies',
  // Fallback
  'Other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CONDITIONS = [
  'New/Sealed',
  'New/Open Box',
  'Like New',
  'Very Good',
  'Good',
  'Fair',
  'Damaged/Parts',
] as const;
export type Condition = (typeof CONDITIONS)[number];

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

// ── Subcategory taxonomy (~110 leaf values) ─────────────────────────────────
//
// Designed against the actual taxonomies from competitor scrapes
// (research-competitor-categories.py): Nellis's 3-level tree + mac.bid's
// flat granular list. The goal is to keep operator reports from being
// half "Other" — Nellis showed that ~80% of their lots fall into ~30
// well-named buckets, so we mirror that shape.
//
// Storage shape:
//   lots.category    = parent (one of CATEGORIES)
//   lots.subcategory = leaf (one of SUBCATEGORIES_BY_PARENT[parent], or null)
//
// AI prompt strategy: the model picks `category` (constrained) and
// `subcategory` (constrained to that parent's subs). Mismatched pairs
// (subcategory not under the chosen parent) get normalized to null
// downstream rather than rejected, so the lot still gets its parent
// category even if the AI confused a sub.
export const SUBCATEGORIES_BY_PARENT: Record<string, readonly string[]> = {
  'Electronics': [
    'Computers, Laptops & Tablets',
    'Cell Phones & Accessories',
    'TVs & Home Theater',
    'Cameras & Photography',
    'Headphones & Speakers',
    'Wearables & Smart Home',
    'Printers & Office Electronics',
  ],
  'Appliances': [
    'Major (Refrigerators / Washers / Dryers / Stoves)',
    'Small Kitchen (Air Fryers / Blenders / Coffee)',
    'Vacuums & Floor Care',
    'Climate (Heaters / Fans / AC / Air Purifiers)',
  ],
  'Furniture': [
    'Living Room',
    'Bedroom',
    'Dining',
    'Office Furniture',
    'Outdoor & Patio Furniture',
  ],
  'Tools & Hardware': [
    'Power Tools',
    'Hand Tools',
    'Hardware & Fasteners',
    'Electrical',
    'Plumbing',
    'Safety & Workwear',
    'Lighting (Bulbs / Fixtures)',
  ],
  'Home & Garden': [
    'Home Decor',
    'Storage & Organization',
    'Lawn & Garden',
    'Pool & Spa',
    'Pest Control',
    'Cleaning Supplies',
    'Seasonal & Party Supplies',
  ],
  'Kitchen': [
    'Cookware & Bakeware',
    'Tableware & Drinkware',
    'Cutlery & Utensils',
    'Food Storage & Containers',
    'Pantry & Non-Perishable Food',
  ],
  'Bath': [
    'Bath Linens',
    'Vanities & Fixtures',
    'Shower Curtains & Mats',
    'Bath Decor',
  ],
  'Bedding & Linens': [
    'Sheets & Pillowcases',
    'Comforters & Blankets',
    'Pillows',
    'Curtains & Drapes',
    'Rugs',
  ],
  'Clothing': [
    "Women's Clothing",
    "Men's Clothing",
    "Kid's Clothing",
    'Shoes & Footwear',
    'Accessories (Bags / Belts / Hats)',
    'Costumes',
  ],
  'Health & Beauty': [
    'Hair Care',
    'Skin Care',
    'Makeup',
    'Personal Care (Deodorant / Oral)',
    'Vitamins & Supplements',
    'Medical Supplies & Equipment',
    'Fragrance',
  ],
  'Jewelry & Watches': [
    'Watches',
    'Fine Jewelry',
    'Costume Jewelry',
    'Engagement & Wedding',
  ],
  'Baby & Kids': [
    'Diapers & Wipes',
    'Nursing & Feeding',
    'Nursery',
    'Baby Gear (Strollers / Car Seats / Carriers)',
    'Baby Health & Safety',
    'Baby Toys',
  ],
  'Toys & Games': [
    'Action Figures & Dolls',
    'Building Sets (LEGO etc.)',
    'Board Games & Puzzles',
    'Outdoor Toys',
    'Educational Toys',
    'RC & Models',
  ],
  'Sporting Goods': [
    'Fitness Equipment',
    'Camping & Hiking',
    'Cycling',
    'Water Sports',
    'Hunting & Fishing',
    'Team Sports',
    'Winter Sports',
  ],
  'Musical Instruments': [
    'Guitars & Strings',
    'Keyboards & Pianos',
    'Drums & Percussion',
    'Pro Audio & DJ',
    'Brass & Woodwind',
  ],
  'Crafts & Hobbies': [
    'Sewing & Needlework',
    'Painting & Drawing',
    'Paper Crafts & Scrapbooking',
    'Beading & Jewelry Making',
    'Yarn & Knitting',
    'Cricut & Cutting Machines',
  ],
  'Books & Media': [
    'Books',
    'Movies (DVD / Blu-ray)',
    'Music (CD / Vinyl)',
    'Magazines',
  ],
  'Automotive': [
    'Auto Parts',
    'Auto Accessories',
    'Tools & Equipment',
    'Motorcycle & Powersports',
    'Tires & Wheels',
    'RV & Trailer',
  ],
  'Office': [
    'Office Supplies',
    'Office Furniture',
    'Office Electronics',
    'School Supplies',
  ],
  'Collectibles': [
    'Trading Cards',
    'Coins & Currency',
    'Memorabilia',
    'Vintage Items',
  ],
  'Pet Supplies': [
    'Dog',
    'Cat',
    'Fish & Aquatic',
    'Birds',
    'Small Animals (Rabbits / Guinea Pigs)',
    'Reptiles',
  ],
  'Other': [
    'Bulk & Mixed Lots',
    'Salvage / Parts Only',
    'Adult Items',
    'Perishable Food',
    'Misc',
  ],
} as const;

// Flat string union of every valid subcategory, used for type narrowing
// + the AI prompt enumeration. Includes empty string for "AI couldn't
// pick one" / operator hasn't set yet.
export type Subcategory =
  | ''
  | (typeof SUBCATEGORIES_BY_PARENT)[Category][number];

// Quick lookup: is this sub valid for the given parent? Used by
// normalizeIdentification to silently drop mismatches.
export function isValidSubcategory(
  parent: string,
  sub: string,
): boolean {
  const subs = SUBCATEGORIES_BY_PARENT[parent];
  if (!subs) return false;
  return (subs as readonly string[]).includes(sub);
}
