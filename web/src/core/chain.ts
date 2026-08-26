/**
 * The pointwise chain, on the host.
 *
 * This mirrors `gl/shaders/chain.ts` stage for stage. Two implementations of
 * one equation set is a real risk of drift, and it is taken deliberately: the
 * GPU path is what renders, and this path is what can be *tested* — against
 * Table VIII, against the ISO round trip, and against the neutrality claim of
 * §IX-C, none of which a fragment shader can assert for itself.
 *
 * Any divergence between the two is a defect in this file or in that one, not
 * a tolerance to be widened.
 */

import { densityWithMask } from './curve';
import { safeLog10 } from './math';
import {
  neutralAxisWeight,
  printDensityAt,
  printToDisplay,
  printingDensity,
  silverDensity,
} from './print';
import type { ResolvedParameters } from './resolve';
import { RECORDS, matMulVec, triAdd, triFill, type Triple } from './triple';

/** Stages 1-2 — the layer balance and the log exposure the film receives. */
export function sceneLogExposure(sceneLinear: Triple, p: ResolvedParameters): Triple {
  let e = matMulVec(p.inputMatrix, sceneLinear);
  e = RECORDS.map((c) => Math.max(e[c] * p.exposureGain, 0)) as unknown as Triple;
  if (p.monochrome) {
    const y = p.panWeights[0] * e[0] + p.panWeights[1] * e[1] + p.panWeights[2] * e[2];
    e = triFill(y);
  }
  return RECORDS.map((c) => safeLog10(e[c]) + p.anchorShift) as unknown as Triple;
}

/** Stage 3 — the negative's density, orange mask and all. */
export function negativeDensity(logExposure: Triple, p: ResolvedParameters): Triple {
  return densityWithMask(triAdd(logExposure, p.balanceShift), p.curve);
}

/** The viewing-condition exponent, kept separate so the subtractive grade —
 * a print-dye operation — can sit between the print and the surround. */
export function applySurround(Y: Triple, p: ResolvedParameters): Triple {
  if (Math.abs(p.surroundExponent - 1) < 1e-4) return Y;
  return RECORDS.map((c) => Math.pow(Math.max(Y[c], 0), p.surroundExponent)) as unknown as Triple;
}

/** Stages 1-9, from film log exposure to display-linear RGB in the print's
 * primaries, before the surround. */
export function evaluateLogExposureStages(logExposure: Triple, p: ResolvedParameters): Triple {
  // Stage 1 — layer balance.
  const x = triAdd(logExposure, p.balanceShift);

  // Stages 2-3 — characteristic curve with mask depletion.
  const D = densityWithMask(x, p.curve);

  if (p.bypass) {
    const t = RECORDS.map((c) =>
      Math.min(Math.max((D[c] - p.curve.dMin[c]) / p.curve.deltaD[c], 0), 1),
    ) as unknown as Triple;
    const reversal = p.curve.gamma[1] < 0;
    return RECORDS.map((c) => {
      const v = reversal ? 1 - t[c] : t[c];
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }) as unknown as Triple;
  }

  // Stage 4 — printing density.
  const dEff = printingDensity(D, p.crosstalk);

  // Stage 5 — print exposure.
  const logEPrime = RECORDS.map((c) => p.printExposureOffset[c] - dEff[c]) as unknown as Triple;

  // Stage 6 — print curve.
  let Dp = RECORDS.map((c) => printDensityAt(logEPrime[c], p.printCurve, c)) as unknown as Triple;

  // Stage 7 — silver retention.
  if (p.silverRetention > 0) {
    const bar = silverDensity(Dp, p.printCurve);
    Dp = RECORDS.map((c) => Dp[c] + p.silverRetention * bar) as unknown as Triple;
  }

  // Stage 8 — neutral axis tilt.
  const psi = neutralAxisWeight(Dp, p.printCurve);
  Dp = RECORDS.map((c) => Dp[c] + p.neutralAxis[c] * psi) as unknown as Triple;

  // Stage 9 — display.
  return printToDisplay(Dp, p.printCurve);
}

/** Stages 1-9 plus the surround: the calculated model, complete. */
export function evaluateLogExposure(logExposure: Triple, p: ResolvedParameters): Triple {
  return applySurround(evaluateLogExposureStages(logExposure, p), p);
}

/**
 * The scene-linear entry point. Everything it prepends lives *outside* the LUT
 * domain — the input and white-balance matrix, the exposure anchor and the ISO
 * shift — because the LUT is indexed on log exposure, and baking anything
 * before the log would let a white-balance change silently invalidate it.
 */
export function evaluateSceneLinear(sceneLinear: Triple, p: ResolvedParameters): Triple {
  const logE = sceneLogExposure(sceneLinear, p);
  return evaluateLogExposure(logE, p);
}

/** Convert a display-linear triple to the sRGB/P3 encoding the canvas shows. */
export function encodeDisplay(v: Triple, outputMatrix = null as null): Triple {
  void outputMatrix;
  return RECORDS.map((c) => {
    const x = Math.min(Math.max(v[c], 0), 1);
    return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  }) as unknown as Triple;
}
