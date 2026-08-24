/**
 * Optical printing (§IX) and the printer-light control surface (§X).
 *
 * The print stage is where the film look is actually made. The negative is a
 * low-contrast, orange-masked, inverted record; every quality people mean by
 * "film look" is created in the second transfer, and that transfer is not three
 * independent 1-D curves — it is a curve applied to the negative's
 * transmittance, mediated by the crosstalk matrix C.
 */

import { clampSoftness, logistic, softplus } from './math';
import { RECORDS, matMulVec, scaleOffDiagonal, type Matrix3, type Triple } from './triple';

/** One printer point = 0.025 in log10 exposure. Twelve points make one stop. */
export const PRINTER_POINT = 0.025;

/** Silver density range for the retention model (Appendix A). */
export const DELTA_D_SILVER = 0.9;

/**
 * Base printing density matrix (§IX, eq. cmatrix). The off-diagonal terms are
 * the unwanted absorptions: the cyan dye absorbs some green, the magenta dye
 * absorbs some blue.
 */
export const C_BASE: Matrix3 = [
  [1.0, 0.086, 0.028],
  [0.041, 1.0, 0.113],
  [0.017, 0.052, 1.0],
];

export interface PrintProfile {
  readonly id: string;
  readonly displayName: string;
  readonly character: string;
  /** Bypass short-circuits stages 4-8 and inverts the negative only. */
  readonly bypass: boolean;
  readonly gamma: number;
  readonly deltaD: number;
  readonly kappaT: number;
  readonly kappaS: number;
  readonly dMin: number;
  /** Multiplier on C's off-diagonal terms for this stock. */
  readonly crosstalkScale: number;
  /** Fuji-type stocks carry an additive adjustment on C_GB. */
  readonly greenBlueAdjust: number;
  /** Laboratory aim density; the small R-to-B gradient is the projector allowance. */
  readonly aimDensity: Triple;
  /**
   * Where that triple comes from. Kodak publishes it for 2383/3383 and
   * 2393/3393 in H-61B and says in the same document that "other films may have
   * different Status A densities to obtain a 1.0 density visual neutral" — so
   * carrying it on a Fuji stock is an assumption, and the difference between a
   * measurement and an assumption is not something a profile should hide.
   */
  readonly aimSource: 'published' | 'assumed';
}

/** Per-channel print curve parameters, after the user's print controls apply. */
export interface PrintCurve {
  readonly dMin: Triple;
  readonly deltaD: Triple;
  readonly gamma: Triple;
  readonly kappaT: Triple;
  readonly kappaS: Triple;
}

/**
 * The print stock's characteristic curve. Identical formulation to the
 * negative's, with x0' fixed at zero: the printer light is what positions the
 * negative on this curve, which is why Appendix A publishes no x0' column.
 */
export function printDensityAt(logEPrime: number, p: PrintCurve, c: 0 | 1 | 2): number {
  const u = p.gamma[c] * logEPrime;
  return p.dMin[c] + softplus(u, p.kappaT[c]) - softplus(u - p.deltaD[c], p.kappaS[c]);
}

export function printPointGamma(logEPrime: number, p: PrintCurve, c: 0 | 1 | 2): number {
  const u = p.gamma[c] * logEPrime;
  const toe = logistic(u / clampSoftness(p.kappaT[c]));
  const shoulder = logistic((u - p.deltaD[c]) / clampSoftness(p.kappaS[c]));
  return p.gamma[c] * (toe - shoulder);
}

export class AimBalanceDivergedError extends Error {
  constructor(negative: string, print: string) {
    super(`aim balance did not converge for (${negative}, ${print})`);
    this.name = 'AimBalanceDivergedError';
  }
}

/**
 * Numerical inverse of the print curve: the log exposure that produces a
 * target density. Four Newton steps from the straight-line estimate, as §IX
 * specifies. Non-convergence means a broken profile pair and every render from
 * it would be mis-balanced, so this refuses rather than approximating.
 */
export function invertPrintCurve(
  targetDensity: number,
  p: PrintCurve,
  c: 0 | 1 | 2,
  context: { negative: string; print: string },
): number {
  // Straight line: D = dMin + gamma * x  =>  x = (D - dMin) / gamma
  let x = (targetDensity - p.dMin[c]) / p.gamma[c];
  for (let i = 0; i < 8; i++) {
    const f = printDensityAt(x, p, c) - targetDensity;
    if (Math.abs(f) < 1e-9) return x;
    const df = printPointGamma(x, p, c);
    if (!Number.isFinite(df) || Math.abs(df) < 1e-6) break;
    x -= f / df;
    if (!Number.isFinite(x)) break;
  }
  if (Math.abs(printDensityAt(x, p, c) - targetDensity) > 1e-4) {
    throw new AimBalanceDivergedError(context.negative, context.print);
  }
  return x;
}

/**
 * Printing density: the effective density each print layer sees (eq.
 * printdensity). This is where the negative's three records interact, and it is
 * also where the orange mask stops being special — Dmin enters as a constant
 * vector, so it is removed by balancing rather than by an operation.
 */
export function printingDensity(negativeDensity: Triple, C: Matrix3): Triple {
  return matMulVec(C, negativeDensity);
}

/**
 * Builds the effective crosstalk matrix for a print stock and a saturation
 * setting. Reducing saturation-density scales the unwanted absorptions down,
 * which *increases* apparent saturation — the control reads inverted on
 * purpose, because that is what the physical quantity does.
 */
export function crosstalkMatrix(print: PrintProfile, saturationDensity: number): Matrix3 {
  const scaled = scaleOffDiagonal(C_BASE, print.crosstalkScale * saturationDensity);
  if (print.greenBlueAdjust === 0) return scaled;
  const m = scaled.map((row) => [...row]) as unknown as number[][];
  m[1]![2] = m[1]![2]! + print.greenBlueAdjust * saturationDensity;
  return m as unknown as Matrix3;
}

/**
 * Aim balance (eq. aimbalance): the printer lights that make a scene-referred
 * neutral reproduce the print stock's aim density. Computed once per
 * (negative, print, saturation) triple and cached — this is what guarantees a
 * neutral neutral across every stock pairing without hand-tuning any of them.
 */
export function aimBalance(
  neutralNegativeDensity: Triple,
  printCurve: PrintCurve,
  print: PrintProfile,
  C: Matrix3,
  negativeId: string,
): Triple {
  const dEff = printingDensity(neutralNegativeDensity, C);
  const ctx = { negative: negativeId, print: print.id };
  return RECORDS.map((c) => {
    const target = invertPrintCurve(print.aimDensity[c], printCurve, c, ctx);
    return target + dEff[c];
  }) as unknown as Triple;
}

/** Neutral (silver) density, proportional to total development (§IX). */
export function silverDensity(printDensity: Triple, p: PrintCurve): number {
  let s = 0;
  for (const c of RECORDS) s += (printDensity[c] - p.dMin[c]) / p.deltaD[c];
  return (s / 3) * DELTA_D_SILVER;
}

/** Antisymmetric weighting for the neutral-axis tilt (eq. neutralaxis). */
export function neutralAxisWeight(printDensity: Triple, p: PrintCurve): number {
  let s = 0;
  for (const c of RECORDS) s += (printDensity[c] - p.dMin[c]) / p.deltaD[c];
  return s / 3 - 0.5;
}

/**
 * Print density to display luminance (eq. printtodisplay). Subtracting the
 * Dmax term matters: without it the print's finite maximum density leaves a
 * lifted black that compounds with the panel's own and reads washed out.
 */
export function printToDisplay(printDensity: Triple, p: PrintCurve): Triple {
  return RECORDS.map((c) => {
    const dMaxC = p.dMin[c] + p.deltaD[c];
    const lo = Math.pow(10, -dMaxC);
    const hi = Math.pow(10, -p.dMin[c]);
    return (Math.pow(10, -printDensity[c]) - lo) / Math.max(hi - lo, 1e-9);
  }) as unknown as Triple;
}
