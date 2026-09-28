/**
 * The viewport. The photograph is the only bright object in the room, so the
 * chrome around it stays out of the way: controls fade in on hover, and the
 * comparison seam is a thin silver line rather than a widget.
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
  /**
   * Present only on the stacked phone layout: dragging the grip requests a
   * new height in pixels for the picture row, which the app clamps between a
   * sliver and the print's natural full-size height.
   */
  onPictureResize?: (h: number) => void;
  /**
   * Present once the photograph has a depth map: the focus point in display
   * coordinates ((0, 0) top-left) and what to do when a new one is picked.
   * The Focus inspect mode appears with it, and in that mode a tap on the
   * picture focuses there.
   */
  focus?: { x: number; y: number; onPick: (x: number, y: number) => void } | null;
  /**
   * Hold-to-peek: a finger (or the mouse) held still on the picture, or the
   * backslash key held down, shows the untouched original for as long as it
   * is held — the before/after gesture every photo editor has.
   */
  peeking?: boolean;
  onPeek?: (on: boolean) => void;
}

/**
 * How long a still press waits before it becomes a peek. Long enough that a
 * tap, a double-tap or the start of a scroll never flashes the original;
 * short enough that holding feels like it answers at once.
 */
const PEEK_DELAY_MS = 220;
/** Movement past this is a scroll, a pan or a pinch — never a peek. */
const PEEK_SLOP_PX = 8;
/**
 * A single tap waits this long for a second one before it opens the focused
 * view, so a double-tap still zooms. The double-tap window matches it.
 */
const SINGLE_TAP_MS = 250;
/** The focused view's margin round the print, px. */
const LIFT_MARGIN_PX = 12;
/** Must match the lift transition in peek.css (--dur-move). */
const LIFT_MS = 560;

/**
 * The focused view: the print lifted out of the page to fill the screen while
 * everything else recedes under a dark blur. `rect` is where the picture layer
 * sat when the view opened — it is pinned there as a fixed box so no scroller
 * can clip it — and `lift` is the transform that carries it to full screen.
 */
interface Lift {
  rect: { left: number; top: number; width: number; height: number };
  origin: { x: number; y: number };
  to: { x: number; y: number; scale: number };
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

const FOCUS_MODE: { value: ViewMode; label: string; title: string } = {
  value: 'focus',
  label: 'Focus',
  title: 'The zone of acceptable sharpness — tap the picture to focus there',
};

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

/** Progressive resistance past the bounds: real things slow before they stop.
    A hard clamp mid-gesture reads as frozen; this reads as "nothing more
    here" while staying glued to the finger. */
function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/** Drag tracking with soft edges: 1:1 inside the bounds, progressively
    resistant past them. Release is still settled by `clamped`. */
function resistance(z: Zoom, w: number, h: number): Zoom {
  const mx = ((z.scale - 1) * w) / 2;
  const my = ((z.scale - 1) * h) / 2;
  const axis = (v: number, m: number, dim: number) => {
    if (m <= 0) return 0;
    if (v > m) return m + rubberband(v - m, dim);
    if (v < -m) return -m + rubberband(v + m, dim);
    return v;
  };
  return { scale: z.scale, x: axis(z.x, mx, w), y: axis(z.y, my, h) };
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
  onPictureResize,
  focus,
  peeking = false,
  onPeek,
}: ViewportProps) {
  // Where the photograph actually sits inside the picture layer. The canvas is
  // letterboxed (object-fit: contain), so a portrait print on a wide frame, or
  // any print on a desktop, is narrower or shorter than the layer: anything
  // drawn over the picture — the seam's handle, the tags, the focus ring —
  // is placed in this box, never in the layer's.
  const box = useCanvasBox(canvasRef);

  // The tap handler lives in a long-lived effect; it reads these through refs.
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const rootRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  // --- the picture-size grip ----------------------------------------------
  // The height at drag start is the block's own rendered height; from there
  // the gesture is a plain 1:1 pixel transfer. Pointer capture keeps the drag
  // alive when the finger leaves the 22px strip.
  const resizeDrag = useRef<{ startY: number; startH: number } | null>(null);

  const onGripDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!onPictureResize) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeDrag.current = {
      startY: e.clientY,
      startH: rootRef.current?.getBoundingClientRect().height ?? 0,
    };
  };

  const onGripMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = resizeDrag.current;
    if (!d || !onPictureResize) return;
    // The grip hangs at the picture's bottom edge: the seam follows the
    // finger 1:1 — dragging down pulls the edge down and grows the picture,
    // dragging up pushes the edge up and shrinks it.
    onPictureResize(d.startH + (e.clientY - d.startY));
  };

  const onGripEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (resizeDrag.current) {
      resizeDrag.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const nudgeHeight = (delta: number) => {
    const h = rootRef.current?.getBoundingClientRect().height;
    if (h && onPictureResize) onPictureResize(h + delta);
  };

  const zoomRef = useRef<Zoom>(IDENTITY);
  const [zoom, setZoom] = useState<Zoom>(IDENTITY);
  const [animating, setAnimating] = useState(false);
  const animTimer = useRef<number | null>(null);
  const pointers = useRef(new Map<number, Point & { x0: number; y0: number; t0: number }>());
  const pinch = useRef<{ dist: number; mid: Point; centre: Point; origin: Zoom } | null>(null);
  const pan = useRef<{ id: number; down: Point; origin: Zoom } | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);

  // --- the focused view ------------------------------------------------------
  // 'off' in the page; 'on' lifted (or lifting); 'leaving' gliding back, still
  // pinned until the glide has landed.
  const [focusPhase, setFocusPhase] = useState<'off' | 'on' | 'leaving'>('off');
  const [lift, setLift] = useState<Lift | null>(null);
  /** False for the one frame the layer is pinned in place before it moves. */
  const [lifted, setLifted] = useState(false);
  const focusPhaseRef = useRef(focusPhase);
  focusPhaseRef.current = focusPhase;
  const singleTapTimer = useRef<number | null>(null);
  const liftTimer = useRef<number | null>(null);

  // --- hold to peek at the original ----------------------------------------
  const onPeekRef = useRef(onPeek);
  onPeekRef.current = onPeek;
  const peekTimer = useRef<number | null>(null);
  /** The gesture became a peek: its release must not also count as a tap. */
  const peekActive = useRef(false);
  const cancelPeekTimer = () => {
    if (peekTimer.current !== null) window.clearTimeout(peekTimer.current);
    peekTimer.current = null;
  };
  const endPeek = () => {
    cancelPeekTimer();
    if (peekActive.current) {
      peekActive.current = false;
      onPeekRef.current?.(false);
    }
  };

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

  /** Where the picture goes: centred on the screen, as large as it fits. */
  const measureLift = useCallback((): Lift | null => {
    const layer = layerRef.current;
    const canvas = canvasRef.current;
    if (!layer || !canvas) return null;
    const l = layer.getBoundingClientRect();
    const c = canvas.getBoundingClientRect();
    if (c.width < 1 || c.height < 1) return null;
    const vv = window.visualViewport;
    const W = vv?.width ?? window.innerWidth;
    const H = vv?.height ?? window.innerHeight;
    const scale = Math.max(
      1,
      Math.min((W - 2 * LIFT_MARGIN_PX) / c.width, (H - 2 * LIFT_MARGIN_PX) / c.height),
    );
    return {
      rect: { left: l.left, top: l.top, width: l.width, height: l.height },
      origin: { x: c.left - l.left + c.width / 2, y: c.top - l.top + c.height / 2 },
      to: { x: W / 2 - (c.left + c.width / 2), y: H / 2 - (c.top + c.height / 2), scale },
    };
  }, [canvasRef]);

  const openFocused = useCallback(() => {
    if (focusPhaseRef.current === 'on') return;
    if (liftTimer.current !== null) window.clearTimeout(liftTimer.current);
    // The lift is measured on the whole print, not a pinch-zoomed corner of it.
    if (zoomRef.current.scale > 1.001) commit(IDENTITY, false);
    const next = measureLift();
    if (!next) return;
    // Pin first, at exactly where it sits, then move on the next frames: the
    // transition needs a painted start to run from.
    setLift(next);
    setLifted(false);
    setFocusPhase('on');
    requestAnimationFrame(() => requestAnimationFrame(() => setLifted(true)));
  }, [commit, measureLift]);

  const closeFocused = useCallback(() => {
    if (focusPhaseRef.current !== 'on') return;
    setFocusPhase('leaving');
    setLifted(false);
    if (liftTimer.current !== null) window.clearTimeout(liftTimer.current);
    liftTimer.current = window.setTimeout(() => {
      liftTimer.current = null;
      setFocusPhase('off');
      setLift(null);
    }, LIFT_MS);
  }, []);
  const closeFocusedRef = useRef(closeFocused);
  closeFocusedRef.current = closeFocused;
  const openFocusedRef = useRef(openFocused);
  openFocusedRef.current = openFocused;

  // Escape closes it; a rotation or a resize re-measures the target so the
  // print keeps filling the screen it is on.
  useEffect(() => {
    if (focusPhase !== 'on') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeFocusedRef.current();
    };
    const onResize = () => {
      setLift((prev) => {
        if (!prev) return prev;
        const layer = layerRef.current;
        const canvas = canvasRef.current;
        if (!layer || !canvas) return prev;
        // The pinned box stays put; only where it is carried to changes.
        const r = prev.rect;
        const cw = canvas.offsetWidth;
        const ch = canvas.offsetHeight;
        const cx = r.left + prev.origin.x;
        const cy = r.top + prev.origin.y;
        const vv = window.visualViewport;
        const W = vv?.width ?? window.innerWidth;
        const H = vv?.height ?? window.innerHeight;
        const scale = Math.max(1, Math.min((W - 2 * LIFT_MARGIN_PX) / cw, (H - 2 * LIFT_MARGIN_PX) / ch));
        return { ...prev, to: { x: W / 2 - cx, y: H / 2 - cy, scale } };
      });
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
    };
  }, [focusPhase, canvasRef]);

  useEffect(
    () => () => {
      if (singleTapTimer.current !== null) window.clearTimeout(singleTapTimer.current);
      if (liftTimer.current !== null) window.clearTimeout(liftTimer.current);
    },
    [],
  );

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
      // One still finger may become a peek; a second finger makes it a pinch.
      cancelPeekTimer();
      if (pointers.current.size === 1 && onPeekRef.current) {
        peekTimer.current = window.setTimeout(() => {
          peekTimer.current = null;
          peekActive.current = true;
          onPeekRef.current?.(true);
        }, PEEK_DELAY_MS);
      }
      // An interrupting gesture starts from the *presentation* value: a
      // running settle animation's live on-screen transform, not the target
      // it was heading for — grabbing mid-flight must never jump.
      if (animTimer.current !== null) {
        const t = layerRef.current ? getComputedStyle(layerRef.current).transform : 'none';
        if (t !== 'none') {
          const m = new DOMMatrixReadOnly(t);
          commit({ scale: m.a, x: m.e, y: m.f }, false);
        } else {
          commit(zoomRef.current, false);
        }
      }
      // Lifted, the print is for looking at: a hold still peeks and a tap puts
      // it back, but it does not pinch or pan.
      if (focusPhaseRef.current !== 'off') {
        e.preventDefault();
        return;
      }
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
      // Moving before the hold lands makes it a scroll, pan or pinch, not a
      // peek. Once the original is showing it stays until the finger lifts.
      if (peekTimer.current !== null && (pointers.current.size > 1 || Math.hypot(p.x - p.x0, p.y - p.y0) > PEEK_SLOP_PX)) {
        cancelPeekTimer();
      }
      const { w, h } = frameGeometry();
      if (pinch.current && pointers.current.size >= 2) {
        const pts = [...pointers.current.values()];
        const a = pts[0]!;
        const b = pts[1]!;
        const g = pinch.current;
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const scale = Math.min(ZOOM_MAX, Math.max(1, (g.origin.scale * dist) / g.dist));
        commit(resistance(zoomedAround(g.mid, g.centre, g.origin, scale), w, h));
      } else if (pan.current && pan.current.id === e.pointerId) {
        const g = pan.current;
        commit(
          resistance(
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
      // Letting go ends a peek, and a peek is the whole gesture: no tap, no
      // focus point, no half of a double-tap.
      if (p && pointers.current.size === 0) {
        const wasPeek = peekActive.current;
        endPeek();
        if (wasPeek) {
          lastTap.current = null;
          return;
        }
      }
      if (pinch.current && pointers.current.size < 2) pinch.current = null;
      if (pan.current && pan.current.id === e.pointerId) pan.current = null;
      // The gesture's end settles the rubber band: wherever the finger
      // released past the bounds, the picture glides the rest of the way
      // home instead of hanging over the edge.
      if (p && !pinch.current && !pan.current) {
        const { w, h } = frameGeometry();
        const z = zoomRef.current;
        const c = clamped(z, w, h);
        if (c.x !== z.x || c.y !== z.y) commit(c, true);
      }
      if (!p || e.type !== 'pointerup' || pointers.current.size > 0) return;
      // A quick, still release is a tap. Two taps, near each other, are a
      // double-tap: in to 2.5x around the tap, or back out to the full print.
      const quick = performance.now() - p.t0 < 300 && Math.hypot(p.x - p.x0, p.y - p.y0) < 8;
      if (!quick) return;
      // Lifted: a tap anywhere on the print puts it back.
      if (focusPhaseRef.current !== 'off') {
        lastTap.current = null;
        closeFocusedRef.current();
        return;
      }
      // In the focus view a tap is a focus point, wherever the picture has
      // been zoomed to: the canvas's box already carries the transform.
      const f = focusRef.current;
      const canvas = canvasRef.current;
      if (f && modeRef.current === 'focus' && canvas) {
        const r = canvas.getBoundingClientRect();
        const x = (p.x - r.left) / r.width;
        const y = (p.y - r.top) / r.height;
        if (x >= 0 && x <= 1 && y >= 0 && y <= 1) f.onPick(x, y);
      }
      const now = performance.now();
      const last = lastTap.current;
      lastTap.current = { t: now, x: p.x, y: p.y };
      if (!last || now - last.t > SINGLE_TAP_MS || Math.hypot(p.x - last.x, p.y - last.y) > 24) {
        // A first tap. Unless a second follows, it opens the focused view —
        // except in the focus inspect mode, where a tap is a focus point.
        if (singleTapTimer.current !== null) window.clearTimeout(singleTapTimer.current);
        singleTapTimer.current = null;
        if (!(f && modeRef.current === 'focus')) {
          singleTapTimer.current = window.setTimeout(() => {
            singleTapTimer.current = null;
            openFocusedRef.current();
          }, SINGLE_TAP_MS);
        }
        return;
      }
      // The second tap of a double-tap: the first one's focused view is off.
      if (singleTapTimer.current !== null) window.clearTimeout(singleTapTimer.current);
      singleTapTimer.current = null;
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
  }, [commit, frameGeometry, canvasRef]);

  // The keyboard's peek: hold backslash (Lightroom's before/after key). Not
  // while typing into a field, and a key repeat is one hold, not many.
  useEffect(() => {
    const typing = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) && (t as HTMLInputElement).type !== 'range');
    const down = (e: KeyboardEvent) => {
      if (e.key !== '\\' || e.repeat || typing(e.target) || !onPeekRef.current) return;
      e.preventDefault();
      peekActive.current = true;
      onPeekRef.current(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key !== '\\') return;
      endPeek();
    };
    const blur = () => endPeek();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
    // endPeek only touches refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    <div
      className={`viewport${focusPhase !== 'off' ? ' is-focused' : ''}${lifted ? ' is-lifted' : ''}`}
      ref={rootRef}
    >
      <div
        className="viewport__backdrop"
        aria-hidden="true"
        onPointerDown={(e) => {
          e.preventDefault();
          closeFocused();
        }}
      />
      <div className="viewport__bar">
        <SegmentedControl
          label="Inspect stage"
          value={mode}
          options={focus ? [...MODES, FOCUS_MODE] : MODES}
          onChange={onModeChange}
        />
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
          className={`viewport__zoom${zoomed ? ' is-zoomed' : ''}${animating ? ' is-animating' : ''}${
            lift ? ' is-pinned' : ''
          }`}
          style={
            lift
              ? {
                  left: lift.rect.left,
                  top: lift.rect.top,
                  width: lift.rect.width,
                  height: lift.rect.height,
                  transformOrigin: `${lift.origin.x}px ${lift.origin.y}px`,
                  transform: lifted
                    ? `translate3d(${lift.to.x}px, ${lift.to.y}px, 0) scale(${lift.to.scale})`
                    : 'translate3d(0, 0, 0) scale(1)',
                }
              : { transform: `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.scale})` }
          }
          onPointerDown={onPointerDown}
        >
          <canvas ref={canvasRef} className="viewport__canvas" />
          {focus && mode === 'focus' && box ? (
            <span
              className="viewport__focus"
              aria-hidden="true"
              style={{ left: box.left + focus.x * box.width, top: box.top + focus.y * box.height }}
            />
          ) : null}
          {comparing && box && !peeking ? (
            <button
              type="button"
              className="viewport__handle"
              // On the seam the shader draws — the same fraction of the
              // picture's width — and exactly as tall as the picture.
              style={{ left: box.left + split * box.width, top: box.top, height: box.height }}
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
          {peeking && box ? (
            <span
              className="viewport__tag viewport__peek-tag"
              role="status"
              style={{ left: box.left + box.width / 2, top: box.top + 8 }}
            >
              Original
            </span>
          ) : null}
          {comparing && box && !peeking ? (
            <>
              <span className="viewport__tag" style={{ left: box.left + 8, top: box.top + 8 }}>
                Original
              </span>
              <span
                className="viewport__tag"
                style={{ right: `calc(100% - ${box.left + box.width - 8}px)`, top: box.top + 8 }}
              >
                Edited
              </span>
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

      {onPictureResize ? (
        <div
          className="viewport__grip"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Picture size"
          title="Drag to resize the picture"
          tabIndex={0}
          onKeyDown={(e) => {
            // The arrows move the edge, matching the drag: down grows the
            // picture, up shrinks it.
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              nudgeHeight(-48);
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              nudgeHeight(48);
            }
          }}
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripEnd}
          onPointerCancel={onGripEnd}
        />
      ) : null}
    </div>
  );
}

/**
 * The canvas's untransformed layout box inside the picture layer, kept current
 * as the picture or the frame resizes. Offsets, not a client rect, so the
 * zoom transform (which carries the layer and everything in it) does not
 * enter into it.
 */
function useCanvasBox(canvasRef: React.RefObject<HTMLCanvasElement>) {
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () =>
      setBox((prev) => {
        const next = {
          left: canvas.offsetLeft,
          top: canvas.offsetTop,
          width: canvas.offsetWidth,
          height: canvas.offsetHeight,
        };
        return prev &&
          prev.left === next.left &&
          prev.top === next.top &&
          prev.width === next.width &&
          prev.height === next.height
          ? prev
          : next;
      });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(canvas);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    return () => ro.disconnect();
  }, [canvasRef]);
  return box;
}
