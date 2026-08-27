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
import { developLuma, type CameraDevelopParams } from '../core/develop';
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
  /** The camera develop: the histogram arrives developed, so the grey marker
   *  must be too, or the instrument would mark a place the picture no longer
   *  sits. */
  camera: CameraDevelopParams;
  histogram: Float32Array | null;
  monochrome: boolean;
}

export function CurvePlot({
  curve,
  anchorShift,
  exposureGain,
  camera,
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
    const base = H - PAD_B;
    return records.map((c) => {
      const pts: string[] = [];
      for (let i = 0; i <= 180; i++) {
        const x = X_MIN + ((X_MAX - X_MIN) * i) / 180;
        const d = density(x, curve, c as 0 | 1 | 2);
        pts.push(`${i === 0 ? 'M' : 'L'}${sx(x).toFixed(2)} ${sy(d).toFixed(2)}`);
      }
      const d = pts.join(' ');
      // The same trace closed down to the axis. Drawn under the stroke at low
      // opacity it gives the curve a body, which is what stops a 2px line
      // reading as stranded in an empty box.
      const area = `${d} L${sx(X_MAX).toFixed(2)} ${base} L${sx(X_MIN).toFixed(2)} ${base} Z`;
      return { record: c, d, area };
    });
    // sx/sy are pure functions of yMax, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curve, yMax, monochrome]);

  const histPath = useMemo(() => {
    if (!histogram) return null;
    // The histogram arrives developed and gain-applied; only the anchor
    // remains between the scene and the film plane.
    const shift = anchorShift;
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
  }, [histogram, anchorShift]);

  // Where 18% grey lands after the develop: the marker marks the picture the
  // film is about to see, not the raw file it came from.
  const greyLogE = anchorShift + Math.log10(developLuma(0.18 * exposureGain, camera));
  const spLogE = speedPoint(curve, 1);
  const greyX = sx(greyLogE);
  const spX = sx(spLogE);

  // The two places on the curve worth marking with a handle. The reference
  // puts draggable pucks on its spline; this curve is driven by the bench
  // rather than by dragging, so the pucks mark the points the bench is
  // actually working against — where the metered mid-grey lands, and the
  // shadow threshold that defines the speed. The green record carries them:
  // it is the reference record everywhere else in the instrument too.
  const nodes = useMemo(() => {
    const inBand = (x: number) => x > X_MIN && x < X_MAX;
    return [
      { key: 'grey', logE: greyLogE, lens: true },
      { key: 'speed', logE: spLogE, lens: false },
    ]
      .filter((n) => inBand(n.logE))
      .map((n) => ({ ...n, cx: sx(n.logE), cy: sy(density(n.logE, curve, 1)) }));
    // sx/sy are pure functions of yMax, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curve, yMax, greyLogE, spLogE]);

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
          {/* One wash per record, fading to nothing at the axis. On a colour
              stock the three overlap, so where the records agree the wash is
              neutral and where they diverge it takes on the cast — which is
              the crossover the plot exists to show. */}
          {(['mono', 0, 1, 2] as const).map((k) => (
            <linearGradient
              key={k}
              id={`plot-wash-${k}`}
              x1="0"
              y1={PAD_T}
              x2="0"
              y2={H - PAD_B}
              gradientUnits="userSpaceOnUse"
            >
              <stop
                offset="0%"
                stopColor={k === 'mono' ? 'var(--ink)' : RECORD_COLOURS[k]}
                stopOpacity="0.4"
              />
              <stop
                offset="100%"
                stopColor={k === 'mono' ? 'var(--ink)' : RECORD_COLOURS[k]}
                stopOpacity="0"
              />
            </linearGradient>
          ))}
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

          {paths.map(({ record, area }) => (
            <path
              key={`area${record}`}
              d={area}
              className="plot__area"
              fill={`url(#plot-wash-${monochrome ? 'mono' : record})`}
            />
          ))}

          {paths.map(({ record, d }) => (
            <path
              key={record}
              d={d}
              className="plot__curve"
              style={{ stroke: monochrome ? 'var(--ink)' : RECORD_COLOURS[record] }}
            />
          ))}

          {/* The lens: the reference magnifies the point being worked; here it
              rings the metered mid-grey, which is the point the bench moves. */}
          {nodes.map((n) =>
            n.lens ? (
              <g key={`lens${n.key}`}>
                <circle cx={n.cx} cy={n.cy} r="15" className="plot__lens-fill" />
                <circle cx={n.cx} cy={n.cy} r="15" className="plot__lens-ring" />
              </g>
            ) : null,
          )}

          {nodes.map((n) => (
            <circle key={n.key} cx={n.cx} cy={n.cy} r="3.25" className="plot__node" />
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
