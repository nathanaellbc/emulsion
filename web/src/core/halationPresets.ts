/**
 * Halation presets (§XII).
 *
 * Halation is the light that passes through the emulsion, scatters off the film
 * base, and returns — red surviving the round trip best, so the halo is orange.
 * A preset sets the strength and size as a named group. What it never does is
 * invent a scattering length: the per-channel lengths stay the stock's own,
 * scaled by `radius`, because they are set by the physics of the emulsion stack.
 *
 * The strong preset reproduces the look of a stock whose antihalation backing
 * (remjet) is gone — the broad red halo the removed `neg.v3_500t_xr` carried
 * (α 0.55, red length 118 µm; DEVIATIONS.md, finding 6) — as an intensity on
 * whatever stock is loaded, rather than as a separate near-duplicate stock.
 */

export interface HalationPreset {
  readonly id: string;
  readonly displayName: string;
  /** Halation strength; null means the stock's own alpha. */
  readonly intensity: number | null;
  /** Red-scattering-length multiplier, ratios held fixed. */
  readonly radius: number;
  readonly note: string;
}

export const HALATION_PRESETS: readonly HalationPreset[] = [
  {
    id: 'hal.off',
    displayName: 'Off',
    intensity: 0,
    radius: 1,
    note: 'No halation. Highlights stay clean; the pointwise chain is unaffected.',
  },
  {
    id: 'hal.stock',
    displayName: "Stock's own",
    intensity: null,
    radius: 1,
    note: "The halation the datasheet implies for this stock — its own alpha and scattering lengths, untouched.",
  },
  {
    id: 'hal.strong',
    displayName: 'Strong — backing removed',
    intensity: 0.55,
    radius: 1.3,
    note: 'The look of a stock with its antihalation backing gone: a broad orange-red halo around every specular highlight.',
  },
];

const BY_ID = new Map(HALATION_PRESETS.map((p) => [p.id, p]));

export function halationPresetById(id: string): HalationPreset {
  const p = BY_ID.get(id);
  if (!p) throw new Error(`unknown halation preset '${id}'`);
  return p;
}
