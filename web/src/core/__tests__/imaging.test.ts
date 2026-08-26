/**
 * The suite holds the implementation to the numbers the paper publishes.
 *
 * Where a test fails, the finding goes in DEVIATIONS.md and one side gets
 * corrected. Tolerances do not get widened to make a row pass — a tolerance
 * loosened to hide a disagreement destroys the only evidence that the design
 * document and the code have diverged.
 */

import { describe, expect, it } from 'vitest';
import { logistic, softplus } from '../math';
import {
  density,
  densityWithMask,
  isWellFormed,
  pointGamma,
  validateCurve,
  wellFormednessMargin,
} from '../curve';
import { activity, agitationEfficiency, modulate } from '../development';
import { contrastIndex, isoSpeed, speedPoint } from '../sensitometry';
import { evaluateSceneLinear } from '../chain';
import { defaultRecipe, type Recipe } from '../recipe';
import { resolve } from '../resolve';
import { IDEAL_NEGATIVE_ID, NEGATIVES, negativeById } from '../profiles/negatives';
import { PRINT_STOCKS } from '../profiles/printStocks';
import { CHEMISTRY, chemistryById } from '../profiles/chemistry';
import { RECORDS, matInverse, matMul, IDENTITY3 } from '../triple';
import { M_P3_TO_AP1, whiteBalanceMatrix, REFERENCE_TEMP_K } from '../colorspace';
import { invertPrintCurve, printDensityAt } from '../print';

const ctx = { renderWidthPx: 2048, sourceSpace: 'linearAP1' } as const;

describe('softplus', () => {
  it('approaches max(u, 0) as the softness vanishes', () => {
    expect(softplus(2, 1e-3)).toBeCloseTo(2, 6);
    expect(softplus(-2, 1e-3)).toBeCloseTo(0, 6);
  });

  it('stays finite where the naive form overflows', () => {
    // u/a = +/-800 overflows a * log(1 + exp(u/a)) outright.
    const hi = softplus(80, 0.1);
    const lo = softplus(-80, 0.1);
    expect(Number.isFinite(hi)).toBe(true);
    expect(Number.isFinite(lo)).toBe(true);
    expect(hi).toBeCloseTo(80, 9);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(lo).toBeLessThan(1e-300);
  });

  it('has the logistic as its derivative', () => {
    const a = 0.14;
    const u = 0.37;
    const h = 1e-6;
    const numeric = (softplus(u + h, a) - softplus(u - h, a)) / (2 * h);
    expect(numeric).toBeCloseTo(logistic(u / a), 6);
  });
});

describe('characteristic curve', () => {
  const portra = negativeById('neg.portra400').curve;

  it('reaches Dmin below the toe and Dmin + deltaD above the shoulder', () => {
    expect(density(-8, portra, 1)).toBeCloseTo(portra.dMin[1], 6);
    expect(density(8, portra, 1)).toBeCloseTo(portra.dMin[1] + portra.deltaD[1], 2);
  });

  it('has slope gamma through the straight line', () => {
    const xMid = portra.x0[1] + portra.deltaD[1] / 2 / portra.gamma[1];
    expect(pointGamma(xMid, portra, 1)).toBeCloseTo(portra.gamma[1], 2);
  });

  // Claim R4: the closed-form derivative is the one the grain and printer-light
  // models consume, so it has to be the derivative of the curve being drawn.
  it('analytic point gamma matches a central difference everywhere', () => {
    const h = 1e-6;
    for (const stock of NEGATIVES) {
      for (const c of RECORDS) {
        for (let x = -5; x <= 3.0001; x += 0.05) {
          const numeric = (density(x + h, stock.curve, c) - density(x - h, stock.curve, c)) / (2 * h);
          expect(Math.abs(numeric - pointGamma(x, stock.curve, c))).toBeLessThan(1e-5);
        }
      }
    }
  });

  // AC-6.
  it('is monotone over [-5, 3] for every stock at every process setting', () => {
    for (const stock of NEGATIVES) {
      const chem = chemistryById(stock.chemistryId);
      for (const stops of [-2, -1, 0, 1, 2, 3]) {
        const curve = modulate(
          stock.curve,
          activity({ ...defaultRecipe().develop, pushPull: stops }, chem),
          chem,
        );
        const rising = curve.gamma[1] > 0;
        for (const c of RECORDS) {
          let previous = rising ? -Infinity : Infinity;
          for (let x = -5; x <= 3.0001; x += 0.02) {
            const d = density(x, curve, c);
            if (rising) expect(d).toBeGreaterThanOrEqual(previous - 1e-9);
            else expect(d).toBeLessThanOrEqual(previous + 1e-9);
            previous = d;
          }
        }
      }
    }
  });

  it('stays finite and smooth at extreme softness ratios', () => {
    const p = { ...portra, kappaT: [0.1, 0.1, 0.1] as const };
    for (const x of [-80, -8, 0, 8, 80]) {
      const d = density(x, p as never, 1);
      expect(Number.isFinite(d)).toBe(true);
      expect(Number.isNaN(d)).toBe(false);
    }
  });

  it('mask depletion lowers Dmin where density is high and leaves it at the toe', () => {
    const low = densityWithMask([-6, -6, -6], portra);
    expect(low[2]).toBeCloseTo(portra.dMin[2], 4);
    const high = densityWithMask([1, 1, 1], portra);
    const plain = density(1, portra, 2);
    expect(high[2]).toBeLessThan(plain);
  });
});

describe('profiles', () => {
  it('ships ten negatives and the ideal record, and five print stocks', () => {
    expect(NEGATIVES.length).toBe(11);
    expect(PRINT_STOCKS.length).toBe(5);
    expect(CHEMISTRY.length).toBe(4);
  });

  it('every shipped profile is well formed at normal process', () => {
    for (const stock of NEGATIVES) {
      expect(isWellFormed(stock.curve), stock.id).toBe(true);
      expect(() => validateCurve(stock.curve, stock.id)).not.toThrow();
    }
  });

  // Appendix A: the smallest margin in the bundle is HP5's.
  it('HP5 carries the tightest well-formedness margin', () => {
    const margins = NEGATIVES.map((n) => ({
      id: n.id,
      m: Math.min(...RECORDS.map((c) => wellFormednessMargin(n.curve, c))),
    }));
    margins.sort((a, b) => a.m - b.m);
    expect(margins[0]!.id).toBe('mono.hp5');
  });

  it('rejects a curve that violates deltaD >= 4(kt + ks)', () => {
    const bad = {
      dMin: [0.1, 0.1, 0.1] as const,
      deltaD: [0.5, 0.5, 0.5] as const,
      gamma: [0.6, 0.6, 0.6] as const,
      x0: [-2, -2, -2] as const,
      kappaT: [0.2, 0.2, 0.2] as const,
      kappaS: [0.2, 0.2, 0.2] as const,
      maskDepletion: [0, 0, 0] as const,
      balanceShift: [0, 0, 0] as const,
    };
    expect(isWellFormed(bad as never)).toBe(false);
    expect(() => validateCurve(bad as never, 'test.bad')).toThrow();
  });

  it('only Vision3 500T carries a layer balance', () => {
    for (const stock of NEGATIVES) {
      const shifted = stock.curve.balanceShift.some((v) => Math.abs(v) > 1e-9);
      expect(shifted, stock.id).toBe(stock.id.startsWith('neg.v3_500t'));
    }
  });
});

describe('sensitometry', () => {
  // V-07.
  it('the speed point inverts the curve to Dmin + 0.10', () => {
    for (const stock of NEGATIVES) {
      for (const c of RECORDS) {
        const xsp = speedPoint(stock.curve, c);
        expect(density(xsp, stock.curve, c) - stock.curve.dMin[c]).toBeCloseTo(0.1, 4);
      }
    }
  });

  // Appendix A states x0 is derived from the rated ISO via S = 0.8/10^x_sp.
  // With the speed correction applied (DEVIATIONS.md finding 2) that holds
  // exactly; without it, HP5 and Vision3 500T are 19% fast.
  it('recovers each stock’s rated ISO', () => {
    for (const stock of NEGATIVES) {
      const s = isoSpeed(stock.curve);
      expect(Math.abs(s - stock.iso) / stock.iso, `${stock.id}: got ISO ${s.toFixed(1)}`).toBeLessThan(
        0.005,
      );
    }
  });

  it('the speed correction moved x0 by less than a third of a stop', () => {
    // A larger move would mean the correction is doing something other than
    // repositioning the curve, and the fitted shape would no longer be the
    // shape Appendix A published.
    for (const stock of NEGATIVES) {
      const moved = Math.abs(stock.curve.x0[1] - stock.publishedX0);
      expect(moved, `${stock.id} moved ${moved.toFixed(4)} log E`).toBeLessThan(0.1);
    }
  });

  /**
   * §VI gives 0.55–0.62 as the contrast index of a normal-process colour
   * negative. Four of Appendix A's six colour negatives fall outside it, and
   * that is a property of the table rather than of this code: Ektar's whole
   * character is a gamma of 0.72, and Vision3's is 0.55. The band describes a
   * typical stock; the table deliberately spans wider. Recorded as
   * DEVIATIONS.md finding 3, and held here to a range that would catch a real
   * regression without asserting a claim the paper's own data contradicts.
   */
  it('every stock’s contrast index is sane for its family', () => {
    // The ideal record is excluded by name rather than by widening the band:
    // its contrast index is exactly 1 because its gamma is exactly 1, which is
    // what it exists to be. A band that admitted it would admit anything.
    const real = NEGATIVES.filter(
      (n) => n.family !== 'transparency' && n.id !== IDEAL_NEGATIVE_ID,
    );
    for (const stock of real) {
      const ci = contrastIndex(stock.curve, 1);
      expect(ci, `${stock.id}: CI ${ci.toFixed(3)}`).toBeGreaterThan(0.4);
      expect(ci, `${stock.id}: CI ${ci.toFixed(3)}`).toBeLessThan(0.75);
    }
  });

  // Exact locks, so a change to the curve maths cannot drift a stock's
  // character without a failing test naming the stock.
  it.each([
    ['neg.portra160', 0.522],
    ['neg.portra400', 0.583],
    ['neg.gold200', 0.625],
    ['neg.ektar100', 0.681],
    ['neg.superia400', 0.599],
    ['neg.v3_500t', 0.483],
    ['mono.trix400', 0.556],
    ['mono.hp5', 0.508],
  ])('%s holds its contrast index at %s', (id, expected) => {
    expect(contrastIndex(negativeById(id).curve, 1)).toBeCloseTo(expected, 3);
  });

  it('reversal stocks carry a negative contrast index', () => {
    for (const stock of NEGATIVES.filter((n) => n.family === 'transparency')) {
      expect(contrastIndex(stock.curve, 1)).toBeLessThan(0);
    }
  });
});

describe('development', () => {
  const c41 = chemistryById('chem.c41');

  it('normal process is exactly unit activity', () => {
    expect(activity(defaultRecipe().develop, c41)).toBeCloseTo(1, 9);
  });

  it('agitation efficiency is normalised at the recommended scheme', () => {
    expect(agitationEfficiency(1, c41)).toBeCloseTo(1, 12);
  });

  it('leaves gamma untouched at unit activity', () => {
    const portra = negativeById('neg.portra400').curve;
    expect(modulate(portra, 1, c41).gamma[1]).toBeCloseTo(portra.gamma[1], 9);
  });

  // Table VIII, "Modelled Push/Pull Response, Typical Color Negative".
  it.each([
    [-2, 0.55],
    [-1, 0.74],
    [0, 1.0],
    [1, 1.35],
    [2, 1.82],
    [3, 2.46],
  ])('push %s stops gives activity %s', (stops, expected) => {
    const a = activity({ ...defaultRecipe().develop, pushPull: stops }, c41);
    expect(a).toBeCloseTo(expected, 2);
  });

  it('gamma rises with activity and saturates below the ceiling', () => {
    const portra = negativeById('neg.portra400').curve;
    let previous = 0;
    for (const stops of [-2, -1, 0, 1, 2, 3]) {
      const a = activity({ ...defaultRecipe().develop, pushPull: stops }, c41);
      const g = modulate(portra, a, c41).gamma[1];
      expect(g).toBeGreaterThan(previous);
      expect(g).toBeLessThan(portra.gamma[1] * c41.gammaInfinityRatio);
      previous = g;
    }
  });

  it('fog rises fastest in the blue record', () => {
    const portra = negativeById('neg.portra400').curve;
    const pushed = modulate(portra, activity({ ...defaultRecipe().develop, pushPull: 3 }, c41), c41);
    const dR = pushed.dMin[0] - portra.dMin[0];
    const dG = pushed.dMin[1] - portra.dMin[1];
    const dB = pushed.dMin[2] - portra.dMin[2];
    expect(dB).toBeGreaterThan(dG);
    expect(dG).toBeGreaterThan(dR);
  });
});

describe('colour management', () => {
  it('the P3 to AP1 matrix inverts cleanly', () => {
    const round = matMul(matInverse(M_P3_TO_AP1), M_P3_TO_AP1);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(round[i]![j]!).toBeCloseTo(IDENTITY3[i]![j]!, 9);
      }
    }
  });

  it('white balance at the reference temperature is the identity', () => {
    const m = whiteBalanceMatrix(REFERENCE_TEMP_K, 0);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(m[i]![j]!).toBeCloseTo(IDENTITY3[i]![j]!, 6);
      }
    }
  });

  it('a warmer setting than the aim cools the render, and the reverse', () => {
    const warm = whiteBalanceMatrix(3200, 0);
    const cool = whiteBalanceMatrix(9000, 0);
    // Telling the pipeline the light was tungsten must pull blue up relative to red.
    expect(warm[2]![2]!).toBeGreaterThan(cool[2]![2]!);
    expect(warm[0]![0]!).toBeLessThan(cool[0]![0]!);
  });
});

describe('the print transfer', () => {
  it('inverting the print curve is exact for every stock', () => {
    for (const print of PRINT_STOCKS.filter((p) => !p.bypass)) {
      const curve = {
        dMin: [print.dMin, print.dMin, print.dMin] as const,
        deltaD: [print.deltaD, print.deltaD, print.deltaD] as const,
        gamma: [print.gamma, print.gamma, print.gamma] as const,
        kappaT: [print.kappaT, print.kappaT, print.kappaT] as const,
        kappaS: [print.kappaS, print.kappaS, print.kappaS] as const,
      };
      for (const c of RECORDS) {
        const target = print.aimDensity[c];
        const x = invertPrintCurve(target, curve as never, c, {
          negative: 'test',
          print: print.id,
        });
        expect(Number.isFinite(x)).toBe(true);
      }
    }
  });
});

/**
 * AC-5: §IX-C claims the computed aim balance holds across all shipping stock
 * pairs with no hand tuning of any pair. This is the most load-bearing group in
 * the suite — it exercises the curve, the mask, the crosstalk matrix, the
 * Newton inversion and the display transform at once.
 *
 * What eq. aimbalance actually claims is that a scene neutral reproduces at the
 * print's *aim density*, and Appendix A sets that to (1.09, 1.06, 1.03) — a
 * deliberate red-to-blue gradient, the standard allowance for projector lamp
 * colour temperature, and the reason a printed neutral leans very slightly
 * warm. So the print densities are what gets asserted here, not equal RGB.
 * The spec's paraphrase (V-08, "R = G = B within 1e-3") contradicts the
 * appendix it draws from; see DEVIATIONS.md finding 4.
 */
describe('aim balance across every stock pair', () => {
  const pairs: [string, string][] = [];
  for (const n of NEGATIVES) {
    for (const p of PRINT_STOCKS) {
      if (!p.bypass) pairs.push([n.id, p.id]);
    }
  }

  function neutralPrintDensity(negativeId: string, printId: string) {
    const recipe: Recipe = {
      ...defaultRecipe(),
      negativeId,
      printId,
      chemistryId: negativeById(negativeId).chemistryId,
      // The aim balance is the model's guarantee, and this suite tests it.
      printEngine: 'model',
    };
    const p = resolve(recipe, ctx);
    expect(p.warnings).toEqual([]);
    // The layer balance is a property of the illuminant the stock was shot
    // under, not of the lab, so the aim balance excludes it — which is exactly
    // why a tungsten stock keeps its cast through printing. `printDensitiesFrom`
    // takes the log exposure the curve sees, i.e. after stage 1, so the balance
    // is simply absent here rather than cancelled.
    const neutralLogE = p.anchorShift + Math.log10(0.18);
    return { p, printed: printDensitiesFrom([neutralLogE, neutralLogE, neutralLogE], p) };
  }

  it.each(pairs)('%s on %s reproduces the aim density', (negativeId, printId) => {
    const { p, printed } = neutralPrintDensity(negativeId, printId);
    for (const c of RECORDS) {
      expect(
        printed[c],
        `${negativeId}/${printId} record ${c}: D' = ${printed[c].toFixed(4)}`,
      ).toBeCloseTo(p.print.aimDensity[c], 3);
    }
  });

  it('the residual warmth is exactly what the aim gradient predicts', () => {
    // 0.03 more red density than green, carried through the display transform.
    const p = resolve({ ...defaultRecipe(), printEngine: 'model' }, ctx);
    const out = evaluateSceneLinear([0.18, 0.18, 0.18], p);
    const predicted = (d: number) => {
      const dMax = p.printCurve.dMin[1] + p.printCurve.deltaD[1];
      const lo = Math.pow(10, -dMax);
      const hi = Math.pow(10, -p.printCurve.dMin[1]);
      return (Math.pow(10, -d) - lo) / (hi - lo);
    };
    expect(out[0]).toBeCloseTo(predicted(p.print.aimDensity[0]), 3);
    expect(out[1]).toBeCloseTo(predicted(p.print.aimDensity[1]), 3);
    expect(out[2]).toBeCloseTo(predicted(p.print.aimDensity[2]), 3);
    // Warm: less red light than green, more blue... which is to say the print
    // leans warm in density and therefore cool-to-neutral in light. The point
    // is that it is a *stated* offset, not an accident.
    expect(out[0]).toBeLessThan(out[1]);
    expect(out[1]).toBeLessThan(out[2]);
  });
});

/** Print densities for a given film log exposure, for the aim-balance tests. */
function printDensitiesFrom(
  x: [number, number, number],
  p: ReturnType<typeof resolve>,
): [number, number, number] {
  const D = densityWithMask(x, p.curve);
  const dEff = [
    p.crosstalk[0][0] * D[0] + p.crosstalk[0][1] * D[1] + p.crosstalk[0][2] * D[2],
    p.crosstalk[1][0] * D[0] + p.crosstalk[1][1] * D[1] + p.crosstalk[1][2] * D[2],
    p.crosstalk[2][0] * D[0] + p.crosstalk[2][1] * D[1] + p.crosstalk[2][2] * D[2],
  ];
  return ([0, 1, 2] as const).map((c) =>
    printDensityAt(p.printExposureOffset[c] - dEff[c]!, p.printCurve, c),
  ) as [number, number, number];
}

describe('the chain end to end', () => {
  // The model, pinned: this suite holds the calculated chain against the
  // document, and the engine default is the measurement.
  const base: Recipe = { ...defaultRecipe(), printEngine: 'model' };

  it('is monotone in scene exposure', () => {
    const p = resolve(base, ctx);
    let previous = -Infinity;
    for (let stops = -6; stops <= 6; stops += 0.25) {
      const e = 0.18 * Math.pow(2, stops);
      const y = evaluateSceneLinear([e, e, e], p)[1];
      expect(y).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = y;
    }
  });

  it('lands inside the display range across twelve stops', () => {
    const p = resolve(base, ctx);
    for (let stops = -6; stops <= 6; stops += 0.5) {
      const e = 0.18 * Math.pow(2, stops);
      const y = evaluateSceneLinear([e, e, e], p);
      for (const c of RECORDS) {
        expect(Number.isFinite(y[c])).toBe(true);
        expect(y[c]).toBeGreaterThanOrEqual(-1e-6);
        expect(y[c]).toBeLessThanOrEqual(1.05);
      }
    }
  });

  it('never produces a non-finite value, whatever the input', () => {
    const p = resolve(base, ctx);
    for (const e of [0, 1e-12, 1e-7, 1e6, 1e12]) {
      const y = evaluateSceneLinear([e, e, e], p);
      for (const c of RECORDS) expect(Number.isFinite(y[c]), `E = ${e}`).toBe(true);
    }
  });

  it('the tungsten stock casts blue when the scene was daylight', () => {
    const daylight = resolve({ ...base, negativeId: 'neg.v3_500t', printId: 'prt.2383' }, ctx);
    const out = evaluateSceneLinear([0.18, 0.18, 0.18], daylight);
    // The layer balance is excluded from the aim balance on purpose, so the
    // cast survives printing rather than being silently corrected away.
    expect(out[2]).toBeGreaterThan(out[0]);
    expect(daylight.balanceShift[2]).toBeCloseTo(0.04, 6);
  });

  /**
   * The layer balance is the difference between the stock's aim illuminant and
   * D55, so declaring the scene to have been tungsten must take it to zero —
   * the same thing an 85B on the camera, or simply shooting under the light the
   * stock was made for, would do.
   */
  it('the tungsten cast vanishes when the scene is declared tungsten', () => {
    const matched = resolve(
      {
        ...base,
        negativeId: 'neg.v3_500t',
        capture: { ...base.capture, whiteBalanceTempK: 3200 },
      },
      ctx,
    );
    for (const c of RECORDS) expect(matched.balanceShift[c]).toBeCloseTo(0, 9);
  });

  it('the layer balance interpolates on mired between the two illuminants', () => {
    // 4000 K sits 48% of the way from 3200 K to 5500 K in mired.
    const half = resolve(
      {
        ...base,
        negativeId: 'neg.v3_500t',
        capture: { ...base.capture, whiteBalanceTempK: 4000 },
      },
      ctx,
    );
    expect(half.balanceShift[2] / 0.04).toBeCloseTo(0.478, 2);
  });

  it('a daylight stock has no layer balance at any white balance', () => {
    for (const k of [2000, 3200, 5500, 9000, 12000]) {
      const p = resolve(
        { ...base, capture: { ...base.capture, whiteBalanceTempK: k } },
        ctx,
      );
      for (const c of RECORDS) expect(p.balanceShift[c]).toBe(0);
    }
  });

  // §XI: the cast a tungsten stock produces changes character with luminance
  // rather than being a uniform tint, because blue is driven up its curve while
  // red sits in its toe.
  it('the tungsten cast varies with scene luminance', () => {
    const p = resolve({ ...base, negativeId: 'neg.v3_500t' }, ctx);
    const shadow = evaluateSceneLinear([0.02, 0.02, 0.02], p);
    const highlight = evaluateSceneLinear([1.2, 1.2, 1.2], p);
    const shadowCast = shadow[2] - shadow[0];
    const highlightCast = highlight[2] - highlight[0];
    expect(Math.abs(shadowCast - highlightCast)).toBeGreaterThan(1e-3);
  });

  it('bleach bypass raises contrast and drops saturation', () => {
    const plain = resolve(base, ctx);
    const bypassed = resolve(
      { ...base, printing: { ...base.printing, silverRetention: 1 } },
      ctx,
    );
    const saturated: [number, number, number] = [0.5, 0.12, 0.1];
    const a = evaluateSceneLinear(saturated, plain);
    const b = evaluateSceneLinear(saturated, bypassed);
    const spread = (v: readonly number[]) => Math.max(...v) - Math.min(...v);
    expect(spread(b)).toBeLessThan(spread(a));
  });

  it('a reversal stock produces a positive image', () => {
    const p = resolve({ ...base, negativeId: 'rev.velvia50', printId: 'prt.bypass', chemistryId: 'chem.e6' }, ctx);
    const dark = evaluateSceneLinear([0.02, 0.02, 0.02], p)[1];
    const bright = evaluateSceneLinear([1.0, 1.0, 1.0], p)[1];
    expect(bright).toBeGreaterThan(dark);
  });

  it('printer lights move the print in the direction the sign convention promises', () => {
    const p0 = resolve(base, ctx);
    const warmer = resolve(
      { ...base, printing: { ...base.printing, printerLightR: 6 } },
      ctx,
    );
    const a = evaluateSceneLinear([0.18, 0.18, 0.18], p0);
    const b = evaluateSceneLinear([0.18, 0.18, 0.18], warmer);
    // More red printing light means more red exposure on the print, which for a
    // negative-positive system means *less* red in the result.
    expect(b[0]).toBeLessThan(a[0]);
    expect(b[1]).toBeCloseTo(a[1], 6);
  });

  it('print density darkens the print without moving the film', () => {
    const p0 = resolve(base, ctx);
    const denser = resolve({ ...base, printing: { ...base.printing, printDensity: 12 } }, ctx);
    const a = evaluateSceneLinear([0.18, 0.18, 0.18], p0)[1];
    const b = evaluateSceneLinear([0.18, 0.18, 0.18], denser)[1];
    expect(b).toBeLessThan(a);
    expect(denser.anchorShift).toBeCloseTo(p0.anchorShift, 12);
  });

  it('a determinate recipe resolves determinately', () => {
    const a = resolve(base, ctx);
    const b = resolve(structuredClone(base), ctx);
    expect(a.printExposureOffset).toEqual(b.printExposureOffset);
    expect(a.anchorShift).toBe(b.anchorShift);
    expect(a.curve).toEqual(b.curve);
  });
});
