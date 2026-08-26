import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clampRecipe, defaultRecipe, type Recipe } from '../core/recipe';
import { NEGATIVES } from '../core/profiles/negatives';
import { PRINT_STOCKS } from '../core/profiles/printStocks';
import { CHEMISTRY } from '../core/profiles/chemistry';
import { resolve, type ResolvedParameters, type SourceSpace } from '../core/resolve';
import { EXPORT_MAX_WIDTH, PREVIEW_MAX_WIDTH, Renderer, type ViewMode } from '../gl/renderer';
import {
  ACCEPT_ATTRIBUTE,
  decodeFile,
  measureMiddleGrey,
  sceneLogHistogram,
  type DecodedSource,
} from '../io/decode';
import { CurvePlot } from './CurvePlot';
import { Dropzone } from './Dropzone';
import { Panel } from './Panel';
import { Viewport } from './Viewport';
import { loadPrintLut, loadedPrintLut } from '../core/printLuts';

const STORAGE_KEY = 'emulsion.recipe.v1';

/**
 * A persisted recipe can outlive the profiles it names — a stock that existed
 * when the edit was saved may have been removed since. Reset any id that no
 * longer resolves to its default, so a stale recipe degrades to a valid edit
 * rather than throwing on mount and black-screening the app.
 */
function sanitizeRecipe(r: Recipe): Recipe {
  const has = (list: readonly { id: string }[], id: string) => list.some((p) => p.id === id);
  const def = defaultRecipe();
  return {
    ...r,
    negativeId: has(NEGATIVES, r.negativeId) ? r.negativeId : def.negativeId,
    printId: has(PRINT_STOCKS, r.printId) ? r.printId : def.printId,
    chemistryId: has(CHEMISTRY, r.chemistryId) ? r.chemistryId : def.chemistryId,
  };
}

function loadRecipe(): Recipe {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return sanitizeRecipe(clampRecipe({ ...defaultRecipe(), ...(JSON.parse(raw) as Recipe) }));
  } catch {
    // A corrupt stored recipe is not worth a broken first run.
  }
  return defaultRecipe();
}

export function App() {
  // One canvas for the life of the session: the GL context, its programs and
  // every allocated target belong to this element, so it must never unmount.
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const frameRef = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const [recipe, setRecipe] = useState<Recipe>(loadRecipe);
  const [source, setSource] = useState<DecodedSource | null>(null);
  const [histogram, setHistogram] = useState<Float32Array | null>(null);
  const [measuredGrey, setMeasuredGrey] = useState<number | null>(null);
  const [mode, setMode] = useState<ViewMode>('print');
  const [split, setSplit] = useState(0);
  const [clipWarning, setClipWarning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [glError, setGlError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [renderWidth, setRenderWidth] = useState(PREVIEW_MAX_WIDTH);
  /** Bumped when a print LUT finishes loading; resolve reads the cache. */
  const [lutVersion, setLutVersion] = useState(0);

  const sourceSpace: SourceSpace = source?.space ?? 'srgb';

  const resolved: ResolvedParameters = useMemo(
    () => resolve(recipe, { renderWidthPx: renderWidth, sourceSpace }),
    [recipe, renderWidth, sourceSpace, lutVersion],
  );

  const update = useCallback((mutate: (draft: Recipe) => void) => {
    setRecipe((prev) => {
      const draft: Recipe = structuredClone(prev);
      mutate(draft);
      return clampRecipe(draft);
    });
  }, []);

  useEffect(() => {
    if (!canvasRef.current || rendererRef.current) return;
    try {
      rendererRef.current = new Renderer(canvasRef.current);
    } catch (err) {
      setGlError(err instanceof Error ? err.message : String(err));
    }
    const renderer = rendererRef.current;
    return () => {
      renderer?.dispose();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recipe));
  }, [recipe]);

  // The measured stock arrives asynchronously; until it does, the model
  // renders, and the bump re-resolves so the LUT takes over mid-session
  // without a reload.
  useEffect(() => {
    let alive = true;
    void loadPrintLut(recipe.printId, recipe.printIlluminant).then(() => {
      if (alive) setLutVersion((v) => v + 1);
    });
    return () => {
      alive = false;
    };
  }, [recipe.printId, recipe.printIlluminant]);

  // One render per animation frame, however fast a slider moves.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer?.hasSource) return;
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      try {
        const { printId, printIlluminant } = resolved.recipe;
        const lut = resolved.printLut ? loadedPrintLut(printId, printIlluminant) : null;
        renderer.setPrintLut(lut, resolved.printLut && lut ? `${printId}:${printIlluminant}` : '');
        renderer.render(resolved, { mode, split, clipWarning });
      } catch (err) {
        setGlError(err instanceof Error ? err.message : String(err));
      }
    });
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [resolved, mode, split, clipWarning, source]);

  const openFile = useCallback(
    async (file: File) => {
      setBusy(true);
      setError(null);
      try {
        const decoded = await decodeFile(file);
        const renderer = rendererRef.current;
        if (!renderer) throw new Error('the renderer is not ready yet');
        renderer.setSource(decoded.image, PREVIEW_MAX_WIDTH);
        setRenderWidth(renderer.renderWidth);
        setSource(decoded);
        setHistogram(sceneLogHistogram(decoded));

        // §V calls the constant relating a decoded middle grey to the working
        // space unit `g_cal`, and getting it wrong is what makes every stock
        // "look flat" or "block up". There is no device here to calibrate — so
        // measure the picture and *offer* the shift, rather than applying it
        // silently. Second-guessing the exposure the photographer chose is
        // exactly the kind of hidden rendering intent §V spends a page
        // switching off in the decoder.
        setMeasuredGrey(await measureMiddleGrey(decoded));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [update],
  );

  useEffect(() => {
    let depth = 0;
    const onEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return;
      depth++;
      setDragging(true);
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) void openFile(file);
    };
    const onPaste = (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.files ?? [])[0];
      if (file) void openFile(file);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('paste', onPaste);
    };
  }, [openFile]);

  const exportPrint = useCallback(async () => {
    const renderer = rendererRef.current;
    if (!renderer || !source) return;
    setBusy(true);
    setError(null);
    try {
      const exportWidth = Math.min(source.image.width, EXPORT_MAX_WIDTH);
      // Grain and halation are physical sizes, so the export has to be resolved
      // at its own pixel pitch or it would carry the preview's grain scale.
      const exportParams = resolve(recipe, { renderWidthPx: exportWidth, sourceSpace });
      const data = renderer.renderAtResolution(
        exportParams,
        { mode: 'print', split: 0, clipWarning: false },
        EXPORT_MAX_WIDTH,
      );

      const canvas = document.createElement('canvas');
      canvas.width = data.width;
      canvas.height = data.height;
      canvas.getContext('2d')!.putImageData(data, 0, 0);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
      if (!blob) throw new Error('the browser would not encode the print');

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${source.fileName.replace(/\.[^.]+$/, '')} — ${resolved.negative.displayName} on ${resolved.print.displayName}.png`;
      a.click();
      URL.revokeObjectURL(url);

      // renderAtResolution restored the preview allocation but left it blank.
      renderer.render(resolved, { mode, split, clipWarning });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [recipe, resolved, source, sourceSpace, mode, split, clipWarning]);

  if (glError) {
    return (
      <main className="fatal">
        <h1>EMULSION cannot start</h1>
        <p>{glError}</p>
      </main>
    );
  }

  const caption = source
    ? [
        source.kind === 'raw' ? 'RAW · linear ACES' : 'Display-referred source',
        source.camera,
        source.iso ? `ISO ${Math.round(source.iso)}` : null,
        `${resolved.negative.displayName} on ${resolved.print.displayName}`,
      ]
        .filter(Boolean)
        .join('  ·  ')
    : null;

  return (
    <div className={`shell${source ? '' : ' is-empty'}${dragging ? ' is-dragging' : ''}`}>
      <header className="topbar">
        <div className="topbar__brand">
          <span className="topbar__word">EMULSION</span>
          <span className="topbar__sub">Digital film laboratory</span>
        </div>
        <div className="topbar__actions">
          <button type="button" className="btn btn--ghost" onClick={() => fileInput.current?.click()}>
            Open
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setRecipe(defaultRecipe())}
            disabled={!source}
          >
            Reset
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void exportPrint()}
            disabled={!source || busy}
          >
            Export print
          </button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void openFile(f);
            e.target.value = '';
          }}
        />
      </header>

      <main className="stage">
        <Viewport
          canvasRef={canvasRef}
          mode={mode}
          onModeChange={setMode}
          split={split}
          onSplitChange={setSplit}
          clipWarning={clipWarning}
          onClipWarningChange={setClipWarning}
          fileName={source?.fileName ?? null}
          caption={caption}
          busy={busy}
        />

        {source ? (
          <aside className="rail">
            <CurvePlot
              curve={resolved.curve}
              anchorShift={resolved.anchorShift}
              exposureGain={resolved.exposureGain}
              histogram={histogram}
              monochrome={resolved.monochrome}
            />
            {resolved.warnings.length || source.caveat || error ? (
              <div className="notices">
                {error ? <p className="notice notice--warn">{error}</p> : null}
                {resolved.warnings.map((w) => (
                  <p key={w} className="notice notice--warn">
                    {w}
                  </p>
                ))}
                {source.caveat ? <p className="notice">{source.caveat}</p> : null}
              </div>
            ) : null}
            <Panel
              recipe={recipe}
              resolved={resolved}
              update={update}
              measuredGrey={measuredGrey}
            />
          </aside>
        ) : null}

        {!source ? <Dropzone onFile={(f) => void openFile(f)} dragging={dragging} error={error} /> : null}
      </main>

      {busy ? (
        <div className="busy" role="status">
          Working
        </div>
      ) : null}
    </div>
  );
}
