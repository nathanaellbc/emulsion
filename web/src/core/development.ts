/**
 * Development (§VII). Time, temperature, agitation, concentration and push
 * collapse into one activity scalar A; A then reshapes the curve. All of this
 * is host side and costs no GPU instruction — it changes the parameters the
 * shader is handed, not the work the shader does.
 */

import type { CurveParameters } from './curve';
import { RECORDS, type Triple, triMap } from './triple';

export interface ChemistryProfile {
  readonly id: string;
  readonly displayName: string;
  /** gamma_inf / gamma_0 — the development ceiling. */
  readonly gammaInfinityRatio: number;
  /** Fog magnitude and exponent (eq. fog). */
  readonly phi0: number;
  readonly betaFog: number;
  /** Speed recovery coefficient (eq. speedshift). Push buys back only a fraction. */
  readonly alphaSpeed: number;
  /** Activity multiplier per push stop. */
  readonly rhoPerStop: number;
  /** Toe and density-range drift. */
  readonly tauToe: number;
  readonly tauRange: number;
  /** Per-layer fog scaling — the blue-sensitive layer fogs fastest. */
  readonly fogPerRecord: Triple;
  readonly referenceTimeSeconds: number;
  readonly referenceTemperatureK: number;
  /** Ea/R in kelvin. */
  readonly activationEnergyOverR: number;
  /** Agitation efficiency constants, family-wide (Appendix A). */
  readonly etaInfinity: number;
  readonly eta0: number;
  readonly etaScale: number;
}

export interface DevelopStage {
  /** Stops; positive is push. */
  pushPull: number;
  /** null means the chemistry reference. */
  timeSeconds: number | null;
  temperatureK: number | null;
  /** 1.0 is the manufacturer's recommended scheme. */
  agitation: number;
  developerConcentration: number;
}

export function defaultDevelopStage(): DevelopStage {
  return {
    pushPull: 0,
    timeSeconds: null,
    temperatureK: null,
    agitation: 1,
    developerConcentration: 1,
  };
}

/** Saturating agitation efficiency, normalised so eta(1) === 1 exactly. */
export function agitationEfficiency(ag: number, chem: ChemistryProfile): number {
  const raw = (a: number) =>
    chem.etaInfinity - (chem.etaInfinity - chem.eta0) * Math.exp(-a / chem.etaScale);
  return raw(ag) / raw(1);
}

/** A === 1 is the manufacturer's normal process, by construction. */
export function activity(d: DevelopStage, chem: ChemistryProfile): number {
  const t = d.timeSeconds ?? chem.referenceTimeSeconds;
  const T = d.temperatureK ?? chem.referenceTemperatureK;
  const arrhenius = Math.exp(chem.activationEnergyOverR * (1 / chem.referenceTemperatureK - 1 / T));
  const base =
    (t / chem.referenceTimeSeconds) *
    arrhenius *
    agitationEfficiency(d.agitation, chem) *
    d.developerConcentration;
  return base * Math.pow(chem.rhoPerStop, d.pushPull);
}

/**
 * Reshapes the curve for a given activity. Gamma saturates toward a ceiling,
 * fog rises without saturating, speed recovers only partially, and the toe and
 * range drift — which together are why a push is not an exposure change.
 */
export function modulate(
  curve: CurveParameters,
  A: number,
  chem: ChemistryProfile,
): CurveParameters {
  const a = Math.max(A, 1e-6);
  const logA = Math.log(a);
  const log10A = Math.log10(a);

  const gamma = triMap(curve.gamma, (g) => {
    const gammaInf = g * chem.gammaInfinityRatio;
    // aGamma is chosen so that gamma(A = 1) returns the nominal gamma exactly.
    const aGamma = 1 / Math.log(gammaInf / (gammaInf - g));
    return gammaInf * (1 - Math.exp(-a / aGamma));
  });

  const dMin = triMap(curve.dMin, (d, c) => {
    const phi = chem.phi0 * chem.fogPerRecord[c];
    return d + phi * (Math.pow(a, chem.betaFog) - 1);
  });

  const x0 = triMap(curve.x0, (x) => x - chem.alphaSpeed * log10A);
  const kappaT = triMap(curve.kappaT, (k) => Math.max(k * (1 + chem.tauToe * logA), 1e-3));
  const deltaD = triMap(curve.deltaD, (d) => Math.max(d * (1 + chem.tauRange * logA), 1e-3));

  return { ...curve, gamma, dMin, x0, kappaT, deltaD };
}

/** The push/pull activity ladder the UI labels its notches with. */
export function pushLabel(stops: number): string {
  if (Math.abs(stops) < 1e-6) return 'Normal';
  const n = Math.abs(stops);
  const unit = n === 1 ? 'stop' : 'stops';
  return `${stops > 0 ? 'Push' : 'Pull'} ${n} ${unit}`;
}

export { RECORDS };
