/**
 * The diffusion (veiling glare) stage's resolved parameters (§XIII, eq.
 * diffusion). The GPU pass convolves and recombines; what can be asserted on
 * the host is that the resolution of the physical parameters is correct — the
 * scales are physical sizes at the film plane, the stage is energy-conserving
 * by construction, and it switches off honestly rather than being floored into
 * visibility where it cannot resolve.
 */
import { describe, expect, it } from 'vitest';
import { defaultRecipe, FRAME_WIDTH_MM } from '../recipe';
import { resolve } from '../resolve';

const ctx = { renderWidthPx: 2048, sourceSpace: 'linearAP1' } as const;
const pitchUm = (fmt: keyof typeof FRAME_WIDTH_MM) => (FRAME_WIDTH_MM[fmt] * 1000) / 2048;

describe('diffusion (glow) resolution', () => {
  it('is disabled by default, so an untouched recipe renders identically', () => {
    const p = resolve(defaultRecipe(), ctx);
    expect(p.glow.strength).toBe(0);
    expect(p.glow.enabled).toBe(false);
  });

  it('converts the halo scale from micrometres to render pixels by the pixel pitch', () => {
    const r = defaultRecipe();
    r.glow.strength = 0.11;
    r.glow.sigma1Um = 24;
    const p = resolve(r, ctx);
    expect(p.glow.sigma1Px).toBeCloseTo(24 / pitchUm('format135'), 9);
    expect(p.glow.sigma2Px).toBeCloseTo((24 * r.glow.sigmaRatio) / pitchUm('format135'), 9);
    expect(p.glow.enabled).toBe(true);
  });

  it('the broad veil is always the wide term (sigma2 > sigma1)', () => {
    const r = defaultRecipe();
    r.glow.strength = 0.19;
    const p = resolve(r, ctx);
    expect(p.glow.sigma2Px).toBeGreaterThan(p.glow.sigma1Px);
  });

  it('is energy-conserving by construction: veil weights sum to the strength', () => {
    // E' = (1-w)E + w[(1-rho)G1 + rho G2]; the broad split rho is in [0,1], so
    // the scattered share is exactly w and the direct share is 1-w. Assert the
    // resolved knobs that guarantee that.
    const r = defaultRecipe();
    r.glow.strength = 0.3;
    r.glow.broad = 0.75;
    const p = resolve(r, ctx);
    expect(p.glow.broad).toBeGreaterThanOrEqual(0);
    expect(p.glow.broad).toBeLessThanOrEqual(1);
    expect(p.glow.strength).toBeLessThanOrEqual(0.5);
  });

  it('a smaller format makes the same physical halo span more pixels', () => {
    const r = defaultRecipe();
    r.glow.strength = 0.11;
    const wide = resolve(r, { ...ctx });
    const small = resolve({ ...r, format: 'standard8' }, ctx);
    expect(small.glow.sigma1Px).toBeGreaterThan(wide.glow.sigma1Px);
  });
});
