/**
 * Sensitometric diagnostics (§VI). These never touch a pixel — they are what
 * the readout panel prints so the numbers on screen are the same numbers the
 * chain is running on.
 */

import { clampSoftness } from './math';
import { density, pointGamma, type CurveParameters } from './curve';
import type { Record3 } from './triple';

/**
 * Log exposure producing Dmin + 0.10 (eq. speedpoint). Exact inversion of the
 * toe branch; the shoulder term is negligible at this density. Dividing by a
 * negative gamma flips the offset on its own, so reversal stocks need no branch.
 */
export function speedPoint(p: CurveParameters, c: Record3): number {
  const kt = clampSoftness(p.kappaT[c]);
  return p.x0[c] + (kt * Math.log(Math.expm1(0.1 / kt))) / p.gamma[c];
}

/** Arithmetic ISO speed from the green record: S = 0.8 / 10^x_sp. */
export function isoSpeed(p: CurveParameters): number {
  return 0.8 / Math.pow(10, speedPoint(p, 1));
}

/** Slope of the chord from the speed point to a point 2.00 log-E higher. */
export function contrastIndex(p: CurveParameters, c: Record3): number {
  const xsp = speedPoint(p, c);
  return (density(xsp + 2.0, p, c) - density(xsp, p, c)) / 2.0;
}

/**
 * Interval over which point gamma exceeds `fraction` of its maximum, in stops.
 * Sampled rather than solved: the bracket is the straight line and the sample
 * step is far inside display tolerance.
 */
export function latitude(p: CurveParameters, c: Record3, fraction = 0.5): number {
  const threshold = fraction * Math.abs(p.gamma[c]);
  let lo: number | null = null;
  let hi: number | null = null;
  for (let x = -6; x <= 4.0001; x += 0.005) {
    if (Math.abs(pointGamma(x, p, c)) >= threshold) {
      if (lo === null) lo = x;
      hi = x;
    }
  }
  if (lo === null || hi === null) return 0;
  return (hi - lo) / Math.log10(2);
}

/** Dmax as the curve actually reaches it, not the nominal Dmin + deltaD. */
export function dMax(p: CurveParameters, c: Record3): number {
  return density(p.x0[c] + (p.deltaD[c] + 6 * p.kappaS[c]) / p.gamma[c], p, c);
}

export interface SensitometricCard {
  iso: number;
  contrastIndex: number;
  latitudeStops: number;
  dMin: number;
  dMax: number;
  margin: number;
}

export function card(p: CurveParameters): SensitometricCard {
  return {
    iso: isoSpeed(p),
    contrastIndex: contrastIndex(p, 1),
    latitudeStops: latitude(p, 1, 0.5),
    dMin: p.dMin[1],
    dMax: p.dMin[1] + p.deltaD[1],
    margin: p.deltaD[1] - 4 * (p.kappaT[1] + p.kappaS[1]),
  };
}
