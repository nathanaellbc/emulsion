import { describe, expect, it } from 'vitest';
import { parseCube, sampleCube, CubeParseError } from '../cube';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lutPath = (file: string) => fileURLToPath(new URL(`../../../public/luts/${file}`, import.meta.url));

/** A 3-point LUT whose value at every node is the node's own coordinates. */
const IDENTITY = parseCube(
  ['LUT_3D_SIZE 3', ...diag()].join('\n'),
);
function diag(): string[] {
  const lines: string[] = [];
  for (let b = 0; b < 3; b++)
    for (let g = 0; g < 3; g++)
      for (let r = 0; r < 3; r++) lines.push(`${r / 2} ${g / 2} ${b / 2}`);
  return lines;
}

describe('the .cube parser', () => {
  it('reads size, title and data', () => {
    expect(IDENTITY.size).toBe(3);
    expect(IDENTITY.title).toBe('');
    expect(IDENTITY.data.length).toBe(3 * 3 * 3 * 3);
    // Red varies fastest: the second node is r=0.5, g=0, b=0.
    expect([...IDENTITY.data.slice(3, 6)]).toEqual([0.5, 0, 0]);
  });

  it('rejects a file whose data does not fill its declared grid', () => {
    expect(() => parseCube('LUT_3D_SIZE 3\n0 0 0\n')).toThrow(CubeParseError);
  });

  it('rejects values outside the declared domain', () => {
    const text = ['LUT_3D_SIZE 2', '0 0 0', '0 0 0', '0 0 0', '0 0 0', '0 0 0', '0 0 0', '0 0 0', '1.5 0 0'].join('\n');
    expect(() => parseCube(text)).toThrow(CubeParseError);
  });

  it('rejects per-axis domains, which would desynchronise host and GPU layouts', () => {
    const head = 'LUT_3D_SIZE 2\nDOMAIN_MIN 0.0 0.1 0.2\nDOMAIN_MAX 1.0 1.0 1.0\n';
    expect(() => parseCube(head + '0 0 0\n'.repeat(8))).toThrow(CubeParseError);
  });

  it('rejects a 1D LUT outright', () => {
    expect(() => parseCube('LUT_1D_SIZE 4\n' + '0\n'.repeat(4))).toThrow(CubeParseError);
  });
});

describe('the trilinear sampler', () => {
  it('returns exact node values at node positions', () => {
    for (let b = 0; b < 3; b++)
      for (let g = 0; g < 3; g++)
        for (let r = 0; r < 3; r++) {
          const u = [r / 2, g / 2, b / 2] as const;
          expect([...sampleCube(IDENTITY, u)]).toEqual([r / 2, g / 2, b / 2]);
        }
  });

  it('interpolates the centre of a cell as the average of its corners', () => {
    // The identity LUT is linear, so the trilinear estimate at the cell
    // centre is exact, not approximate.
    expect([...sampleCube(IDENTITY, [0.25, 0.25, 0.25])]).toEqual([0.25, 0.25, 0.25]);
  });

  it('clamps to the edge nodes rather than wrapping', () => {
    expect([...sampleCube(IDENTITY, [-1, 0.5, 2])]).toEqual([0, 0.5, 1]);
  });
});

describe('the bundled print LUTs', () => {
  const files = ['kodak-2383-d65.cube', 'kodak-2393-d65.cube', 'fuji-3513-d65.cube'];

  for (const file of files) {
    it(`${file} parses and its diagonal is a print-film tone curve`, () => {
      const lut = parseCube(readFileSync(lutPath(file), 'utf8'));
      expect(lut.size).toBeGreaterThanOrEqual(13);
      // Lifted black: a print's Dmin, never zero.
      const black = sampleCube(lut, [0, 0, 0]);
      expect(black.every((v) => v >= 0 && v < 0.06)).toBe(true);
      // White at the top.
      const white = sampleCube(lut, [1, 1, 1]);
      expect(white.every((v) => v > 0.95)).toBe(true);
      // Mid-grey below mid-display: a print's contrast, not a monitor's.
      const mid = sampleCube(lut, [0.435, 0.435, 0.435]);
      expect(mid[1]!).toBeLessThan(0.56);
      expect(mid[1]!).toBeGreaterThan(0.3);
    });
  }

  it('the measured interpolation error of each table is bounded and stated', () => {
    // The trilinear error at a cell centre is bounded by the table's own
    // curvature: |err| <= h^2 max|f''| / 8, and the second difference of the
    // node values along a line is h^2 f'' to leading order. So walking the
    // node values along the loci the engine actually samples and taking the
    // worst second difference / 8 *measures* the interpolation error the
    // table can commit — no ground truth needed, no tolerance assumed.
    for (const file of files) {
      const lut = parseCube(readFileSync(lutPath(file), 'utf8'));
      const n = lut.size;
      const at = (r: number, g: number, b: number) => {
        const i = r + g * n + b * n * n;
        return [lut.data[i * 3]!, lut.data[i * 3 + 1]!, lut.data[i * 3 + 2]!];
      };
      let worst = 0;
      // The neutral diagonal plus two off-axis lines, because the cross terms
      // are where a print stock's character lives.
      const lines: [number, number, number][] = [
        [NaN, NaN, NaN], // the diagonal: all three vary together
        [NaN, 0.6, 0.4],
        [0.5, NaN, 0.2],
      ];
      for (const line of lines) {
        const node = (i: number, axis: number) => {
          const u = i / (n - 1);
          const v = Number.isNaN(line[axis]!) ? u : line[axis]!;
          return Math.round(v * (n - 1));
        };
        for (const c of [0, 1, 2]) {
          for (let i = 1; i < n - 1; i++) {
            const a = at(node(i - 1, 0), node(i - 1, 1), node(i - 1, 2));
            const b = at(node(i, 0), node(i, 1), node(i, 2));
            const d = at(node(i + 1, 0), node(i + 1, 1), node(i + 1, 2));
            const second = Math.abs(b[c]! * 2 - a[c]! - d[c]!);
            worst = Math.max(worst, second / 8);
          }
        }
      }
      const bound = n >= 33 ? 0.025 : 0.15;
      // eslint-disable-next-line no-console
      console.log(`${file}: ${n}^3, measured interpolation bound ${worst.toFixed(5)}`);
      expect(worst).toBeLessThan(bound);
    }
  });
});

