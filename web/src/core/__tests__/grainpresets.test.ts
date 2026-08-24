/**
 * Grain presets ("format · ISO" looks) — §XI property 3: a grain is a few
 * micrometres at the film plane, so how large it *appears* depends on the
 * format and the enlargement, not on the pixel count.
 *
 * A preset bundles a format (which sets the frame width, hence the enlargement
 * and the apparent grain size) with the stock's datasheet granularity. The
 * preset never invents a Selwyn value — that stays the stock's measurement; it
 * only changes the enlargement and the amount applied.
 */
import { describe, expect, it } from 'vitest';
import { GRAIN_PRESETS, grainPresetById } from '../grainPresets';
import { FRAME_WIDTH_MM } from '../recipe';

describe('grain presets', () => {
  it('carries a real format for every preset, so the enlargement is physical', () => {
    for (const p of GRAIN_PRESETS) {
      expect(FRAME_WIDTH_MM[p.format]).toBeGreaterThan(0);
    }
  });

  it('orders apparent grain by enlargement: smaller frame => coarser look', () => {
    // The same datasheet granularity appears coarser on a smaller frame because
    // it is enlarged more to the same output size. Standard 8 must read coarser
    // than 35 mm, which reads coarser than 4x5.
    const s8 = grainPresetById('grain.standard8');
    const f135 = grainPresetById('grain.135');
    const f45 = grainPresetById('grain.45');
    expect(FRAME_WIDTH_MM[s8.format]).toBeLessThan(FRAME_WIDTH_MM[f135.format]);
    expect(FRAME_WIDTH_MM[f135.format]).toBeLessThan(FRAME_WIDTH_MM[f45.format]);
    // Apparent size scales as grain size / frame width, for a fixed output.
    const apparent = (id: string) => {
      const p = grainPresetById(id);
      return p.size / FRAME_WIDTH_MM[p.format];
    };
    expect(apparent('grain.standard8')).toBeGreaterThan(apparent('grain.135'));
    expect(apparent('grain.135')).toBeGreaterThan(apparent('grain.45'));
  });

  it('off includes zero grain, and datasheet keeps the stock value at 1', () => {
    expect(grainPresetById('grain.off').amount).toBe(0);
    expect(grainPresetById('grain.135').amount).toBe(1);
  });

  it('never stretches the kernel beyond the datasheet without saying so', () => {
    // A preset may reduce apparent grain (larger format) but any size above 1
    // is a deliberate, named "pushed" look, not a silent default.
    const defaults = GRAIN_PRESETS.filter((p) => !p.id.includes('pushed') && p.id !== 'grain.off');
    for (const p of defaults) expect(p.size).toBeLessThanOrEqual(1);
  });

  it('throws on an unknown preset id rather than substituting one', () => {
    expect(() => grainPresetById('grain.nope')).toThrow();
  });
});
