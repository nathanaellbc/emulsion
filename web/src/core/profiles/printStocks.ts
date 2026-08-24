/**
 * Print stock profiles (Appendix A, Table "Print Stock Curve Parameters").
 *
 * No x0' column is published, and none is needed: the printer light positions
 * the negative on the print curve, so x0' is fixed at zero and the aim balance
 * absorbs it.
 */

import type { PrintProfile } from '../print';

/**
 * Kodak H-61B, "LAD for KODAK VISION Color Print Film": the Status A density
 * aim is 1.09 red, 1.06 green and 1.03 blue, for 2383/3383 and 2393/3393
 * alike. The small red-to-blue gradient is the projector-lamp allowance, and it
 * is why a printed neutral leans very slightly warm.
 *
 * The same document adds: "Other films may have different Status A densities to
 * obtain a 1.0 density visual neutral." Fuji publishes no equivalent for the
 * Eterna-CP stocks, so those carry this triple as a stated assumption rather
 * than as a measurement — see `aimSource` and DEVIATIONS.md finding 10.
 */
const KODAK_LAD: [number, number, number] = [1.09, 1.06, 1.03];

export const PRINT_STOCKS: readonly PrintProfile[] = [
  {
    id: 'prt.2383',
    displayName: '2383-type',
    character:
      'The default. Moderate saturation, warm-leaning neutral axis, gentle toe. The reference everything else is judged against.',
    bypass: false,
    gamma: 2.8,
    deltaD: 2.42,
    kappaT: 0.22,
    kappaS: 0.06,
    dMin: 0.06,
    crosstalkScale: 1.0,
    greenBlueAdjust: 0,
    aimDensity: KODAK_LAD,
    aimSource: 'published',
  },
  {
    id: 'prt.2393',
    displayName: '2393-type',
    character:
      'Higher saturation through steeper cross-terms, deeper maximum density, harder shoulder. More contrast, less latitude.',
    bypass: false,
    gamma: 3.05,
    deltaD: 2.58,
    kappaT: 0.185,
    kappaS: 0.052,
    dMin: 0.05,
    crosstalkScale: 1.18,
    greenBlueAdjust: 0,
    aimDensity: KODAK_LAD,
    aimSource: 'published',
  },
  {
    id: 'prt.3513',
    displayName: '3513-type',
    character:
      'Cooler neutral axis, distinctly different green and cyan rendering, softer approach to maximum density.',
    bypass: false,
    gamma: 2.72,
    deltaD: 2.35,
    kappaT: 0.245,
    kappaS: 0.068,
    dMin: 0.07,
    crosstalkScale: 0.92,
    greenBlueAdjust: 0.014,
    aimDensity: KODAK_LAD,
    aimSource: 'assumed',
  },
  {
    id: 'prt.3521',
    displayName: '3521-type',
    character: 'Higher-saturation rendering with characteristic magenta handling.',
    bypass: false,
    gamma: 2.9,
    deltaD: 2.48,
    kappaT: 0.205,
    kappaS: 0.058,
    dMin: 0.06,
    crosstalkScale: 1.09,
    greenBlueAdjust: 0.014,
    aimDensity: KODAK_LAD,
    aimSource: 'assumed',
  },
  {
    id: 'prt.bypass',
    displayName: 'Bypass (scan)',
    character:
      'No print transfer. Negative density is inverted and normalised only — the flat, low-contrast look of an unadjusted lab scan.',
    bypass: true,
    gamma: 1,
    deltaD: 1,
    kappaT: 0.1,
    kappaS: 0.1,
    dMin: 0,
    crosstalkScale: 1,
    greenBlueAdjust: 0,
    // Never consulted: bypass skips the aim balance entirely.
    aimDensity: KODAK_LAD,
    aimSource: 'assumed',
  },
];

const BY_ID = new Map(PRINT_STOCKS.map((p) => [p.id, p]));

export function printStockById(id: string): PrintProfile {
  const p = BY_ID.get(id);
  if (!p) throw new Error(`unknown print stock '${id}'`);
  return p;
}
