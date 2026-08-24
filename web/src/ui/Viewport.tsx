/**
 * The viewport. The photograph is the only bright object in the room, so the
 * chrome around it stays out of the way: controls fade in on hover, and the
 * comparison seam is a thin amber line rather than a widget.
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
  const [dragging, setDragging] = useState(false);

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
        <canvas ref={canvasRef} className="viewport__canvas" />
        {comparing ? (
          <button
            type="button"
            className="viewport__handle"
            style={{ left: `${split * 100}%` }}
            onPointerDown={(e) => {
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

      <div className="viewport__foot">
        <span className="viewport__file num">{fileName ?? '—'}</span>
        {caption ? <span className="viewport__caption">{caption}</span> : null}
      </div>
    </div>
  );
}
