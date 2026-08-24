/**
 * Grain presets — "format · ISO" looks (§XI).
 *
 * A grain is a few micrometres at the film plane, so how large it *appears* is
 * set by the format and the enlargement to the output, not by the pixel count
 * (§XI, property 3). A preset therefore bundles two physical things:
 *
 *   - a `format`, which sets the frame width and hence the enlargement, and
 *   - the `size` and `amount` applied to the stock's datasheet granularity.
 *
 * What a preset never does is invent a Selwyn granularity: G_S stays the
 * stock's own datasheet measurement. The ISO class the user sees is the
 * stock's — a Tri-X preset is coarse because Tri-X is coarse (G_S = 17), and
 * the preset only decides how large that grain is thrown on screen. "Pushed"
 * presets enlarge the kernel deliberately and say so in the name, mirroring a
 * real push rather than hiding a size change in a default.
 */

import type { FilmFormat } from './recipe';

export interface GrainPreset {
  readonly id: string;
  readonly displayName: string;
  /** Frame the grain is formed on; sets the enlargement. */
  readonly format: FilmFormat;
  /** Kernel-size multiplier. 1 is the datasheet grain size on this format. */
  readonly size: number;
  /** Amount multiplier. 1 is the datasheet granularity; 0 disables grain. */
  readonly amount: number;
  readonly note: string;
}

export const GRAIN_PRESETS: readonly GrainPreset[] = [
  {
    id: 'grain.off',
    displayName: 'Off',
    format: 'format135',
    size: 1,
    amount: 0,
    note: 'No grain. The chain still runs; only the stochastic stage is skipped.',
  },
  {
    id: 'grain.45',
    displayName: 'Large format · 4×5',
    format: 'format45',
    size: 1,
    amount: 1,
    note: 'A 102 mm frame enlarged little, so the datasheet grain is barely visible — the smooth tonality large format is prized for.',
  },
  {
    id: 'grain.645',
    displayName: 'Medium format · 645',
    format: 'format645',
    size: 1,
    amount: 1,
    note: 'A 56 mm frame. Noticeably finer than 35 mm at the same stock and speed.',
  },
  {
    id: 'grain.135',
    displayName: '35 mm · datasheet',
    format: 'format135',
    size: 1,
    amount: 1,
    note: 'The reference: the stock\'s published granularity on a 36 mm frame, at the enlargement grain tables assume.',
  },
  {
    id: 'grain.135pushed',
    displayName: '35 mm · pushed',
    format: 'format135',
    size: 1.5,
    amount: 1.4,
    note: 'Pushed a stop or two: a coarser, more present grain, as underexposure and overdevelopment make it. A deliberate look, named as one.',
  },
  {
    id: 'grain.super16',
    displayName: 'Super 16',
    format: 'super16',
    size: 1,
    amount: 1,
    note: 'A 12.5 mm frame enlarged hard — the visible, dancing grain of 16 mm motion film.',
  },
  {
    id: 'grain.standard8',
    displayName: 'Standard 8',
    format: 'standard8',
    size: 1,
    amount: 1,
    note: 'A 10.3 mm frame. The coarsest look here: home-movie grain, huge on screen.',
  },
];

const BY_ID = new Map(GRAIN_PRESETS.map((p) => [p.id, p]));

export function grainPresetById(id: string): GrainPreset {
  const p = BY_ID.get(id);
  if (!p) throw new Error(`unknown grain preset '${id}'`);
  return p;
}
