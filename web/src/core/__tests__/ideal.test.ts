/**
 * The stock-less negative.
 *
 * "None — ideal negative" is a profile, not a mode: a straight line of gamma 1
 * with no toe, no shoulder, no fog and no orange mask, so that everything left
 * in the picture is the print stock and the exposure. What it asserts here is
 * mostly that it is *not* film — the properties every real stock in the bundle
 * has, this one deliberately lacks.
 */

import { describe, expect, it } from 'vitest';
import { density, pointGamma, validateCurve } from '../curve';
import { contrastIndex, latitude } from '../sensitometry';
import { IDEAL_NEGATIVE_ID, negativeById } from '../profiles/negatives';
import { defaultRecipe } from '../recipe';
import { resolve } from '../resolve';
import { RECORDS } from '../triple';

const ctx = { renderWidthPx: 2048, sourceSpace: 'linearAP1' } as const;
const ideal = negativeById(IDEAL_NEGATIVE_ID);

describe('the ideal negative', () => {
  it('has unit gamma on every record', () => {
    for (const c of RECORDS) expect(ideal.curve.gamma[c]).toBe(1);
  });

  it('carries no fog and no orange mask', () => {
    for (const c of RECORDS) {
      expect(ideal.curve.dMin[c]).toBe(0);
      expect(ideal.curve.maskDepletion[c]).toBe(0);
    }
  });

  it('puts all three records on the same curve, so it has no crossover', () => {
    for (const c of RECORDS) {
      expect(ideal.curve.x0[c]).toBeCloseTo(ideal.curve.x0[1], 12);
      expect(ideal.curve.deltaD[c]).toBeCloseTo(ideal.curve.deltaD[1], 12);
    }
  });

  it('is exactly linear in log exposure through its whole range', () => {
    const x0 = ideal.curve.x0[1];
    for (let x = x0 + 0.2; x < x0 + 3.0; x += 0.1) {
      expect(pointGamma(x, ideal.curve, 1)).toBeCloseTo(1, 6);
      expect(density(x, ideal.curve, 1)).toBeCloseTo(x - x0, 5);
    }
  });

  it('clips rather than rolling off, which is the point of it', () => {
    const x0 = ideal.curve.x0[1];
    // Half a decade under the straight line, a real stock is still on its toe.
    expect(density(x0 - 0.5, ideal.curve, 1)).toBeLessThan(1e-4);
    expect(pointGamma(x0 - 0.5, ideal.curve, 1)).toBeLessThan(1e-4);
    const portra = negativeById('neg.portra400').curve;
    const toeGamma = pointGamma(portra.x0[1] - 0.5, portra, 1);
    expect(toeGamma).toBeGreaterThan(0.01);
  });

  it('spans the latitude of a real negative rather than an arbitrary range', () => {
    expect(latitude(ideal.curve, 1)).toBeGreaterThan(10);
    expect(latitude(ideal.curve, 1)).toBeLessThan(11);
  });

  it('has a contrast index of 1 by construction', () => {
    expect(contrastIndex(ideal.curve, 1)).toBeCloseTo(1, 6);
  });

  it('validates like every other shipped profile', () => {
    expect(() => validateCurve(ideal.curve, ideal.id)).not.toThrow();
  });

  it('is marked estimated, because it describes no real film', () => {
    expect(ideal.fitStatus).toBe('E');
  });

  it('still balances to the print stock, so a neutral prints neutral-ish', () => {
    const r = resolve({ ...defaultRecipe(), negativeId: IDEAL_NEGATIVE_ID }, ctx);
    expect(r.warnings).toEqual([]);
    for (const c of RECORDS) expect(Number.isFinite(r.printExposureOffset[c])).toBe(true);
  });

  it('keeps grain, halation and interlayer running — there is still a stage there', () => {
    const r = resolve({ ...defaultRecipe(), negativeId: IDEAL_NEGATIVE_ID }, ctx);
    expect(r.grain.enabled).toBe(true);
    expect(r.grain.sigmaRef).toBeGreaterThan(0);
    expect(r.halation.enabled).toBe(true);
    expect(r.interlayer.coupling[1][1]).toBeGreaterThan(0);
  });

  it('anchors middle grey the way every other stock does', () => {
    const r = resolve({ ...defaultRecipe(), negativeId: IDEAL_NEGATIVE_ID }, ctx);
    // 18% grey lands log10(12.5) above the speed point, per the ISO relation.
    const greyLogE = r.anchorShift + Math.log10(0.18);
    const d = density(greyLogE, r.curve, 1);
    expect(d).toBeGreaterThan(0.8);
    expect(d).toBeLessThan(1.6);
  });
});
