/**
 * Chemistry profiles (Appendix A, §"Chemistry and Development").
 *
 * Family-wide constants: tauToe 0.30, tauRange 0.12, Ea/R 8.4e3 K,
 * agitation efficiency (etaInfinity 1.22, eta0 0.61, etaScale 0.85).
 */

import type { ChemistryProfile } from '../development';

const FAMILY = {
  gammaInfinityRatio: 1.6,
  phi0: 0.045,
  betaFog: 2.1,
  alphaSpeed: 0.35,
  rhoPerStop: 1.35,
  tauToe: 0.3,
  tauRange: 0.12,
  activationEnergyOverR: 8.4e3,
  etaInfinity: 1.22,
  eta0: 0.61,
  etaScale: 0.85,
} as const;

export const CHEMISTRY: readonly ChemistryProfile[] = [
  {
    ...FAMILY,
    id: 'chem.c41',
    displayName: 'C-41',
    fogPerRecord: [0.82, 1.0, 1.34],
    referenceTimeSeconds: 195,
    referenceTemperatureK: 311.15, // 38.0 C
  },
  {
    ...FAMILY,
    id: 'chem.ecn2',
    displayName: 'ECN-2',
    fogPerRecord: [0.82, 1.0, 1.34],
    referenceTimeSeconds: 180,
    referenceTemperatureK: 314.75, // 41.6 C
  },
  {
    ...FAMILY,
    id: 'chem.e6',
    displayName: 'E-6',
    fogPerRecord: [0.9, 1.0, 1.15],
    referenceTimeSeconds: 180,
    referenceTemperatureK: 314.65, // 41.5 C, first development
  },
  {
    ...FAMILY,
    id: 'chem.bw',
    displayName: 'B&W',
    fogPerRecord: [1.0, 1.0, 1.0],
    // Appendix A gives no reference time/temperature for the monochrome family.
    // 8 min at 20 C is the conventional D-76 1:1 baseline; recorded as an
    // engineering default in DEVIATIONS.md rather than a value from the paper.
    referenceTimeSeconds: 480,
    referenceTemperatureK: 293.15,
  },
];

const BY_ID = new Map(CHEMISTRY.map((c) => [c.id, c]));

export function chemistryById(id: string): ChemistryProfile {
  const c = BY_ID.get(id);
  if (!c) throw new Error(`unknown chemistry '${id}'`);
  return c;
}
