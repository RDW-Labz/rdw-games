// __tests__/brand.test.ts
//
// Vitest tests for extractBrand(). Run via:
//
//   npm test --workspace=@auction-platform/domain-lotting
//
// Originally written with a hand-rolled assertion helper before Vitest was
// wired into the package; converted to describe/it/expect when the runner
// was added.

import { describe, it, expect } from 'vitest';

import { extractBrand } from '../brand';

describe('extractBrand — Tools & Hardware dictionary hits', () => {
  it('DeWalt (exact canonical capitalization)', () => {
    expect(extractBrand('DEWALT 20-Volt Max 1/2-in Brushless Cordless Drill')).toBe('DeWalt');
  });

  it('DeWalt alias "de walt" (space variant)', () => {
    expect(extractBrand('De Walt 12V Compact Drill Driver')).toBe('DeWalt');
  });

  it('Milwaukee (standard)', () => {
    expect(extractBrand('Milwaukee M18 FUEL 1/2 in. Hammer Drill/Driver')).toBe('Milwaukee');
  });

  it('Makita', () => {
    expect(
      extractBrand('Makita XPH07Z 18V LXT Lithium-Ion Brushless Cordless 1/2" Hammer Drill'),
    ).toBe('Makita');
  });

  it('Ryobi', () => {
    expect(extractBrand('Ryobi PCL525B2 18V ONE+ 2-Tool Combo Kit')).toBe('Ryobi');
  });
});

describe('extractBrand — longest-alias-wins', () => {
  it('Black+Decker — multi-word alias beats bare "black"', () => {
    expect(extractBrand('Black & Decker 20V MAX Cordless Drill')).toBe('Black+Decker');
  });

  it('Black+Decker alias "black+decker"', () => {
    expect(extractBrand('Black+Decker BDCDD12C drill')).toBe('Black+Decker');
  });

  it('The North Face — "the north face" beats "north face"', () => {
    expect(extractBrand("The North Face Men's Apex Bionic Jacket")).toBe('The North Face');
  });

  it('Instant Pot — two-word alias', () => {
    expect(extractBrand('Instant Pot Duo 7-in-1 Electric Pressure Cooker')).toBe('Instant Pot');
  });
});

describe('extractBrand — cross-category dictionary hits', () => {
  it('Plumbing — Moen', () => {
    expect(extractBrand('Moen Adler 84603SRS 2-Handle Widespread Bathroom Faucet')).toBe('Moen');
  });

  it('Plumbing — KOHLER', () => {
    expect(extractBrand('KOHLER Elmbrook Elongated 1.28 gpf Toilet')).toBe('KOHLER');
  });

  it('Outdoor BBQ — Weber', () => {
    expect(extractBrand('Weber Spirit II E-310 3-Burner Liquid Propane Gas Grill')).toBe('Weber');
  });

  it('Kitchen — Vitamix', () => {
    expect(extractBrand('Vitamix 5200 Blender, Professional-Grade')).toBe('Vitamix');
  });

  it('Electronics — Sony', () => {
    expect(extractBrand('Sony WH-1000XM4 Wireless Noise Cancelling Headphones')).toBe('Sony');
  });

  it('Electronics — LG', () => {
    expect(extractBrand('LG OLED65C3PUA 65-inch OLED evo C3 4K Smart TV')).toBe('LG');
  });

  it('Toys — LEGO', () => {
    expect(extractBrand('LEGO Technic Land Rover Defender 42110')).toBe('LEGO');
  });

  it('Baby — Graco', () => {
    expect(extractBrand('Graco Modes Element Travel System - Binx')).toBe('Graco');
  });

  it('Pet — Purina', () => {
    expect(extractBrand('Purina Pro Plan Adult Dry Dog Food Chicken & Rice')).toBe('Purina');
  });

  it('Auto — Castrol', () => {
    expect(extractBrand('Castrol GTX 5W-30 Full Synthetic Motor Oil')).toBe('Castrol');
  });

  it('Apparel — Carhartt', () => {
    expect(
      extractBrand("Carhartt Men's Loose Fit Heavyweight Short-Sleeve Pocket T-Shirt"),
    ).toBe('Carhartt');
  });

  it('Beauty — CeraVe', () => {
    expect(extractBrand('CeraVe Moisturizing Cream 16 oz')).toBe('CeraVe');
  });
});

describe('extractBrand — case-insensitive matching', () => {
  it('all-lowercase title still matches', () => {
    expect(extractBrand('dewalt atomic 20v max cordless drill')).toBe('DeWalt');
  });

  it('ALL-CAPS title still matches', () => {
    expect(extractBrand('MILWAUKEE M18 HAMMER DRILL')).toBe('Milwaukee');
  });

  it('mixed case variation', () => {
    expect(extractBrand('Keurig K-Classic Coffee Maker K-Cup Pod')).toBe('Keurig');
  });
});

describe('extractBrand — word-boundary guard (no false positives)', () => {
  it('"applesauce" must NOT match Apple', () => {
    expect(extractBrand('Organic applesauce unsweetened 24 oz')).toBeNull();
  });

  it('"saturnalia" must NOT match Saturn (not in dict — boundary test for heuristic)', () => {
    expect(extractBrand('Saturnalia holiday decoration set')).toBeNull();
  });

  it('"breville-like" substring — breville should still match as own word', () => {
    expect(extractBrand('Breville Barista Express Espresso Machine')).toBe('Breville');
  });

  it('"Roomba" alias maps to iRobot canonical', () => {
    expect(extractBrand('Roomba i3+ EVO (3550) Self-Emptying Robot Vacuum')).toBe('iRobot');
  });
});

describe('extractBrand — aliases ending/starting with non-word chars (+ boundary fix)', () => {
  it('ego power+ leaf blower matches EGO canonical', () => {
    // "ego power+" ends with "+" which \b does not anchor — the regex must
    // omit the trailing \b for this alias.
    expect(extractBrand('ego power+ leaf blower 56V')).toBe('EGO');
  });

  it('black+decker drill matches Black+Decker canonical', () => {
    // "black+decker" contains "+" — the escaped pattern must still match
    // without relying on \b at either end of the alias.
    expect(extractBrand('black+decker drill 20V MAX')).toBe('Black+Decker');
  });

  it('EGO alias without "power+" suffix still matches', () => {
    // Bare "ego" alias (ends in word char) should still match normally.
    expect(extractBrand('EGO 56V Cordless Chainsaw')).toBe('EGO');
  });
});

describe('extractBrand — alias normalization', () => {
  it('TNF alias → The North Face', () => {
    expect(extractBrand("TNF Fleece Jacket Women's Medium")).toBe('The North Face');
  });

  it('BGE alias → Big Green Egg', () => {
    expect(extractBrand('BGE Large Ceramic Kamado Grill')).toBe('Big Green Egg');
  });

  it('ps5 alias → PlayStation', () => {
    expect(extractBrand('PS5 Console Digital Edition')).toBe('PlayStation');
  });
});

describe('extractBrand — heuristic fallback', () => {
  it('Unknown brand: ProperCase + model number fires heuristic', () => {
    // Fiskars starts with uppercase F, followed by "36-inch" which matches
    // the heuristic's second-token pattern (starts with digit/uppercase).
    // NOTE: "Fiskars" is not in the dictionary so the heuristic should fire.
    expect(extractBrand('Fiskars 36-inch Bypass Lopper — this brand NOT in dict')).toBe(
      'Fiskars',
    );
  });
});

describe('extractBrand — null / empty inputs', () => {
  it('null input → null', () => {
    expect(extractBrand(null)).toBeNull();
  });

  it('undefined input → null', () => {
    expect(extractBrand(undefined)).toBeNull();
  });

  it('empty string → null', () => {
    expect(extractBrand('')).toBeNull();
  });

  it('whitespace only → null', () => {
    expect(extractBrand('   ')).toBeNull();
  });
});

describe('extractBrand — fixture-based regression', () => {
  it("fix-001 Lowe's DEWALT drill title", () => {
    expect(
      extractBrand(
        'DEWALT 20-Volt Max 1/2-in Brushless Cordless Drill (2-Batteries Included, Charger Included and Hard Case included)',
      ),
    ).toBe('DeWalt');
  });

  it('fix-002 Amazon Sony headphones', () => {
    expect(
      extractBrand(
        'Sony WH-1000XM4 Wireless Premium Noise Canceling Overhead Headphones with Mic for Phone-Call and Alexa Voice Control, Black',
      ),
    ).toBe('Sony');
  });

  it('fix-008 BidFTA Shark vacuum', () => {
    expect(
      extractBrand('Shark IZ363HT Vertex Pro Cordless Stick Vacuum with DuoClean PowerFins'),
    ).toBe('Shark');
  });

  it("fix-018 Lowe's Moen faucet", () => {
    expect(
      extractBrand(
        'Moen Adler Spot Resist Stainless 2-handle Widespread WaterSense Bathroom Sink Faucet with Drain',
      ),
    ).toBe('Moen');
  });

  it('fix-021 BidFTA Weber grill', () => {
    expect(extractBrand('Weber Spirit II E-310 3-Burner Liquid Propane Gas Grill, Black')).toBe(
      'Weber',
    );
  });
});
