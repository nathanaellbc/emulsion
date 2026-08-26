/**
 * The .cube format, as a print-film LUT arrives and as it is sampled.
 *
 * A 3D LUT file lists its nodes with red varying fastest, then green, then
 * blue — the same order texImage3D wants — so the parsed array uploads to a
 * 3D texture without repacking, and the host sampler below walks it in the
 * same order the GPU's hardware trilinear pass will. One layout, two
 * implementations, no room for them to disagree about where a node lives.
 */

import { clamp } from './math';
import { RECORDS, type Triple } from './triple';

export interface CubeLut {
  /** Nodes per axis. */
  readonly size: number;
  /** RGB triples, red fastest: index = r + g*size + b*size*size. */
  readonly data: Float32Array;
  /** Per-axis input domain; uniform across axes in the files this accepts. */
  readonly domainMin: number;
  readonly domainMax: number;
  /** The file's TITLE, when it carried one. */
  readonly title: string;
}

export class CubeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CubeParseError';
  }
}

/**
 * Parses and validates. A file that declares a size its data does not fill,
 * or carries a value outside the declared domain, is not a LUT with an
 * unusual opinion — it is a file we cannot promise anything about, and the
 * engine falls back to the calculated model rather than sample it.
 */
export function parseCube(text: string): CubeLut {
  const lines = text.split('\n');
  let size = 0;
  let title = '';
  let domainMin = 0;
  let domainMax = 1;
  const values: number[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('TITLE')) {
      title = line.slice(5).trim().replace(/^"|"$/g, '');
      continue;
    }
    if (line.startsWith('LUT_1D_SIZE')) throw new CubeParseError('1D LUTs are not print stocks');
    if (line.startsWith('LUT_3D_SIZE')) {
      size = Number(line.split(/\s+/)[1]);
      continue;
    }
    if (line.startsWith('LUT_3D_INPUT_RANGE')) {
      const parts = line.split(/\s+/).slice(1).map(Number);
      domainMin = parts[0]!;
      domainMax = parts[1]!;
      continue;
    }
    if (line.startsWith('DOMAIN_MIN')) {
      const parts = line.split(/\s+/).slice(1).map(Number);
      // Per-axis domains are legal in the format; a print stock is not the
      // place they belong, and accepting one would put the axes out of step
      // with the 3D texture upload, which has exactly one domain.
      if (new Set(parts).size !== 1) throw new CubeParseError('per-axis domains are not supported');
      domainMin = parts[0]!;
      continue;
    }
    if (line.startsWith('DOMAIN_MAX')) {
      const parts = line.split(/\s+/).slice(1).map(Number);
      if (new Set(parts).size !== 1) throw new CubeParseError('per-axis domains are not supported');
      domainMax = parts[0]!;
      continue;
    }
    if (/^[A-Z_]/.test(line)) continue;
    const parts = line.split(/\s+/).map(Number);
    if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) {
      throw new CubeParseError(`malformed data line: ${line.slice(0, 40)}`);
    }
    values.push(parts[0]!, parts[1]!, parts[2]!);
  }

  if (!Number.isInteger(size) || size < 2) throw new CubeParseError('missing or invalid LUT_3D_SIZE');
  const expected = size * size * size * 3;
  if (values.length !== expected) {
    throw new CubeParseError(`declared ${size}^3 but carried ${values.length / 3} points`);
  }
  for (let i = 0; i < values.length; i++) {
    if (values[i]! < domainMin - 1e-6 || values[i]! > domainMax + 1e-6) {
      throw new CubeParseError(`value ${values[i]} outside the declared domain at point ${(i / 3) | 0}`);
    }
  }
  return { size, data: new Float32Array(values), domainMin, domainMax, title };
}

/**
 * Trilinear sampling, exactly as a grading system and as the GPU's own
 * hardware filter will apply the same table. Coordinates are clamped to the
 * declared domain first, so an out-of-range query returns the edge node
 * rather than a wrapped one.
 */
export function sampleCube(lut: CubeLut, u: Triple): Triple {
  const { size, data, domainMin, domainMax } = lut;
  const i0: number[] = [0, 0, 0];
  const f: number[] = [0, 0, 0];
  for (const c of RECORDS) {
    const scaled = (clamp(u[c], domainMin, domainMax) - domainMin) / (domainMax - domainMin);
    const p = scaled * (size - 1);
    i0[c] = Math.min(Math.floor(p), size - 2);
    f[c] = p - i0[c];
  }
  const [r0, g0, b0] = i0;
  const [fr, fg, fb] = f;
  const at = (r: number, g: number, b: number) => {
    const i = r0! + r + (g0! + g) * size + (b0! + b) * size * size;
    return [data[i * 3]!, data[i * 3 + 1]!, data[i * 3 + 2]!] as Triple;
  };
  const c00 = mix(at(0, 0, 0), at(1, 0, 0), fr!);
  const c01 = mix(at(0, 0, 1), at(1, 0, 1), fr!);
  const c10 = mix(at(0, 1, 0), at(1, 1, 0), fr!);
  const c11 = mix(at(0, 1, 1), at(1, 1, 1), fr!);
  return mix(mix(c00, c10, fg!), mix(c01, c11, fg!), fb!);
}

function mix(a: Triple, b: Triple, t: number): Triple {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
