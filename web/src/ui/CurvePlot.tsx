/**
 * The D–log E plot: the instrument's face.
 *
 * Three records drawn from the *resolved* parameters — the same numbers the
 * shader is running — over a histogram of where this photograph's tones
 * actually land. Push development and the curves steepen under a stationary
 * picture; change exposure and the picture slides beneath stationary curves.
 * That distinction is the whole difference between the two controls, and it is
 * much easier to see than to explain.
 */

import { useMemo } from 'react';
import { density, type CurveParameters } from '../core/curve';
import { speedPoint } from '../core/sensitometry';
import { HISTOGRAM_BINS, HISTOGRAM_MAX, HISTOGRAM_MIN } from '../io/decode';

const X_MIN = -5.2;
const X_MAX = 1.2;
const W = 460;
const H = 206;
const PAD_L = 30;
const PAD_R = 10;
const PAD_T = 10;
// Deep enough for a row of ticks and the axis caption beneath them, without
// the two sharing a baseline.
const PAD_B = 38;

const RECORD_COLOURS = ['var(--record-r)', 'var(--record-g)', 'var(--record-b)'] as const;

export interface CurvePlotProps {
  curve: CurveParameters;
  /** log10(E) + this = film log exposure. */
  anchorShift: number;
  exposureGain: number;
  histogram: Float32Array | null;
  monochrome: boolean;
}

export function CurvePlot({
  curve,
  anchorShift,
  exposureGain,
  histogram,
  monochrome,
}: CurvePlotProps) {
  const yMax = useMemo(() => {
    let m = 0;
    for (let c = 0; c < 3; c++) m = Math.max(m, curve.dMin[c as 0 | 1 | 2] + curve.deltaD[c as 0 | 1 | 2]);
    return Math.ceil((m + 0.2) * 2) / 2;
  }, [curve]);

  const sx = (x: number) => PAD_L + ((x - X_MIN) / (X_MAX - X_MIN)) * (W - PAD_L - PAD_R);
  const sy = (d: number) => H - PAD_B - (d / yMax) * (H - PAD_T - PAD_B);

  const paths = useMemo(() => {
    const records = monochrome ? [1] : [0, 1, 2];
    return records.map((c) => {
      const pts: string[] = [];
      for (let i = 0; i <= 180; i++) {
        const x = X_MIN + ((X_MAX - X_MIN) * i) / 180;
        const d = density(x, curve, c as 0 | 1 | 2);
        pts.push(`${i === 0 ? 'M' : 'L'}${sx(x).toFixed(2)} ${sy(d).toFixed(2)}`);
      }
      return { record: c, d: pts.join(' ') };
    });
    // sx/sy are pure functions of yMax, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curve, yMax, monochrome]);

  const histPath = useMemo(() => {
    if (!histogram) return null;
    const shift = anchorShift + Math.log10(Math.max(exposureGain, 1e-6));
    const span = HISTOGRAM_MAX - HISTOGRAM_MIN;
    const base = H - PAD_B;
    const height = (H - PAD_T - PAD_B) * 0.42;
    const pts: string[] = [];
    for (let i = 0; i < HISTOGRAM_BINS; i++) {
      const logE = HISTOGRAM_MIN + (span * (i + 0.5)) / HISTOGRAM_BINS;
      const x = sx(logE + shift);
      const y = base - histogram[i]! * height;
      pts.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`);
    }
    const first = sx(HISTOGRAM_MIN + shift);
    const last = sx(HISTOGRAM_MAX + shift);
    return `M${first.toFixed(2)} ${base} ${pts.join(' ')} L${last.toFixed(2)} ${base} Z`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [histogram, anchorShift, exposureGain, yMax]);

  const greyX = sx(anchorShift + Math.log10(0.18 * Math.max(exposureGain, 1e-6)));
  const spX = sx(speedPoint(curve, 1));

  const xTicks: number[] = [];
  for (let x = Math.ceil(X_MIN); x <= X_MAX; x++) xTicks.push(x);
  const yTicks: number[] = [];
  for (let d = 0; d <= yMax + 1e-6; d += 0.5) yTicks.push(d);

  return (
    <figure className="plot">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Characteristic curve, density against log exposure">
        <defs>
          <clipPath id="plot-clip">
            <rect x={PAD_L} y={PAD_T} width={W - PAD_L - PAD_R} height={H - PAD_T - PAD_B} />
          </clipPath>
        </defs>

        {yTicks.map((d) => (
          <g key={`y${d}`}>
            <line x1={PAD_L} x2={W - PAD_R} y1={sy(d)} y2={sy(d)} className="plot__grid" />
            <text x={PAD_L - 6} y={sy(d) + 3} className="plot__tick num" textAnchor="end">
              {d.toFixed(1)}
            </text>
          </g>
        ))}
        {xTicks.map((x) => (
          <g key={`x${x}`}>
            <line x1={sx(x)} x2={sx(x)} y1={PAD_T} y2={H - PAD_B} className="plot__grid" />
            <text x={sx(x)} y={H - PAD_B + 12} className="plot__tick num" textAnchor="middle">
              {x}
            </text>
          </g>
        ))}

        <g clipPath="url(#plot-clip)">
          {histPath ? <path d={histPath} className="plot__hist" /> : null}

          {/* Where an 18% neutral lands. This is the anchor everything hangs on. */}
          <line x1={greyX} x2={greyX} y1={PAD_T} y2={H - PAD_B} className="plot__grey" />
          {/* The speed point: Dmin + 0.10, the shadow threshold that defines ISO. */}
          <line x1={spX} x2={spX} y1={PAD_T} y2={H - PAD_B} className="plot__speed" />

          {paths.map(({ record, d }) => (
            <path
              key={record}
              d={d}
              className="plot__curve"
              style={{ stroke: monochrome ? 'var(--ink)' : RECORD_COLOURS[record] }}
            />
          ))}
        </g>

        <rect
          x={PAD_L}
          y={PAD_T}
          width={W - PAD_L - PAD_R}
          height={H - PAD_T - PAD_B}
          className="plot__frame"
        />
        <text x={PAD_L} y={H - 6} className="plot__axis">
          log₁₀ E at the film plane
        </text>
        <text x={W - PAD_R} y={H - 6} className="plot__axis" textAnchor="end">
          <tspan className="plot__key plot__key--grey">18% grey</tspan>
          <tspan dx="10" className="plot__key plot__key--speed">
            speed point
          </tspan>
        </text>
      </svg>
    </figure>
  );
}
