/**
 * Halation presets (§XII). A preset sets the halation strength and size as a
 * group, named for the physical product it imitates — the stock's own value,
 * none, or the strong broad halo of a stock whose antihalation backing is gone.
 * A preset never invents a scattering length; it scales the stock's own.
 */
import { describe, expect, it } from 'vitest';
import { HALATION_PRESETS, halationPresetById } from '../halationPresets';

describe('halation presets', () => {
  it('off disables halation entirely', () => {
    expect(halationPresetById('hal.off').intensity).toBe(0);
  });

  it('stock returns to the datasheet value (null intensity = the stock\'s own)', () => {
    expect(halationPresetById('hal.stock').intensity).toBeNull();
    expect(halationPresetById('hal.stock').radius).toBe(1);
  });

  it('the strong preset is physically the remjet-removed behaviour', () => {
    // The removed neg.v3_500t_xr carried alpha 0.55 and red length 118 um
    // (DEVIATIONS.md, finding 6). The preset reproduces that look as a strong
    // intensity on whatever stock is loaded, scaled from the stock's own length.
    const strong = halationPresetById('hal.strong');
    expect(strong.intensity).toBeGreaterThan(0.3);
    expect(strong.radius).toBeGreaterThanOrEqual(1);
  });

  it('keeps intensities inside the stage\'s 0–1 range', () => {
    for (const p of HALATION_PRESETS) {
      if (p.intensity !== null) {
        expect(p.intensity).toBeGreaterThanOrEqual(0);
        expect(p.intensity).toBeLessThanOrEqual(1);
      }
    }
  });

  it('throws on an unknown preset id rather than substituting one', () => {
    expect(() => halationPresetById('hal.nope')).toThrow();
  });
});
