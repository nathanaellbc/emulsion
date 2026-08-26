/**
 * The measured print stocks — which LUT exists for which print stock at
 * which print illuminant, and the one loader that fetches, validates and
 * caches them.
 *
 * A LUT is an asset, not a parameter: it loads once per (stock, illuminant)
 * and lives in a module-level cache, the same way the stock profiles
 * themselves are module state. `resolve()` reads only the registry
 * (synchronous, so resolution stays pure and total); the renderer and the
 * host engine read the loaded cube. A stock whose file has not arrived yet,
 * or failed validation, renders through the calculated model — the engine
 * degrades to the model, never to nothing.
 */

import { parseCube, type CubeLut } from './cube';

/** The print illuminants a measurement can be balanced for. */
export type PrintIlluminant = 'D55' | 'D60' | 'D65';

export const PRINT_ILLUMINANTS: readonly PrintIlluminant[] = ['D55', 'D60', 'D65'];

export interface PrintLutEntry {
  /** File per illuminant. A stock with one entry has no illuminant family. */
  readonly illuminants: Partial<Record<PrintIlluminant, string>>;
  /** What the UI calls it — the measurement's own name. */
  readonly displayName: string;
  /** Provenance, shown in the interface rather than hidden in a README. */
  readonly source: string;
}

/**
 * One measured stock per calculated profile, where a measurement exists.
 * 3521 has none under a redistributable licence and is deliberately absent:
 * the model renders it, and the interface says so. 2393's FPE measurement
 * ships in a single white point, so its illuminant control has nothing to
 * switch.
 */
export const PRINT_LUTS: Record<string, PrintLutEntry> = {
  'prt.2383': {
    illuminants: {
      D55: 'kodak-2383-d55.cube',
      D60: 'kodak-2383-d60.cube',
      D65: 'kodak-2383-d65.cube',
    },
    displayName: 'Vision 2383',
    source: 'Kodak Film Look LUT (Resolve distribution)',
  },
  'prt.2393': {
    illuminants: { D65: 'kodak-2393-d65.cube' },
    displayName: 'Premier 2393',
    source: 'Autodesk Film Print Emulation',
  },
  'prt.3513': {
    illuminants: {
      D55: 'fuji-3513-d55.cube',
      D60: 'fuji-3513-d60.cube',
      D65: 'fuji-3513-d65.cube',
    },
    displayName: 'Fujifilm 3513DI',
    source: 'Fujifilm Film Look LUT (Resolve distribution)',
  },
};

export function printLutEntry(printId: string): PrintLutEntry | null {
  return PRINT_LUTS[printId] ?? null;
}

/** The illuminants a stock actually has measurements for, in display order. */
export function printLutIlluminants(printId: string): PrintIlluminant[] {
  const entry = printLutEntry(printId);
  if (!entry) return [];
  return PRINT_ILLUMINANTS.filter((i) => entry.illuminants[i] !== undefined);
}

export function printLutFile(printId: string, illuminant: PrintIlluminant): string | null {
  return printLutEntry(printId)?.illuminants[illuminant] ?? null;
}

const pending = new Map<string, Promise<CubeLut | null>>();
const loaded = new Map<string, CubeLut>();

const key = (printId: string, illuminant: PrintIlluminant) => `${printId}:${illuminant}`;

/**
 * Loads and validates a stock's LUT, once per (stock, illuminant). A fetch
 * or parse failure caches the failure — the engine falls back to the model
 * for the session rather than re-fetching a broken file on every render.
 */
export function loadPrintLut(
  printId: string,
  illuminant: PrintIlluminant,
): Promise<CubeLut | null> {
  const file = printLutFile(printId, illuminant);
  if (!file) return Promise.resolve(null);
  const k = key(printId, illuminant);
  const existing = pending.get(k);
  if (existing) return existing;
  const promise = fetch(`luts/${file}`)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    })
    .then((text) => {
      const lut = parseCube(text);
      loaded.set(k, lut);
      return lut;
    })
    .catch((err: unknown) => {
      console.warn(
        `print LUT for ${printId} (${illuminant}) failed to load (${err instanceof Error ? err.message : err}); rendering through the model`,
      );
      return null;
    });
  pending.set(k, promise);
  return promise;
}

/** The parsed cube for an already-loaded stock/illuminant, or null. Synchronous by design. */
export function loadedPrintLut(printId: string, illuminant: PrintIlluminant): CubeLut | null {
  return loaded.get(key(printId, illuminant)) ?? null;
}
