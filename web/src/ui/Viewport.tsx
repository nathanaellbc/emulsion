/**
 * The viewport. The photograph is the only bright object in the room, so the
 * chrome around it stays out of the way: controls fade in on hover, and the
 * comparison seam is a thin amber line rather than a widget.
 *
 * The photograph carries its own zoom, because the interface never does: the
 * browser's pinch is refused page-wide, and the gesture is spent on the
 * picture instead. Zoom is a pure CSS transform on the picture layer — the
 * render resolution is untouched — and the seam handle and stage tags ride
 * the same transform, so they stay on the seam and in the corners.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewMode } from '../gl/renderer';
import { SegmentedControl } from './controls';

export interface ViewportProps {
  canvasRef: React.RefObject<HTMLCanvasElement>;
  mode: ViewMode;
  onModeChange: (m: ViewMode) => void;
  split: number;
  onSplitChange: (v: number) => void;
  clipWarning: boolean;
  onClipWarningChange: (v: boolean) => void;
  fileName: string | null;
  caption: string | null;
  busy: boolean;
}

const MODES: { value: ViewMode; label: string; title: string }[] = [
  { value: 'print', label: 'Print', title: 'The finished print' },
  {
    value: 'negative',
    label: 'Negative',
    title: 'Negative density, normalised — what is actually on the film before it is printed',
  },
  {
    value: 'printDensity',
    label: 'Print D',
    title: 'Print density before the display transform',
  },
  {
    value: 'halationSource',
    label: 'Halation',
    title: 'The source term: which parts of the scene are bright enough to scatter',
  },
];

interface Zoom {
  scale: number;
  x: number;
  y: number;
}

interface Point {
  x: number;
  y: number;
}

/** Eight times reaches grain-level inspection; further is not focus. */
const ZOOM_MAX = 8;
const DOUBLE_TAP_SCALE = 2.5;
const IDENTITY: Zoom = { scale: 1, x: 0, y: 0 };

/**
 * Keep the content point under `anchor` there while the scale changes: the
 * pinch midpoint pins the pinch, a double-tap pins the tap, the wheel pins
 * the cursor.
 */
function zoomedAround(anchor: Point, centre: Point, prev: Zoom, scale: number): Zoom {
  const cx = (anchor.x - centre.x - prev.x) / prev.scale;
  const cy = (anchor.y - centre.y - prev.y) / prev.scale;
  return { scale, x: anchor.x - centre.x - scale * cx, y: anchor.y - centre.y - scale * cy };
}

/** The picture may not be dragged off the frame: the translate bounds grow
    exactly as far as the scale's overflow allows, and no further. */
function clamped(z: Zoom, w: number, h: number): Zoom {
  const mx = ((z.scale - 1) * w) / 2;
  const my = ((z.scale - 1) * h) / 2;
  return {
    scale: z.scale,
    x: Math.min(mx, Math.max(-mx, z.x)),
    y: Math.min(my, Math.max(-my, z.y)),
  };
}

export function Viewport({
  canvasRef,
  mode,
  onModeChange,
  split,
  onSplitChange,
  clipWarning,
  onClipWarningChange,
  fileName,
  caption,
  busy,
}: ViewportProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const zoomRef = useRef<Zoom>(IDENTITY);
  const [zoom, setZoom] = useState<Zoom>(IDENTITY);
  const [animating, setAnimating] = useState(false);
  const animTimer = useRef<number | null>(null);
  const pointers = useRef(new Map<number, Point & { x0: number; y0: number; t0: number }>());
  const pinch = useRef<{ dist: number; mid: Point; centre: Point; origin: Zoom } | null>(null);
  const pan = useRef<{ id: number; down: Point; origin: Zoom } | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);

  const commit = useCallback((z: Zoom, animated = false) => {
    zoomRef.current = z;
    setZoom(z);
    setAnimating(animated);
    if (animTimer.current !== null) window.clearTimeout(animTimer.current);
    if (animated) {
      animTimer.current = window.setTimeout(() => setAnimating(false), 240);
    }
  }, []);

  /** The frame is the untransformed reference: its centre is the transform
      origin and its box is what the translate bounds are measured against. */
  const frameGeometry = useCallback(() => {
    const el = frameRef.current;
    const rect = el?.getBoundingClientRect();
    const layer = layerRef.current;
    return {
      centre: {
        x: (rect?.left ?? 0) + (rect?.width ?? 0) / 2,
        y: (rect?.top ?? 0) + (rect?.height ?? 0) / 2,
      },
      w: layer?.clientWidth ?? 1,
      h: layer?.clientHeight ?? 1,
    };
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pointers.current.set(e.pointerId, {
        x: e.clientX,
        y: e.clientY,
        x0: e.clientX,
        y0: e.clientY,
        t0: performance.now(),
      });
      if (animTimer.current !== null) commit(zoomRef.current, false);
      if (pointers.current.size === 2) {
        // Second finger down: the pan becomes a pinch, anchored where the
        // fingers sit now.
        pan.current = null;
        const pts = [...pointers.current.values()];
        const a = pts[0]!;
        const b = pts[1]!;
        pinch.current = {
          dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          centre: frameGeometry().centre,
          origin: zoomRef.current,
        };
        e.preventDefault();
      } else if (pointers.current.size === 1 && zoomRef.current.scale > 1) {
        // One finger on a zoomed picture pans it. At scale 1 the gesture is
        // left to the page, which scrolls the controls.
        pan.current = {
          id: e.pointerId,
          down: { x: e.clientX, y: e.clientY },
          origin: zoomRef.current,
        };
        e.preventDefault();
      }
    },
    [commit, frameGeometry],
  );

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = pointers.current.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX;
      p.y = e.clientY;
      const { w, h } = frameGeometry();
      if (pinch.current && pointers.current.size >= 2) {
        const pts = [...pointers.current.values()];
        const a = pts[0]!;
        const b = pts[1]!;
        const g = pinch.current;
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const scale = Math.min(ZOOM_MAX, Math.max(1, (g.origin.scale * dist) / g.dist));
        commit(clamped(zoomedAround(g.mid, g.centre, g.origin, scale), w, h));
      } else if (pan.current && pan.current.id === e.pointerId) {
        const g = pan.current;
        commit(
          clamped(
            {
              scale: g.origin.scale,
              x: g.origin.x + (p.x - g.down.x),
              y: g.origin.y + (p.y - g.down.y),
            },
            w,
            h,
          ),
        );
      }
    };

    const end = (e: PointerEvent) => {
      const p = pointers.current.get(e.pointerId);
      pointers.current.delete(e.pointerId);
      if (pinch.current && pointers.current.size < 2) pinch.current = null;
      if (pan.current && pan.current.id === e.pointerId) pan.current = null;
      if (!p || e.type !== 'pointerup' || pointers.current.size > 0) return;
      // A quick, still release is a tap. Two taps, near each other, are a
      // double-tap: in to 2.5x around the tap, or back out to the full print.
      const quick = performance.now() - p.t0 < 300 && Math.hypot(p.x - p.x0, p.y - p.y0) < 8;
      if (!quick) return;
      const now = performance.now();
      const last = lastTap.current;
      lastTap.current = { t: now, x: p.x, y: p.y };
      if (!last || now - last.t > 350 || Math.hypot(p.x - last.x, p.y - last.y) > 24) return;
      lastTap.current = null;
      const z = zoomRef.current;
      if (z.scale > 1.001) {
        commit(IDENTITY, true);
      } else {
        const { centre, w, h } = frameGeometry();
        commit(clamped(zoomedAround({ x: p.x, y: p.y }, centre, z, DOUBLE_TAP_SCALE), w, h), true);
      }
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [commit, frameGeometry]);

  // The wheel zooms with the trackpad's pinch (ctrl+wheel) and pans the
  // zoomed picture otherwise; at scale 1 it is left for the page.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const prev = zoomRef.current;
        const { centre, w, h } = frameGeometry();
        const scale = Math.min(ZOOM_MAX, Math.max(1, prev.scale * Math.exp(-e.deltaY * 0.0022)));
        commit(clamped(zoomedAround({ x: e.clientX, y: e.clientY }, centre, prev, scale), w, h));
      } else if (zoomRef.current.scale > 1) {
        e.preventDefault();
        const { w, h } = frameGeometry();
        const z = zoomRef.current;
        commit(clamped({ ...z, x: z.x - e.deltaX, y: z.y - e.deltaY }, w, h));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [commit, frameGeometry]);

  // A new photograph arrives unzoomed; the zoom belongs to the picture.
  useEffect(() => {
    commit(IDENTITY);
  }, [fileName, commit]);

  const positionFromEvent = useCallback((clientX: number) => {
    const el = frameRef.current;
    if (!el) return 0;
    const canvas = el.querySelector('canvas');
    const rect = (canvas ?? el).getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }, []);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => onSplitChange(positionFromEvent(e.clientX));
    const up = () => setDragging(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [dragging, onSplitChange, positionFromEvent]);

  const comparing = split > 0;
  const zoomed = zoom.scale > 1.005;

  return (
    <div className="viewport">
      <div className="viewport__bar">
        <SegmentedControl label="Inspect stage" value={mode} options={MODES} onChange={onModeChange} />
        <div className="viewport__bar-right">
          <button
            type="button"
            className={`chip${comparing ? ' is-on' : ''}`}
            aria-pressed={comparing}
            onClick={() => onSplitChange(comparing ? 0 : 0.5)}
            title="Show the decoded scene beside the print, with no film in between"
          >
            Compare
          </button>
          <button
            type="button"
            className={`chip${clipWarning ? ' is-on' : ''}`}
            aria-pressed={clipWarning}
            onClick={() => onClipWarningChange(!clipWarning)}
            title="Mark pixels that reach display white or display black on all three channels"
          >
            Clipping
          </button>
        </div>
      </div>

      <div className={`viewport__frame${busy ? ' is-busy' : ''}`} ref={frameRef}>
        <div
          ref={layerRef}
          className={`viewport__zoom${zoomed ? ' is-zoomed' : ''}${animating ? ' is-animating' : ''}`}
          style={{ transform: `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.scale})` }}
          onPointerDown={onPointerDown}
        >
          <canvas ref={canvasRef} className="viewport__canvas" />
          {comparing ? (
            <button
              type="button"
              className="viewport__handle"
              style={{ left: `${split * 100}%` }}
              onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                setDragging(true);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') onSplitChange(Math.max(0.02, split - 0.02));
                if (e.key === 'ArrowRight') onSplitChange(Math.min(1, split + 0.02));
              }}
              aria-label="Comparison position"
              aria-valuenow={Math.round(split * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              role="slider"
              tabIndex={0}
            >
              <span aria-hidden="true" />
            </button>
          ) : null}
          {comparing ? (
            <>
              <span className="viewport__tag viewport__tag--left">Scene</span>
              <span className="viewport__tag viewport__tag--right">Print</span>
            </>
          ) : null}
        </div>
        {/* The badge stays on the frame, not the picture layer: it would
            otherwise be carried off-screen by the very zoom it resets. */}
        {zoomed ? (
          <button
            type="button"
            className="viewport__zoom-badge num"
            title="Back to the whole print"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => commit(IDENTITY, true)}
          >
            {zoom.scale.toFixed(1)}×
          </button>
        ) : null}
      </div>

      <div className="viewport__foot">
        <span className="viewport__file num">{fileName ?? '—'}</span>
        {caption ? <span className="viewport__caption">{caption}</span> : null}
      </div>
    </div>
  );
}
