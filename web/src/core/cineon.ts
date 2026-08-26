/**
 * The Cineon printing-density encoding — the input contract of every print
 * film LUT this engine ships.
 *
 * The print LUTs were calibrated against scanned negatives: a film scanner
 * digitises the negative's printing density into ten-bit code values, and the
 * LUT expects those codes normalised to [0, 1]. The standard mapping carries
 * five hundred code values per density unit, and the famous constants fall
 * out of it: code 95 is the dense end of a normal negative, code 445 is where
 * a correctly exposed 18% grey lands, code 685 is 90% white.
 *
 * This model already knows exactly where 18% grey lands on any stock — it is
 * the neutral density the aim balance is computed from — so the anchor needs
 * no tuning: the stock's own neutral density maps to code 445, five hundred
 * codes per unit of density carry the rest, and a correctly exposed scene
 * fills the LUT's domain the way a correctly exposed negative fills a
 * scanner's. Dmin maps near the LUT's black, Dmax near its white, and the
 * tests hold every stock to that.
 *
 * Polarity note, because it is the one thing that looks backwards: a
 * negative's high density is where the scene was bright, and the print stock
 * prints that white, so the code *rises* with density. Scene black is the
 * negative's clearest area, at the low codes, where the LUT prints black. The
 * LUTs' own diagonals confirm it: code 0 renders black, code 1023 white.
 */

import { clamp } from './math';
import { triMap, type Triple } from './triple';

/** Code values for the reference points of a normal negative. */
export const CINEON_BLACK = 95;
export const CINEON_GREY_18 = 445;
export const CINEON_WHITE_90 = 685;
export const CINEON_MAX_CODE = 1023;

/** The encoding's slope: five hundred code values per density unit. */
export const CINEON_CODES_PER_DENSITY = 500;

/**
 * Printing density to normalised Cineon code, anchored on the stock's own
 * neutral: `neutralDensity` is what an 18% grey builds on this stock, and it
 * maps to code 445 exactly.
 */
export function encodeCineon(density: Triple, neutralDensity: Triple): Triple {
  return triMap(density, (d, c) =>
    clamp(
      (CINEON_GREY_18 + CINEON_CODES_PER_DENSITY * (d - neutralDensity[c])) / CINEON_MAX_CODE,
      0,
      1,
    ),
  );
}

/** The exact inverse, for tests and for reading the Print D view back. */
export function decodeCineon(code: Triple, neutralDensity: Triple): Triple {
  return triMap(code, (u, c) =>
    (u * CINEON_MAX_CODE - CINEON_GREY_18) / CINEON_CODES_PER_DENSITY + neutralDensity[c],
  );
}

/** The normalised code an 18% grey sits at — a constant, by construction. */
export const CINEON_GREY_NORMALISED = CINEON_GREY_18 / CINEON_MAX_CODE;
