/**
 * Reproduction tests for two reported defects, written to FAIL before the fix
 * and PASS after it (TDD Prove-It). Both are about how the exposure anchor and
 * the layer balance treat stocks whose physics differ from a colour negative.
 */
import { describe, expect, it } from 'vitest';
import { evaluateSceneLinear } from '../chain';
import { defaultRecipe } from '../recipe';
import { resolve } from '../resolve';
import { negativeById } from '../profiles/negatives';

const ctx = { renderWidthPx: 2048, sourceSpace: 'linearAP1' } as const;
const GREY: [number, number, number] = [0.18, 0.18, 0.18];

function midGreyOut(negativeId: string) {
  const r = defaultRecipe();
  r.negativeId = negativeId;
  r.printId = negativeById(negativeId).defaultPrint;
  return evaluateSceneLinear(GREY, resolve(r, ctx));
}

describe('reversal stocks must not render mid-grey as clipped white', () => {
  it.each(['rev.velvia50', 'rev.provia100'])('%s: 18%% grey lands on the straight line, not the shoulder', (id) => {
    const out = midGreyOut(id);
    // A correctly exposed transparency puts 18% grey near the middle of its
    // density range, which after the bypass display transform is roughly
    // 0.4–0.65 in sRGB — not 1.0 (blown). >5 stops over is the reported bug.
    expect(out[1]).toBeLessThan(0.8);
  });
});

describe('a tungsten stock in daylight shows a cast, not a filter', () => {
  it('Vision3 500T in daylight: blue exceeds red but red is not driven to black', () => {
    const out = midGreyOut('neg.v3_500t');
    // The real stock does go blue in daylight — that is correct and kept. But
    // the reported "through a blue filter" is the red channel near zero. A
    // physical cast keeps red within a couple of stops of green, not 12x down.
    expect(out[2]).toBeGreaterThan(out[0]); // still blue-ish: the cast stays
    expect(out[0]).toBeGreaterThan(0.05); // but red is alive, not crushed
    // The cast ratio should be stops, not an order of magnitude.
    expect(out[2] / Math.max(out[0], 1e-6)).toBeLessThan(4);
  });
});
