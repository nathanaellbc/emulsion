/**
 * The characteristic curve — the one equation everything else is arranged
 * around (§VI, eq. charcurve):
 *
 *     D(x) = Dmin + sp_kt(u) - sp_ks(u - dD),   u = gamma * (x - x0)
 *
 * Reversal stocks carry gamma < 0 and flow through unchanged: softplus is
 * monotone in u, and u decreases with x when gamma < 0, so density falls with
 * exposure exactly as a positive image requires. Only two places respect the
 * sign — `isWellFormed` tests |gamma|, and the speed-point offset divides by
 * gamma, which flips on its own.
 */

import { MIN_SOFTNESS, clampSoftness, logistic, softplus } from './math';
import type { Record3, Triple } from './triple';
import { RECORDS, triMap } from './triple';

export interface CurveParameters {
  readonly dMin: Triple;
  readonly deltaD: Triple;
  readonly gamma: Triple;
  readonly x0: Triple;
  readonly kappaT: Triple;
  readonly kappaS: Triple;
  /** Orange-mask depletion per record (§VI, eq. maskdepletion). Zero for non-masked stocks. */
  readonly maskDepletion: Triple;
  /** Layer speed balance in log exposure (§V, eq. tungsten). Zero for daylight stocks. */
  readonly balanceShift: Triple;
}

/** Straight-line coordinate. */
export function uCoord(x: number, p: CurveParameters, c: Record3): number {
  return p.gamma[c] * (x - p.x0[c]);
}

export function density(x: number, p: CurveParameters, c: Record3): number {
  const u = uCoord(x, p, c);
  return p.dMin[c] + softplus(u, p.kappaT[c]) - softplus(u - p.deltaD[c], p.kappaS[c]);
}

/**
 * Point gamma: the closed-form derivative dD/dx. Consumed by printer-light
 * sensitivity (§X) and by the grain model, and asserted against a central
 * difference in the test suite (claim R4).
 */
export function pointGamma(x: number, p: CurveParameters, c: Record3): number {
  const u = uCoord(x, p, c);
  const toe = logistic(u / clampSoftness(p.kappaT[c]));
  const shoulder = logistic((u - p.deltaD[c]) / clampSoftness(p.kappaS[c]));
  return p.gamma[c] * (toe - shoulder);
}

export function densityTriple(x: Triple, p: CurveParameters): Triple {
  return [density(x[0], p, 0), density(x[1], p, 1), density(x[2], p, 2)];
}

/**
 * Density with orange-mask depletion applied as a single fixed-point
 * iteration: compute density, correct Dmin, recompute once. The paper states
 * one pass is below AC-1 tolerance, so this is not iterated to convergence.
 */
export function densityWithMask(x: Triple, p: CurveParameters): Triple {
  const first = densityTriple(x, p);
  const dMin = triMap(p.dMin, (d, c) => d - p.maskDepletion[c] * ((first[c] - d) / p.deltaD[c]));
  return densityTriple(x, { ...p, dMin });
}

/**
 * deltaD - 4(kappaT + kappaS). The engineering constraint of §VI, stronger
 * than the weaker sufficient condition, because it also guarantees a
 * straight-line region exists between toe and shoulder.
 */
export function wellFormednessMargin(p: CurveParameters, c: Record3): number {
  return p.deltaD[c] - 4 * (p.kappaT[c] + p.kappaS[c]);
}

export function isWellFormed(p: CurveParameters): boolean {
  return RECORDS.every(
    (c) =>
      p.deltaD[c] > 0 &&
      Math.abs(p.gamma[c]) > 0 &&
      p.kappaT[c] >= MIN_SOFTNESS &&
      p.kappaS[c] >= MIN_SOFTNESS &&
      wellFormednessMargin(p, c) >= 0,
  );
}

export class ProfileInvalidError extends Error {
  constructor(
    readonly profileId: string,
    readonly reason: string,
  ) {
    super(`profile '${profileId}' invalid: ${reason}`);
    this.name = 'ProfileInvalidError';
  }
}

/** Throws rather than substituting defaults: a stock that renders but is not
 * the stock named on it would falsify the paper's "defaults are measurements"
 * claim (§I-C). */
export function validateCurve(p: CurveParameters, id: string): void {
  const names = ['R', 'G', 'B'] as const;
  for (const c of RECORDS) {
    if (!(p.deltaD[c] > 0)) throw new ProfileInvalidError(id, `deltaD <= 0 on ${names[c]}`);
    if (!(Math.abs(p.gamma[c]) > 0)) throw new ProfileInvalidError(id, `gamma == 0 on ${names[c]}`);
    if (p.kappaT[c] < MIN_SOFTNESS || p.kappaS[c] < MIN_SOFTNESS) {
      throw new ProfileInvalidError(id, `softness below floor on ${names[c]}`);
    }
    if (wellFormednessMargin(p, c) < 0) {
      throw new ProfileInvalidError(
        id,
        `deltaD ${p.deltaD[c].toFixed(3)} < 4(kt+ks) on ${names[c]}`,
      );
    }
  }
}
