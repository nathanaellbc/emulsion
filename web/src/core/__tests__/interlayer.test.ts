/**
 * Interlayer inhibition (§VIII).
 *
 * The operator is spatial, so the properties worth asserting are properties of
 * a field rather than of a scalar: that it annihilates constants (which is what
 * makes it non-double-counting against a characteristic curve fitted to a real
 * film), that its edge response has the polarity the Eberhard effect has, and
 * that its cross-channel terms move the records the way the layer stack says.
 */

import { describe, expect, it } from 'vitest';
import {
  DIR_MATRIX_COLOR_NEGATIVE,
  REVERSAL_INHIBITION_SCALE,
  activityWeight,
  gaussianBlurField,
  inhibit,
  interlayerField,
  scaleCoupling,
  twoScaleHighpass,
  type DensityField,
  type InterlayerResolved,
} from '../interlayer';
import { pointGamma } from '../curve';
import { negativeById } from '../profiles/negatives';
import { defaultRecipe } from '../recipe';
import { resolve } from '../resolve';
import { IDENTITY3, type Matrix3 } from '../triple';

const ctx = { renderWidthPx: 2048, sourceSpace: 'linearAP1' } as const;

/** A field of constant density, as a starting point every test perturbs. */
function uniformField(width: number, height: number, value: number): DensityField {
  const data = new Float64Array(width * height * 3);
  data.fill(value);
  return { width, height, data };
}

function at(f: DensityField, x: number, y: number): [number, number, number] {
  const i = (y * f.width + x) * 3;
  return [f.data[i]!, f.data[i + 1]!, f.data[i + 2]!];
}

function set(f: DensityField, x: number, y: number, v: readonly number[]): void {
  const i = (y * f.width + x) * 3;
  f.data[i] = v[0]!;
  f.data[i + 1] = v[1]!;
  f.data[i + 2] = v[2]!;
}

/** A vertical step: `lo` on the left half, `hi` on the right. */
function stepField(width: number, height: number, lo: readonly number[], hi: readonly number[]) {
  const f = uniformField(width, height, 0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) set(f, x, y, x < width / 2 ? lo : hi);
  }
  return f;
}

const RESOLVED: InterlayerResolved = {
  coupling: DIR_MATRIX_COLOR_NEGATIVE,
  sigma1Px: 1.5,
  sigma2Px: 7.5,
  w1: 0.65,
  w2: 0.35,
  mu: 1,
  enabled: true,
};

describe('the two-scale highpass', () => {
  it('is zero where the field equals both of its blurs', () => {
    const H = twoScaleHighpass([1.2, 1.2, 1.2], [1.2, 1.2, 1.2], [1.2, 1.2, 1.2], 0.65, 0.35);
    expect(H).toEqual([0, 0, 0]);
  });

  it('weights the two scales by w1 and w2', () => {
    // D - b1 = 0.1 on red, D - b2 = 0.2: 0.65*0.1 + 0.35*0.2 = 0.135.
    const H = twoScaleHighpass([1.0, 1.0, 1.0], [0.9, 1.0, 1.0], [0.8, 1.0, 1.0], 0.65, 0.35);
    expect(H[0]).toBeCloseTo(0.135, 12);
    expect(H[1]).toBeCloseTo(0, 12);
  });
});

describe('the activity weight', () => {
  const curve = negativeById('neg.portra400').curve;

  it('vanishes far below the toe, where nothing is developing', () => {
    const lambda = activityWeight([-8, -8, -8], curve, 1);
    expect(lambda[1]).toBeLessThan(1e-3);
  });

  it('vanishes far above the shoulder, where development has run out', () => {
    const lambda = activityWeight([6, 6, 6], curve, 1);
    expect(lambda[1]).toBeLessThan(1e-3);
  });

  it('is the normalised point gamma on the straight line', () => {
    // Midpoint of the straight line, where point gamma is at its plateau.
    const xMid = curve.x0[1] + curve.deltaD[1] / 2 / curve.gamma[1];
    const lambda = activityWeight([xMid, xMid, xMid], curve, 1);
    expect(lambda[1]).toBeCloseTo(pointGamma(xMid, curve, 1) / curve.gamma[1], 12);
    expect(lambda[1]).toBeGreaterThan(0.98);
  });

  it('is positive for a reversal stock, whose gamma and point gamma are both negative', () => {
    const velvia = negativeById('rev.velvia50').curve;
    const xMid = velvia.x0[1] + velvia.deltaD[1] / 2 / velvia.gamma[1];
    expect(activityWeight([xMid, xMid, xMid], velvia, 1)[1]).toBeGreaterThan(0.98);
  });

  it('raises mu as an exponent, so mu > 1 narrows the active band', () => {
    const x = curve.x0[1] + 0.2;
    const base = activityWeight([x, x, x], curve, 1)[1];
    const sharp = activityWeight([x, x, x], curve, 2)[1];
    expect(sharp).toBeCloseTo(base * base, 12);
  });
});

describe('the inhibition operator', () => {
  it('leaves density untouched where the highpass is zero', () => {
    const D = [0.8, 1.1, 1.4] as const;
    expect(inhibit(D, [0, 0, 0], [1, 1, 1], DIR_MATRIX_COLOR_NEGATIVE)).toEqual([0.8, 1.1, 1.4]);
  });

  it('couples the green residual into red and blue with the published weights', () => {
    const out = inhibit([1, 1, 1], [0, 0.1, 0], [1, 1, 1], DIR_MATRIX_COLOR_NEGATIVE);
    expect(out[0] - 1).toBeCloseTo(0.1 * DIR_MATRIX_COLOR_NEGATIVE[0][1]!, 12);
    expect(out[1] - 1).toBeCloseTo(0.1 * DIR_MATRIX_COLOR_NEGATIVE[1][1]!, 12);
    expect(out[2] - 1).toBeCloseTo(0.1 * DIR_MATRIX_COLOR_NEGATIVE[2][1]!, 12);
  });

  it('scales with the activity weight, so a dead toe receives nothing', () => {
    const live = inhibit([1, 1, 1], [0.1, 0.1, 0.1], [1, 1, 1], DIR_MATRIX_COLOR_NEGATIVE);
    const dead = inhibit([1, 1, 1], [0.1, 0.1, 0.1], [0, 0, 0], DIR_MATRIX_COLOR_NEGATIVE);
    expect(dead).toEqual([1, 1, 1]);
    expect(live[1]).toBeGreaterThan(1);
  });
});

describe('the coupling matrix', () => {
  it("ships the paper's matrix for a colour negative", () => {
    expect(DIR_MATRIX_COLOR_NEGATIVE).toEqual([
      [0.42, 0.26, 0.05],
      [0.19, 0.48, 0.19],
      [0.05, 0.29, 0.38],
    ]);
  });

  it('couples red and blue to green more strongly than to each other', () => {
    const A = DIR_MATRIX_COLOR_NEGATIVE;
    expect(A[0][1]!).toBeGreaterThan(A[0][2]!);
    expect(A[2][1]!).toBeGreaterThan(A[2][0]!);
  });

  it('scales uniformly with coupler activity, and vanishes at zero', () => {
    const half = scaleCoupling(DIR_MATRIX_COLOR_NEGATIVE, 0.5);
    expect(half[1][1]!).toBeCloseTo(0.24, 12);
    expect(scaleCoupling(DIR_MATRIX_COLOR_NEGATIVE, 0)[1][1]!).toBe(0);
  });

  it('gives a monochrome stock a scalar with no cross terms', () => {
    const mono = negativeById('mono.trix400').interlayer.coupling;
    expect(mono[0][1]).toBe(0);
    expect(mono[1][0]).toBe(0);
    expect(mono[1][1]).toBeGreaterThan(0);
  });

  it('gives a transparency substantially weaker inhibition', () => {
    const velvia = negativeById('rev.velvia50').interlayer.coupling;
    expect(velvia[1][1]!).toBeCloseTo(
      DIR_MATRIX_COLOR_NEGATIVE[1][1]! * REVERSAL_INHIBITION_SCALE,
      12,
    );
  });
});

describe('the operator over a field', () => {
  it('leaves a uniform field exactly unchanged', () => {
    const D = uniformField(32, 8, 1.15);
    const out = interlayerField(D, uniformField(32, 8, 1), RESOLVED);
    for (let i = 0; i < out.data.length; i++) expect(out.data[i]!).toBeCloseTo(1.15, 12);
  });

  it('preserves the mean of a field whose borders are flat', () => {
    const D = stepField(64, 4, [1.0, 1.0, 1.0], [1.6, 1.6, 1.6]);
    const out = interlayerField(D, uniformField(64, 4, 1), RESOLVED);
    const mean = (f: DensityField) => f.data.reduce((a, b) => a + b, 0) / f.data.length;
    expect(mean(out)).toBeCloseTo(mean(D), 6);
  });

  it('raises density on the dense side of an edge and lowers it on the light side', () => {
    const D = stepField(64, 4, [1.0, 1.0, 1.0], [1.6, 1.6, 1.6]);
    const out = interlayerField(D, uniformField(64, 4, 1), RESOLVED);
    // Immediately across the seam at x = 32.
    expect(at(out, 32, 2)[1]).toBeGreaterThan(1.6);
    expect(at(out, 31, 2)[1]).toBeLessThan(1.0);
    // And far from it, nothing happens: this is an edge effect, not a gain.
    expect(at(out, 2, 2)[1]).toBeCloseTo(1.0, 6);
    expect(at(out, 61, 2)[1]).toBeCloseTo(1.6, 6);
  });

  it('carries a green edge into the red record — the inter-image effect', () => {
    const D = stepField(64, 4, [1.2, 1.0, 1.2], [1.2, 1.6, 1.2]);
    const out = interlayerField(D, uniformField(64, 4, 1), RESOLVED);
    const dense = at(out, 32, 2);
    const light = at(out, 31, 2);
    // Red is flat in the input, so anything it does here came out of green.
    expect(dense[0]).toBeGreaterThan(1.2);
    expect(light[0]).toBeLessThan(1.2);
    // In the ratio the matrix states: a_RG / a_GG.
    const ratio = (dense[0] - 1.2) / (dense[1] - 1.6);
    expect(ratio).toBeCloseTo(
      DIR_MATRIX_COLOR_NEGATIVE[0][1]! / DIR_MATRIX_COLOR_NEGATIVE[1][1]!,
      6,
    );
  });

  it('does nothing at all when the coupling is zero', () => {
    const D = stepField(32, 4, [1.0, 1.0, 1.0], [1.6, 1.6, 1.6]);
    const off: InterlayerResolved = { ...RESOLVED, coupling: scaleCoupling(RESOLVED.coupling, 0) };
    const out = interlayerField(D, uniformField(32, 4, 1), off);
    for (let i = 0; i < out.data.length; i++) expect(out.data[i]!).toBeCloseTo(D.data[i]!, 12);
  });
});

describe('the host Gaussian', () => {
  it('preserves a constant, so the highpass it feeds annihilates one', () => {
    const f = uniformField(16, 16, 0.7);
    const b = gaussianBlurField(f, 3);
    for (let i = 0; i < b.data.length; i++) expect(b.data[i]!).toBeCloseTo(0.7, 12);
  });

  it('spreads an impulse symmetrically', () => {
    const f = uniformField(33, 1, 0);
    set(f, 16, 0, [1, 1, 1]);
    const b = gaussianBlurField(f, 2);
    expect(at(b, 15, 0)[0]).toBeCloseTo(at(b, 17, 0)[0], 12);
    expect(at(b, 16, 0)[0]).toBeGreaterThan(at(b, 15, 0)[0]);
  });
});

describe('interlayer resolution', () => {
  const recipe = defaultRecipe();

  it('converts the diffusion lengths from micrometres at the film plane to pixels', () => {
    const r = resolve(recipe, ctx);
    const pitchUm = (36.0 * 1000) / 2048;
    const stock = negativeById(recipe.negativeId).interlayer;
    expect(r.interlayer.sigma1Px).toBeCloseTo(stock.sigma1um / pitchUm, 9);
    expect(r.interlayer.sigma2Px).toBeCloseTo((stock.sigma1um * stock.zeta) / pitchUm, 9);
  });

  it('holds the effect at a fixed physical size as the render widens', () => {
    const small = resolve(recipe, { ...ctx, renderWidthPx: 1024 });
    const large = resolve(recipe, { ...ctx, renderWidthPx: 2048 });
    expect(large.interlayer.sigma1Px).toBeCloseTo(small.interlayer.sigma1Px * 2, 9);
  });

  it('scales the coupling by coupler activity', () => {
    const doubled = resolve(
      { ...recipe, interlayer: { couplerActivity: 2 } },
      ctx,
    );
    const nominal = resolve(recipe, ctx);
    expect(doubled.interlayer.coupling[1][1]!).toBeCloseTo(
      nominal.interlayer.coupling[1][1]! * 2,
      12,
    );
  });

  it('turns the stage off when coupler activity reaches zero', () => {
    expect(resolve({ ...recipe, interlayer: { couplerActivity: 0 } }, ctx).interlayer.enabled).toBe(
      false,
    );
  });

  it('lengthens the broad scale and strengthens it as agitation falls', () => {
    const still = resolve({ ...recipe, develop: { ...recipe.develop, agitation: 0.4 } }, ctx);
    const brisk = resolve({ ...recipe, develop: { ...recipe.develop, agitation: 1.6 } }, ctx);
    expect(still.interlayer.sigma2Px).toBeGreaterThan(brisk.interlayer.sigma2Px);
    expect(still.interlayer.w2).toBeGreaterThan(brisk.interlayer.w2);
    expect(still.interlayer.w1 + still.interlayer.w2).toBeCloseTo(1, 12);
    expect(brisk.interlayer.w1 + brisk.interlayer.w2).toBeCloseTo(1, 12);
  });

  it('leaves the short scale alone — agitation moves the inhibitor, not the layer', () => {
    const still = resolve({ ...recipe, develop: { ...recipe.develop, agitation: 0.4 } }, ctx);
    const brisk = resolve({ ...recipe, develop: { ...recipe.develop, agitation: 1.6 } }, ctx);
    expect(still.interlayer.sigma1Px).toBeCloseTo(brisk.interlayer.sigma1Px, 12);
  });
});

describe('interlayer against the identity', () => {
  it('is not the identity matrix in disguise', () => {
    expect(DIR_MATRIX_COLOR_NEGATIVE as Matrix3).not.toEqual(IDENTITY3);
  });
});
