/**
 * The export bench.
 *
 * The controls carry the same discipline the rest of the panel does: no
 * setting is offered that this browser cannot honour, and the quality control
 * reports a *measured* file size — the print is re-encoded as the slider
 * settles, so the number shown is the file the button produces, not an
 * estimate of it. Nothing is labelled "high/medium/low", because "quality 78"
 * is not a quantity and a byte count is.
 *
 * Resolution is long-edge detents that genuinely downscale, never upscale,
 * and are bounded by the GL context's own maximum texture size. Grain,
 * halation and interlayer are physical sizes, so a finer export is not "the
 * same image, bigger": it carries finer physical stages than the preview
 * could (DEVIATIONS.md, finding 7), and the dialog says so where the choice
 * is made.
 *
 * Sequencing is load-bearing on the save buttons: the print is rendered and
 * encoded while the settings are being chosen, so the primary action is
 * instant, and `navigator.share` — which must run inside the user gesture on
 * iOS — receives a blob that already exists rather than one promised by an
 * await between the tap and the sheet.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolve, type ResolvedParameters, type SourceSpace } from '../core/resolve';
import type { Recipe } from '../core/recipe';
import { loadedPrintLut } from '../core/printLuts';
import type { DecodedSource } from '../io/decode';
import {
  canShareImages,
  detectFormats,
  encodeImage,
  exportFileName,
  formatBytes,
  saveViaDownload,
  saveViaShare,
  type ExportFormat,
  type ExportFormatId,
} from '../io/export';
import type { Renderer, ViewOptions } from '../gl/renderer';
import { Choice, Slider } from './controls';

const STORAGE_KEY = 'emulsion.export.v1';

/** Long-edge detents, in render width for a landscape frame. */
const WIDTH_DETENTS = [2048, 4096, 8192] as const;

const DEFAULT_QUALITY = 90;

interface ExportPrefs {
  formatId: ExportFormatId;
  quality: number;
  /** null = the source's own width. */
  longEdge: number | null;
}

export interface ExportDialogProps {
  source: DecodedSource;
  recipe: Recipe;
  sourceSpace: SourceSpace;
  renderer: Renderer;
  /** The view to repaint when the dialog's renders are done with the graph. */
  view: Pick<ViewOptions, 'mode' | 'split' | 'clipWarning'>;
  resolved: ResolvedParameters;
  onClose: () => void;
}

function loadPrefs(): ExportPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<ExportPrefs>;
      return {
        formatId: (p.formatId ?? 'png') as ExportFormatId,
        quality: typeof p.quality === 'number' ? p.quality : DEFAULT_QUALITY,
        longEdge: typeof p.longEdge === 'number' ? p.longEdge : 4096,
      };
    }
  } catch {
    // A corrupt stored preference is not worth a broken export.
  }
  return { formatId: 'png', quality: DEFAULT_QUALITY, longEdge: 4096 };
}

export function ExportDialog({
  source,
  recipe,
  sourceSpace,
  renderer,
  view,
  resolved,
  onClose,
}: ExportDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Props the render callbacks read but must not re-trigger them: identity
  // churn on these would re-render the export for no reason.
  const viewRef = useRef(view);
  const resolvedRef = useRef(resolved);
  viewRef.current = view;
  resolvedRef.current = resolved;

  const [formats, setFormats] = useState<readonly ExportFormat[] | null>(null);
  const [prefs, setPrefs] = useState<ExportPrefs>(loadPrefs);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [rendering, setRendering] = useState(true);
  const [encoding, setEncoding] = useState(true);
  /** A failure the user must see *here*, not behind the backdrop. */
  const [failure, setFailure] = useState<string | null>(null);

  // The share sheet is the phone's route to the photo library. A desktop
  // browser's own share target is not what "save to photos" means there, so
  // the share path is offered to touch pointers that can share files, and
  // Download stays the primary everywhere else.
  const shareable = useMemo(
    () => window.matchMedia?.('(pointer: coarse)').matches === true && canShareImages(),
    [],
  );

  const sourceW = source.image.width;
  const sourceH = source.image.height;

  // --- the resolution detents this image and this GPU can actually offer ----
  //
  // A detent is offered only when it genuinely downscales: on a 1200 px source
  // every detent would collapse onto "Source", which is four buttons for one
  // result. Sizes above the context's own maximum texture dimension cannot be
  // allocated at all, so they are absent rather than present and failing.
  // The memory budget matters more than the dimension on a phone: rendering
  // the full 12 MP source means dozens of float surfaces at once, and a GPU
  // that will not give that up loses the context — the black-screen failure
  // this guard exists to prevent. A source above the budget is offered at the
  // budget, and the note says so rather than letting "Source" mean a size
  // that cannot be rendered.
  const detents = useMemo(() => {
    const cap = Math.min(renderer.maxTextureSize, renderer.maxExportLongEdge);
    const sourceLong = Math.max(sourceW, sourceH);
    const out: { longEdge: number | null; label: string; width: number; height: number }[] = [];
    for (const d of WIDTH_DETENTS) {
      if (d >= sourceLong || d > cap) continue;
      const width = Math.round((sourceW * d) / sourceLong);
      const height = Math.round((sourceH * d) / sourceLong);
      out.push({ longEdge: d, label: String(d), width, height });
    }
    // The source's own size, capped by what this GPU can actually render.
    const s = Math.min(sourceLong, cap);
    const width = Math.round((sourceW * s) / sourceLong);
    const height = Math.round((sourceH * s) / sourceLong);
    const capped = s < sourceLong;
    out.push({
      longEdge: null,
      label: capped ? `Capped · ${s}` : 'Source',
      width,
      height,
    });
    return out;
  }, [renderer, sourceW, sourceH]);

  // A stored detent may not be on offer for this image; fall back to Source
  // rather than rendering at a width nothing selected.
  const selected =
    detents.find((d) => d.longEdge === prefs.longEdge) ?? detents[detents.length - 1]!;

  // renderAtResolution caps by width, so a portrait export at long edge L asks
  // for the width that produces a height of L.
  const widthCap =
    selected.longEdge === null || sourceW >= sourceH
      ? Math.min(selected.longEdge ?? sourceW, sourceW)
      : Math.min(Math.round((selected.longEdge! * sourceW) / sourceH), sourceW);

  const format = useMemo(() => {
    if (!formats) return null;
    return formats.find((f) => f.id === prefs.formatId) ?? formats[0]!;
  }, [formats, prefs.formatId]);

  // --- format probing, once ---
  useEffect(() => {
    let alive = true;
    void detectFormats().then((f) => {
      if (alive) setFormats(f);
    });
    return () => {
      alive = false;
    };
  }, []);

  // --- focus, keyboard, focus return ---
  useEffect(() => {
    const el = dialogRef.current;
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    el?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      restore?.focus();
    };
  }, [onClose]);

  // --- persistence ---
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // A preference that will not persist is a nuisance, not a failure.
    }
  }, [prefs]);

  // --- the render + encode pipeline ----------------------------------------
  //
  // Phase 1 (render): re-resolve at the export's pixel pitch and render into
  // the hidden canvas. Grain and halation scale with pitch, so this is a real
  // render, not a resize. Phase 2 (encode): canvas -> blob, re-run when format
  // or quality changes with no GL work at all. The buttons stay armed on the
  // previous blob while a replacement is produced — except across a
  // *resolution* change, where the old blob is a different size and is
  // withdrawn until the new one exists.

  const renderExport = useCallback(
    (w: number) => {
      if (renderer.contextLost) {
        throw new Error(
          'The graphics context was lost — the phone ran out of GPU memory. Reload the page and export at a smaller size.',
        );
      }
      const exportParams = resolve(recipe, { renderWidthPx: w, sourceSpace });
      // The measured engine's LUT must be on its texture unit before the
      // render that will read it — the same sequencing the live loop uses.
      const { printId, printIlluminant } = exportParams.recipe;
      const lut = exportParams.printLut ? loadedPrintLut(printId, printIlluminant) : null;
      renderer.setPrintLut(lut, exportParams.printLut && lut ? `${printId}:${printIlluminant}` : '');
      const data = renderer.renderAtResolution(
        exportParams,
        { mode: 'print', split: 0, clipWarning: false },
        w,
      );
      if (renderer.contextLost) {
        throw new Error(
          'The graphics context was lost while rendering — the phone ran out of GPU memory. Reload the page and export at a smaller size.',
        );
      }
      const canvas = canvasRef.current;
      if (!canvas) throw new Error('the export canvas disappeared');
      canvas.width = data.width;
      canvas.height = data.height;
      canvas.getContext('2d')!.putImageData(data, 0, 0);
      // renderAtResolution restored the preview allocation but left it blank.
      renderer.render(resolvedRef.current, viewRef.current);
    },
    [recipe, sourceSpace, renderer],
  );

  // Render on open and whenever the detent changes, debounced so the graph
  // is not reallocated while the user is still choosing.
  useEffect(() => {
    setRendering(true);
    const t = window.setTimeout(() => {
      try {
        renderExport(widthCap);
        setRendering(false);
        setFailure(null);
      } catch (err) {
        setRendering(false);
        setFailure(err instanceof Error ? err.message : String(err));
      }
    }, 250);
    return () => window.clearTimeout(t);
  }, [renderExport, widthCap]);

  // Encode from the canvas when a render has landed or format/quality moved.
  // Debounced: the quality slider fires continuously and only the settled
  // position is worth encoding.
  useEffect(() => {
    const f = format;
    const canvas = canvasRef.current;
    if (!f || !canvas || rendering) return;
    let alive = true;
    setEncoding(true);
    const t = window.setTimeout(() => {
      void encodeImage(canvas, f, prefs.quality / 100)
        .then((b) => {
          if (!alive) return;
          setBlob(b);
          setEncoding(false);
          setFailure(null);
        })
        .catch((err: unknown) => {
          if (!alive) return;
          setBlob(null);
          setEncoding(false);
          setFailure(err instanceof Error ? err.message : String(err));
        });
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [format, prefs.quality, rendering]);

  const fileName = format
    ? exportFileName(
        source.fileName,
        resolved.negative.displayName,
        resolved.print.displayName,
        format.ext,
      )
    : '';

  // --- the save actions -----------------------------------------------------
  //
  // Both receive a blob that is already in hand. The share path especially:
  // no awaited work may stand between the gesture and navigator.share, which
  // iOS requires.

  const doShare = () => {
    const b = blob;
    if (!b || !format) return;
    // The call into navigator.share happens synchronously with the gesture;
    // only the await of its result is asynchronous.
    const outcome = saveViaShare(b, fileName);
    void outcome.then(
      (r) => {
        // A dismissed sheet is the user changing their mind, not a failure.
        if (r === 'cancelled' || r === 'shared') onClose();
      },
      (err: unknown) => {
        setFailure(err instanceof Error ? err.message : String(err));
      },
    );
  };

  const doDownload = () => {
    if (!blob || !format) return;
    try {
      saveViaDownload(blob, fileName);
      onClose();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    }
  };

  const saveDisabled = !blob || rendering;
  const sizeLabel = rendering ? 'rendering…' : encoding ? 'measuring…' : blob ? formatBytes(blob.size) : '';

  return (
    <div className="export__backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="export"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="export__head">
          <h2 className="label" id="export-title">
            Export print
          </h2>
          <span className="export__dims num">
            {rendering ? '—' : `${selected.width} × ${selected.height} px`}
          </span>
        </header>

        <div className="export__body">
          {formats ? (
            <Choice
              label="Format"
              value={format!.id}
              options={formats.map((f) => ({ value: f.id, label: f.label, detail: f.note }))}
              hint="Offered only where this browser's own encoder produces it — a type it silently substitutes is not listed."
              onChange={(id) => setPrefs((p) => ({ ...p, formatId: id as ExportFormatId }))}
            />
          ) : (
            <p className="control__hint">Detecting what this browser can encode…</p>
          )}

          {format?.lossy ? (
            <Slider
              label="Quality"
              value={prefs.quality}
              min={1}
              max={100}
              step={1}
              format={(v) => (encoding ? `${v} · measuring…` : `${v} · ${blob ? formatBytes(blob.size) : '—'}`)}
              detents={[60, 80, 90, 100]}
              hint="The size is measured, not estimated: the print is re-encoded as the slider settles, so the number shown is the file the button produces."
              onChange={(v) => setPrefs((p) => ({ ...p, quality: v }))}
            />
          ) : null}

          <div className="control">
            <div className="control__row">
              <span className="control__label">Long edge</span>
            </div>
            <div className="export__detents" role="radiogroup" aria-label="Long edge">
              {detents.map((d) => (
                <button
                  key={d.label}
                  type="button"
                  role="radio"
                  aria-checked={selected.longEdge === d.longEdge}
                  className={`export__opt${selected.longEdge === d.longEdge ? ' is-on' : ''}`}
                  title={`${d.width} × ${d.height} px`}
                  onClick={() => setPrefs((p) => ({ ...p, longEdge: d.longEdge }))}
                >
                  {d.label === 'Source' ? `Source · ${Math.max(sourceW, sourceH)}` : d.label}
                </button>
              ))}
            </div>
            <p className="control__hint">
              Grain, halation and interlayer are physical sizes in micrometres, so the export is
              rendered again at this width's own pixel pitch rather than scaled — a finer one
              carries finer stages than the preview showed.
            </p>
          </div>

          {failure ? <p className="control__hint export__fail num">{failure}</p> : null}

          <p className="export__file num" title={fileName}>
            {fileName || '—'}
          </p>
        </div>

        <footer className="export__actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          {shareable ? (
            <>
              <button type="button" className="btn" onClick={doDownload} disabled={saveDisabled}>
                Download
              </button>
              <button
                type="button"
                className="btn btn--primary btn--lg export__save"
                onClick={doShare}
                disabled={saveDisabled}
              >
                {saveDisabled ? 'Preparing…' : 'Save to Photos'}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn--primary btn--lg export__save"
              onClick={doDownload}
              disabled={saveDisabled}
            >
              {saveDisabled ? 'Preparing…' : sizeLabel ? `Download · ${sizeLabel}` : 'Download'}
            </button>
          )}
        </footer>

        {/* The print lives here between render and encode. Hidden from view —
            its raster is what toBlob reads, not its layout box. */}
        <canvas ref={canvasRef} className="export__canvas" aria-hidden="true" />
      </div>
    </div>
  );
}
