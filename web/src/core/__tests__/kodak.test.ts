/**
 * Conformance against Kodak's own published documents, not against the paper.
 *
 * The design document is one remove from the manufacturer; these assertions are
 * zero removes. Two primary sources:
 *
 *   H-61B, "LAD for KODAK VISION Color Print Film" —
 *     "On KODAK VISION Color Print Film 2383/3383 or KODAK VISION Premier Color
 *      Print Film 2393/3393, the Status A density aim is 1.09 red, 1.06 green,
 *      and 1.03 blue."
 *     "When near aim, changing one printer light of TRIM (0.025 Log Exposure
 *      Unit) will result in approximately 0.07 density change on the print for
 *      2383/3383 and 2393/3393."
 *     "Other films may have different Status A densities to obtain a 1.0
 *      density visual neutral."
 *
 *   H-1-2383t, KODAK VISION Color Print Film / 2383, 3383 technical data.
 *
 * The trim relation is the useful one: it is a statement about the *whole print
 * stage* — printer light unit, print gamma, and where the aim sits on the curve
 * — so it tests the chain rather than a stored constant.
 */

import { describe, expect, it } from 'vitest';
import { PRINTER_POINT, printDensityAt, printingDensity } from '../print';
import { PRINT_STOCKS, printStockById } from '../profiles/printStocks';
import { densityWithMask } from '../curve';
import { defaultRecipe, type Recipe } from '../recipe';
import { resolve } from '../resolve';
import { RECORDS, triFill } from '../triple';

const ctx = { renderWidthPx: 2048, sourceSpace: 'linearAP1' } as const;

/** Kodak H-61B, Status A density aim for the LAD patch. */
const KODAK_LAD = [1.09, 1.06, 1.03] as const;

/** The print density a scene neutral lands on, through the resolved chain. */
function neutralPrintDensity(recipe: Recipe, trimPoints = 0) {
  const r = resolve(
    {
      ...recipe,
      // The H-61B relations are the calculated model's guarantees.
      printEngine: 'model',
      printing: {
        ...recipe.printing,
        printerLightR: trimPoints,
        printerLightG: trimPoints,
        printerLightB: trimPoints,
      },
    },
    ctx,
  );
  const neutralLogE = r.anchorShift + Math.log10(0.18);
  const D = densityWithMask(triFill(neutralLogE), r.curve);
  const dEff = printingDensity(D, r.crosstalk);
  return RECORDS.map((c) => printDensityAt(r.printExposureOffset[c] - dEff[c], r.printCurve, c));
}

describe('Kodak H-61B laboratory aim density', () => {
  it('is 1.09 / 1.06 / 1.03 on the two stocks the document names', () => {
    for (const id of ['prt.2383', 'prt.2393']) {
      const p = printStockById(id);
      expect(p.aimDensity[0], id).toBeCloseTo(KODAK_LAD[0], 6);
      expect(p.aimDensity[1], id).toBeCloseTo(KODAK_LAD[1], 6);
      expect(p.aimDensity[2], id).toBeCloseTo(KODAK_LAD[2], 6);
    }
  });

  it('is marked as published on the Kodak stocks and assumed everywhere else', () => {
    expect(printStockById('prt.2383').aimSource).toBe('published');
    expect(printStockById('prt.2393').aimSource).toBe('published');
    // H-61B: "Other films may have different Status A densities." Fuji does not
    // publish an equivalent, so carrying Kodak's triple on a Fuji stock is an
    // assumption and has to be labelled as one.
    expect(printStockById('prt.3513').aimSource).toBe('assumed');
    expect(printStockById('prt.3521').aimSource).toBe('assumed');
  });

  it('never leaves a stock without provenance for its aim', () => {
    for (const p of PRINT_STOCKS) {
      expect(['published', 'assumed'], p.id).toContain(p.aimSource);
    }
  });

  it('puts a scene neutral on the aim, which is what the balance is for', () => {
    const D = neutralPrintDensity({ ...defaultRecipe(), printId: 'prt.2383' });
    for (const c of RECORDS) expect(D[c]!).toBeCloseTo(KODAK_LAD[c]!, 4);
  });
});

describe('Kodak H-61B printer trim relation', () => {
  it('moves the print about 0.07 density per printer point, near aim', () => {
    const base = neutralPrintDensity({ ...defaultRecipe(), printId: 'prt.2383' });
    const trimmed = neutralPrintDensity({ ...defaultRecipe(), printId: 'prt.2383' }, 1);
    for (const c of RECORDS) {
      const delta = trimmed[c]! - base[c]!;
      // "approximately 0.07" — held to a hundredth, which is the precision the
      // document states it to.
      expect(delta, `record ${c}: ${delta.toFixed(4)}`).toBeGreaterThan(0.06);
      expect(delta, `record ${c}: ${delta.toFixed(4)}`).toBeLessThan(0.08);
    }
  });

  it('holds the same relation on 2393, which the document names alongside 2383', () => {
    const base = neutralPrintDensity({ ...defaultRecipe(), printId: 'prt.2393' });
    const trimmed = neutralPrintDensity({ ...defaultRecipe(), printId: 'prt.2393' }, 1);
    for (const c of RECORDS) {
      const delta = trimmed[c]! - base[c]!;
      expect(delta, `record ${c}: ${delta.toFixed(4)}`).toBeGreaterThan(0.06);
      expect(delta, `record ${c}: ${delta.toFixed(4)}`).toBeLessThan(0.085);
    }
  });

  it('raises print density as trim rises — "if the density is too low, increase the TRIM"', () => {
    const base = neutralPrintDensity({ ...defaultRecipe(), printId: 'prt.2383' });
    const up = neutralPrintDensity({ ...defaultRecipe(), printId: 'prt.2383' }, 3);
    const down = neutralPrintDensity({ ...defaultRecipe(), printId: 'prt.2383' }, -3);
    for (const c of RECORDS) {
      expect(up[c]!).toBeGreaterThan(base[c]!);
      expect(down[c]!).toBeLessThan(base[c]!);
    }
  });

  it('uses the document’s printer point, 0.025 log exposure units', () => {
    expect(PRINTER_POINT).toBe(0.025);
    // Twelve points to the stop is the working consequence labs rely on.
    expect(12 * PRINTER_POINT).toBeCloseTo(Math.log10(2), 2);
  });
});
