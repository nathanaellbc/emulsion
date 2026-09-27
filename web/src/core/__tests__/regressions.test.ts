/**
 * Regressions for the defects recorded in DEVIATIONS.md findings 16–18: each
 * test here failed before its fix.
 */

import { describe, expect, it } from 'vitest';
import { clampRecipe, defaultRecipe, mergeRecipe, FRAME_WIDTH_MM, type Recipe } from '../recipe';
import { resolve, sourceLuminance } from '../resolve';
import { evaluateSceneLinear } from '../chain';
import { evaluateSceneLinearWithEngine } from '../engine';
import { recombineHalation } from '../halation';
import { floatToHalf, halfToFloat } from '../half';
import { AP1_LUMINANCE, M_P3_TO_AP1, M_SRGB_TO_AP1 } from '../colorspace';
import type { Triple } from '../triple';

const ctx = { renderWidthPx: 2048, sourceSpace: 'linearAP1' } as const;
const GREY: Triple = [0.18, 0.18, 0.18];

function recipe(mutate: (r: Recipe) => void = () => {}): Recipe {
  const r = defaultRecipe();
  mutate(r);
  return r;
}

describe('a measured engine without its table', () => {
  it('falls back to an illuminant the stock was measured under', () => {
    // 2383 at D55, then switched to 2393, which exists only at D65.
    const p = resolve(recipe((r) => { r.printId = 'prt.2393'; r.printIlluminant = 'D55'; }), ctx);
    expect(p.printEngine).toBe('lut');
    expect(p.printLut!.illuminant).toBe('D65');
  });

  it('renders the balanced model, not paper white, while the table is missing', () => {
    for (const printId of ['prt.2383', 'prt.2393', 'prt.3513']) {
      const lutP = resolve(recipe((r) => { r.printId = printId; }), ctx);
      const modelP = resolve(recipe((r) => { r.printId = printId; r.printEngine = 'model'; }), ctx);
      const fallback = evaluateSceneLinearWithEngine(GREY, lutP, null);
      const model = evaluateSceneLinearWithEngine(GREY, modelP, null);
      for (let c = 0; c < 3; c++) {
        expect(fallback[c]).toBeLessThan(0.5);
        expect(fallback[c]).toBeCloseTo(model[c]!, 9);
      }
    }
  });

  it('keeps the model offset balanced under either engine choice', () => {
    const lutP = resolve(recipe(), ctx);
    const modelP = resolve(recipe((r) => { r.printEngine = 'model'; }), ctx);
    expect(lutP.modelPrintExposureOffset).toEqual(modelP.printExposureOffset);
  });
});

describe('halation recombination', () => {
  const weight: Triple = [0.15, 0.063, 0.033];

  it('leaves a pixel below threshold untouched when no halo reaches it', () => {
    const out = recombineHalation(GREY, 0, [0, 0, 0], weight);
    expect(out).toEqual(GREY);
  });

  it('is the paper form exactly when the whole pixel scatters (S = Y)', () => {
    const e: Triple = [3, 2, 1];
    const y = AP1_LUMINANCE[0] * 3 + AP1_LUMINANCE[1] * 2 + AP1_LUMINANCE[2] * 1;
    const halo: Triple = [0.4, 0.3, 0.2];
    const out = recombineHalation(e, y, halo, weight);
    for (let c = 0; c < 3; c++) {
      expect(out[c]).toBeCloseTo((1 - weight[c]!) * e[c]! + weight[c]! * halo[c]!, 12);
    }
  });

  it('keeps the chromaticity of the direct light it removes', () => {
    const e: Triple = [4, 2, 1];
    const out = recombineHalation(e, 1, [0, 0, 0], [0.2, 0.2, 0.2]);
    expect(out[0] / out[1]).toBeCloseTo(2, 12);
    expect(out[1] / out[2]).toBeCloseTo(2, 12);
  });
});

describe('the neutral axis', () => {
  /** Red over blue of a display triple: rises as the image warms. */
  const warmth = (y: Triple) => y[0] / y[2];
  const at = (scene: number, warm: number, tint = 0) =>
    evaluateSceneLinear(
      [scene, scene, scene],
      resolve(recipe((r) => {
        r.printEngine = 'model';
        r.printing.neutralAxisWarm = warm;
        r.printing.neutralAxisTint = tint;
      }), ctx),
    );

  it('positive warm warms the shadows and cools the highlights', () => {
    // A deep shadow and a bright highlight, both still inside the print's
    // range (ψ > 0 and ψ < 0 respectively).
    expect(warmth(at(0.03, 0.1))).toBeGreaterThan(warmth(at(0.03, 0)));
    expect(warmth(at(1.2, 0.1))).toBeLessThan(warmth(at(1.2, 0)));
  });

  it('positive tint greens the shadows and turns the highlights magenta', () => {
    const green = (y: Triple) => y[1] / (0.5 * (y[0] + y[2]));
    expect(green(at(0.03, 0, 0.1))).toBeGreaterThan(green(at(0.03, 0, 0)));
    expect(green(at(1.2, 0, 0.1))).toBeLessThan(green(at(1.2, 0, 0)));
  });
});

describe('physical scale', () => {
  it('does not depend on which way the camera was held', () => {
    const land = resolve(defaultRecipe(), { renderWidthPx: 2048, renderHeightPx: 1365, sourceSpace: 'srgb' });
    const port = resolve(defaultRecipe(), { renderWidthPx: 1365, renderHeightPx: 2048, sourceSpace: 'srgb' });
    expect(port.grain.sigmaRef).toBeCloseTo(land.grain.sigmaRef, 12);
    expect(port.halation.lengthPx).toEqual(land.halation.lengthPx);
    expect(port.glow.sigma1Px).toBeCloseTo(land.glow.sigma1Px, 12);
  });

  it('uses the long edge of every frame', () => {
    expect(FRAME_WIDTH_MM.format45).toBeGreaterThan(115);
    expect(FRAME_WIDTH_MM.standard8).toBeLessThan(6);
  });
});

describe('recipe hygiene', () => {
  it('turns a non-rating or a non-process into the default, not NaN', () => {
    const r = clampRecipe(recipe((x) => {
      x.capture.filmSpeedOverride = 0;
      x.develop.temperatureK = 0;
      x.develop.timeSeconds = Number.NaN;
    }));
    expect(r.capture.filmSpeedOverride).toBe(1);
    expect(r.develop.temperatureK).toBeCloseTo(283.15, 9);
    expect(r.develop.timeSeconds).toBeNull();
    const p = resolve(r, ctx);
    expect(Number.isFinite(p.anchorShift)).toBe(true);
    expect(Number.isFinite(p.developmentActivity)).toBe(true);
  });

  it('fills fields a stored recipe predates from the defaults', () => {
    const stored = { develop: { pushPull: 1 } } as unknown as Partial<Recipe>;
    const r = clampRecipe(mergeRecipe(defaultRecipe(), stored));
    expect(r.develop.pushPull).toBe(1);
    expect(r.develop.agitation).toBe(1);
    const y = evaluateSceneLinear(GREY, resolve({ ...r, printEngine: 'model' }, ctx));
    for (const v of y) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('source luminance', () => {
  it('weights a white in every encoding as unit luminance', () => {
    for (const space of ['srgb', 'displayP3', 'acesAP0', 'linearAP1'] as const) {
      const w = sourceLuminance(space);
      expect(w[0] + w[1] + w[2]).toBeCloseTo(1, 2);
    }
  });

  it('weights sRGB primaries as sRGB, not as AP1', () => {
    const w = sourceLuminance('srgb');
    expect(w[0]).toBeCloseTo(0.2126, 2);
    expect(w[1]).toBeCloseTo(0.7152, 2);
    expect(w[2]).toBeCloseTo(0.0722, 2);
  });
});

describe('the input matrices', () => {
  it('carry the published sRGB → ACEScg (Bradford) matrix', () => {
    // The ACES reference value, to four places.
    const ref = [
      [0.6131, 0.3395, 0.0474],
      [0.0702, 0.9164, 0.0135],
      [0.0206, 0.1096, 0.8698],
    ];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) expect(M_SRGB_TO_AP1[i]![j]).toBeCloseTo(ref[i]![j]!, 3);
    }
  });

  it('map the D65 white of P3 and sRGB onto the ACES white', () => {
    for (const m of [M_P3_TO_AP1, M_SRGB_TO_AP1]) {
      for (const row of m) expect(row[0] + row[1] + row[2]).toBeCloseTo(1, 3);
    }
  });
});

describe('half-float upload', () => {
  it('rounds to nearest, ties to even', () => {
    for (const v of [0, 0.026593, 0.1, 0.33333, 0.5, 0.7777, 0.999, 1, 1e-5, 6e-8]) {
      const h = halfToFloat(floatToHalf(v));
      // Round-to-nearest is within half an ulp; truncation was up to a whole one.
      const ulp = v >= 6.103515625e-5 ? Math.pow(2, Math.floor(Math.log2(v)) - 10) : Math.pow(2, -24);
      expect(Math.abs(h - v)).toBeLessThanOrEqual(ulp / 2 + 1e-12);
    }
    expect(floatToHalf(1)).toBe(0x3c00);
    expect(floatToHalf(-2)).toBe(0xc000);
  });
});

describe('the export file name', () => {
  it('is plain ASCII, so the browser keeps it', async () => {
    const { exportFileName } = await import('../../io/export');
    const name = exportFileName('Café — été.jpg', 'Portra 400', 'Vision 2383 · D65', 'png');
    expect(name).toMatch(/^[\x20-\x7e]+$/);
    expect(name).toBe('Cafe - ete - Portra 400 on Vision 2383 - D65.png');
  });
});
