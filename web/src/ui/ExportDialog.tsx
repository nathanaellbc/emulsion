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
 * and "Source" — the photograph's own size, pixel for pixel. The print is
 * rendered in tiles (renderer.ts, renderTiled), so the size is bounded by
 * nothing but the largest canvas the browser can encode, not by how much
 * GPU memory the whole graph would want at once. Grain,
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
  applyMetadata,
  extractExifBlock,
  formatCarriesExif,
  synthesizedExifBlock,
} from '../io/metadata';
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
import { ExportCancelledError, type Renderer, type ViewOptions } from '../gl/renderer';
import { isAppleMobile } from '../depth/model';
import { Choice, Slider, Toggle } from './controls';

const STORAGE_KEY = 'emulsion.export.v1';

/** Long-edge detents, in render width for a landscape frame. */
const WIDTH_DETENTS = [2048, 4096, 8192] as const;

/** Lossy formats default to their best: the export is the deliverable. */
const DEFAULT_QUALITY = 100;

/**
 * The largest image this browser can hold in one canvas and encode. iOS
 * Safari refuses canvases over 16.7 MP; desktop engines allow far more, up
 * to 32 767 px on a side.
 */
function canvasLimits(): { area: number; side: number } {
  return isAppleMobile() ? { area: 16_777_216, side: 16_384 } : { area: 268_435_456, side: 32_767 };
}

interface ExportPrefs {
  formatId: ExportFormatId;
  quality: number;
  /** null = the source's own width. */
  longEdge: number | null;
  /** Reattach the source file's EXIF to the export. */
  keepMeta: boolean;
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
        longEdge: typeof p.longEdge === 'number' ? p.longEdge : null,
        keepMeta: p.keepMeta ?? true,
      };
    }
  } catch {
    // A corrupt stored preference is not worth a broken export.
  }
  // The photograph's own size is the default: nothing is thrown away unless asked.
  return { formatId: 'png', quality: DEFAULT_QUALITY, longEdge: null, keepMeta: true };
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
  /** The source file's EXIF, orientation-normalised, ready to reattach. */
  const [exif, setExif] = useState<Uint8Array | null>(null);

  // The source file's own EXIF block, or for a RAW whose container yields
  // nothing parseable, a minimal one synthesised from what LibRaw reported.
  // Extracted while the settings are chosen, so the splice never waits on it.
  useEffect(() => {
    let alive = true;
    void extractExifBlock(source.file).then((block) => {
      if (!alive) return;
      if (block) setExif(block);
      else if (source.kind === 'raw')
        setExif(
          synthesizedExifBlock({
            camera: source.camera,
            iso: source.iso,
            shutter: source.shutter,
            aperture: source.aperture,
            focalLength: source.focalLength,
          }),
        );
    });
    return () => {
      alive = false;
    };
  }, [source]);
  const [rendering, setRendering] = useState(true);
  /** Tiles done / total while a render is in flight. */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [encoding, setEncoding] = useState(true);
  /** A failure the user must see *here*, not behind the backdrop. */
  const [failure, setFailure] = useState<string | null>(null);
  /** One confirmation beat between the save landing and the bench closing. */
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<number | null>(null);
  /** Closing plays the exit, then unmounts — the same path in reverse. */
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<number | null>(null);

  const reducedMotion = useRef(
    typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
  );

  const requestClose = useCallback(() => {
    if (closeTimer.current !== null) return;
    if (reducedMotion.current) {
      onClose();
      return;
    }
    setClosing(true);
    closeTimer.current = window.setTimeout(onClose, 190);
  }, [onClose]);

  useEffect(
    () => () => {
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    [],
  );

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

  // --- the resolution detents this image can be exported at ------------------
  //
  // A detent is offered only when it genuinely downscales: on a 1200 px source
  // every detent would collapse onto "Source", which is four buttons for one
  // result. The render is tiled, so GPU memory no longer bounds the size —
  // only the largest canvas this browser can encode does, and a source beyond
  // that (a 48 MP file on an iPhone) is offered at the canvas's limit, with
  // the note saying so.
  const detents = useMemo(() => {
    const limits = canvasLimits();
    const sourceLong = Math.max(sourceW, sourceH);
    const byArea = Math.sqrt(limits.area / (sourceW * sourceH)) * sourceLong;
    const cap = Math.floor(Math.min(sourceLong, limits.side, byArea));
    const out: {
      longEdge: number | null;
      label: string;
      width: number;
      height: number;
      note?: string;
    }[] = [];
    for (const d of WIDTH_DETENTS) {
      if (d >= cap) continue;
      const width = Math.round((sourceW * d) / sourceLong);
      const height = Math.round((sourceH * d) / sourceLong);
      out.push({ longEdge: d, label: String(d), width, height });
    }
    const width = Math.round((sourceW * cap) / sourceLong);
    const height = Math.round((sourceH * cap) / sourceLong);
    const capped = cap < sourceLong;
    out.push({
      longEdge: null,
      label: capped ? `Max · ${cap}` : `Source · ${sourceLong}`,
      width,
      height,
      note: capped
        ? `the largest image this browser can encode — the file's own ${sourceLong} px is beyond it`
        : undefined,
    });
    return out;
  }, [sourceW, sourceH]);

  // A stored detent may not be on offer for this image; fall back to Source
  // rather than rendering at a width nothing selected.
  const selected =
    detents.find((d) => d.longEdge === prefs.longEdge) ?? detents[detents.length - 1]!;

  // The export renders at exactly the selected detent's advertised size.
  const widthCap = selected.width;
  const heightCap = selected.height;

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

  // --- focus, keyboard, focus return ----------------------------------------
  //
  // A modal bench holds the tab: without a trap, Tab walks out of the dialog
  // into the disabled-but-present top bar behind the backdrop, and focus is
  // lost somewhere the user cannot see. Escape cancels; focus returns to
  // whatever opened the bench.
  useEffect(() => {
    const el = dialogRef.current;
    const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    el?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        requestClose();
        return;
      }
      if (e.key !== 'Tab' || !el) return;
      const focusables = Array.from(
        el.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && el.contains(active);
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      restore?.focus();
    };
  }, [requestClose]);

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
    async (w: number, h: number, isCancelled: () => boolean) => {
      if (renderer.contextLost) {
        throw new Error('The graphics context was lost. Reload the page to continue.');
      }
      // Resolved at the export's own size: grain, halation, glow and the lens
      // are physical sizes, so this is a real render at this pixel pitch, not
      // the preview scaled up. The focus point's disparity is a property of
      // the photograph, not of the size; the preview's resolve already read it.
      const exportParams = resolve(recipe, {
        renderWidthPx: w,
        renderHeightPx: h,
        sourceSpace,
        sceneMiddleGrey: resolvedRef.current.sceneMiddleGrey,
        focusDisparity: resolvedRef.current.defocus.enabled
          ? resolvedRef.current.defocus.focusDisparity
          : null,
      });
      // The measured engine's LUT must be on its texture unit before the
      // render that will read it — the same sequencing the live loop uses,
      // keyed by the illuminant actually rendered.
      const { printId } = exportParams.recipe;
      const illuminant = exportParams.printLut?.illuminant;
      const lut = illuminant ? loadedPrintLut(printId, illuminant) : null;
      renderer.setPrintLut(lut, illuminant && lut ? `${printId}:${illuminant}` : '');

      const canvas = canvasRef.current;
      if (!canvas) throw new Error('the export canvas disappeared');
      canvas.width = w;
      canvas.height = h;
      // The export canvas takes the render's own encoding, so a P3 print is
      // encoded with a P3 profile instead of being clipped to sRGB.
      const ctx2d =
        (canvas.getContext('2d', { colorSpace: renderer.outputColorSpace }) as CanvasRenderingContext2D | null) ??
        canvas.getContext('2d');
      if (!ctx2d) throw new Error('this browser gave no 2D canvas to assemble the export on');
      try {
        await renderer.renderTiled(
          exportParams,
          w,
          h,
          (tile, x, y) => ctx2d.putImageData(tile, x, y),
          (done, total) => setProgress({ done, total }),
          isCancelled,
        );
      } finally {
        // The tiles took the graph; give the preview its frame back.
        renderer.render(resolvedRef.current, viewRef.current);
      }
    },
    [recipe, sourceSpace, renderer],
  );

  // Render on open and whenever the detent changes, debounced so the graph
  // is not reallocated while the user is still choosing. A render still
  // running for a previous detent is abandoned between tiles.
  useEffect(() => {
    setRendering(true);
    setProgress(null);
    setBlob(null);
    let cancelled = false;
    const t = window.setTimeout(() => {
      renderExport(widthCap, heightCap, () => cancelled).then(
        () => {
          if (cancelled) return;
          setRendering(false);
          setProgress(null);
          setFailure(null);
        },
        (err: unknown) => {
          if (cancelled || err instanceof ExportCancelledError) return;
          setRendering(false);
          setProgress(null);
          setFailure(err instanceof Error ? err.message : String(err));
        },
      );
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [renderExport, widthCap, heightCap]);

  // Encode from the canvas when a render has landed or format/quality moved.
  // Debounced: the quality slider fires continuously and only the settled
  // position is worth encoding. The metadata splice happens inside this step,
  // so the measured size the quality control shows is the spliced file's own.
  useEffect(() => {
    const f = format;
    const canvas = canvasRef.current;
    if (!f || !canvas || rendering) return;
    let alive = true;
    setEncoding(true);
    const t = window.setTimeout(() => {
      const keep = prefs.keepMeta && exif && formatCarriesExif(f) ? exif : null;
      void encodeImage(canvas, f, prefs.quality / 100)
        .then((b) => applyMetadata(b, f, keep))
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
  }, [format, prefs.quality, rendering, prefs.keepMeta, exif]);

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
        if (r === 'cancelled' || r === 'shared') requestClose();
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
      // The browser's download chrome is not the app's last word: the bench
      // stays a beat, names the save, then closes itself.
      setSaved(true);
      if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(requestClose, 1000);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    }
  };

  // The detent row is a radiogroup: one tab stop, arrows walk it.
  const detentsRef = useRef<HTMLDivElement>(null);
  const onDetentKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const group = detentsRef.current;
    if (!group) return;
    const radios = Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    if (radios.length < 2) return;
    const current = radios.findIndex((b) => b.getAttribute('aria-checked') === 'true');
    const step = e.key === 'ArrowRight' ? 1 : -1;
    const next = radios[(current + step + radios.length) % radios.length]!;
    e.preventDefault();
    next.focus();
    const d = detents[Number(next.dataset.index)];
    if (d) setPrefs((p) => ({ ...p, longEdge: d.longEdge }));
  };

  const saveDisabled = !blob || rendering;
  const sizeLabel = !rendering && !encoding && blob ? formatBytes(blob.size) : '';
  // What the primary action says while the file does not exist yet: which
  // tile of how many, then the encode — a native-size export on a phone takes
  // long enough that "Preparing…" would read as stuck.
  const busyLabel = rendering
    ? progress && progress.total > 1
      ? `Rendering ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
      : 'Rendering…'
    : 'Encoding…';

  return (
    <div
      className={`export__backdrop${closing ? ' is-closing' : ''}`}
      onClick={requestClose}
    >
      <div
        ref={dialogRef}
        className={`export${closing ? ' is-closing' : ''}`}
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

          {exif ? (
            <Toggle
              label="Keep photo metadata"
              checked={prefs.keepMeta}
              onChange={(v) => setPrefs((p) => ({ ...p, keepMeta: v }))}
              hint={
                format && !formatCarriesExif(format)
                  ? 'this browser cannot write EXIF into this format; PNG or JPEG keeps it'
                  : 'camera, lens, exposure and capture time, with orientation corrected'
              }
            />
          ) : null}

          <div className="control">
            <div className="control__row">
              <span className="control__label">Long edge</span>
            </div>
            <div
              className="export__detents"
              role="radiogroup"
              aria-label="Long edge"
              ref={detentsRef}
              onKeyDown={onDetentKeyDown}
            >
              {detents.map((d, i) => (
                <button
                  key={d.label}
                  type="button"
                  role="radio"
                  data-index={i}
                  aria-checked={selected.longEdge === d.longEdge}
                  className={`export__opt${selected.longEdge === d.longEdge ? ' is-on' : ''}`}
                  title={
                    d.note
                      ? `${d.width} × ${d.height} px — ${d.note}`
                      : `${d.width} × ${d.height} px`
                  }
                  onClick={() => setPrefs((p) => ({ ...p, longEdge: d.longEdge }))}
                >
                  {d.label === 'Source' ? `Source · ${Math.max(sourceW, sourceH)}` : d.label}
                  <span className="sr-only">{` — ${d.width} × ${d.height} px`}</span>
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
          <button type="button" className="btn" onClick={requestClose}>
            Cancel
          </button>
          {shareable ? (
            <>
              <button type="button" className="btn" onClick={doDownload} disabled={saveDisabled}>
                {saved ? 'Saved' : 'Download'}
              </button>
              <button
                type="button"
                className="btn btn--primary btn--lg export__save"
                onClick={doShare}
                disabled={saveDisabled}
              >
                {saveDisabled ? busyLabel : 'Save to Photos'}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn--primary btn--lg export__save"
              onClick={doDownload}
              disabled={saveDisabled}
            >
              {saved
                ? 'Saved'
                : saveDisabled || encoding
                  ? busyLabel
                  : sizeLabel
                    ? `Download · ${sizeLabel}`
                    : 'Download'}
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
