import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clampRecipe, defaultRecipe, type Recipe } from '../core/recipe';
import { NEGATIVES } from '../core/profiles/negatives';
import { PRINT_STOCKS } from '../core/profiles/printStocks';
import { CHEMISTRY } from '../core/profiles/chemistry';
import { resolve, type ResolvedParameters, type SourceSpace } from '../core/resolve';
import { developLuma } from '../core/develop';
import { PREVIEW_MAX_WIDTH, Renderer, type ViewMode } from '../gl/renderer';
import {
  ACCEPT_ATTRIBUTE,
  decodeFile,
  measureMiddleGrey,
  sceneLogHistogram,
  sceneSamples,
  type DecodedSource,
} from '../io/decode';
import { CurvePlot } from './CurvePlot';
import { Dropzone } from './Dropzone';
import { ExportDialog } from './ExportDialog';
import { Panel, type RailTab } from './Panel';
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
  const stageRef = useRef<HTMLElement>(null);

  // Publish the print's intrinsic aspect ratio as a custom property on the
  // stage, so the stacked mobile layout can size the viewport's row to the
  // picture's shape instead of a fixed share of the screen: a portrait print
  // earns the height its aspect needs, a landscape one is not padded into a
  // strip it cannot fill. The renderer writes canvas.width/height when a
  // source lands; a ResizeObserver on the canvas is what catches that — an
  // attribute write fires no React render, and the canvas's CSS box often does
  // not change (it is object-fit inside a fixed frame).
  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    const publish = () => {
      const w = canvas.width || 1;
      const h = canvas.height || 1;
      stage.style.setProperty('--print-aspect', String(w / h));
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  const [recipe, setRecipe] = useState<Recipe>(loadRecipe);
  const [source, setSource] = useState<DecodedSource | null>(null);
  /** The decoded scene's luminance subsample — develop applied at read time. */
  const [samples, setSamples] = useState<Float32Array | null>(null);
  const [measuredGrey, setMeasuredGrey] = useState<number | null>(null);
  const [mode, setMode] = useState<ViewMode>('print');
  const [split, setSplit] = useState(0);
  const [clipWarning, setClipWarning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [glError, setGlError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  /** The export bench is open; the renderer and canvas persist beneath it. */
  const [exporting, setExporting] = useState(false);
  /** Which rail page shows; the camera develop comes before the film. */
  const [railTab, setRailTab] = useState<RailTab>('camera');
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

  /**
   * The histogram follows the develop. The samples are the decoded scene;
   * mapping each through `developLuma` and the exposure gain — the exact
   * scalar the prepare pass applies to luminance, so the instrument shows the
   * light the film is about to see, and a tone slider visibly slides the
   * picture under the curve.
   */
  const cameraParams = resolved.camera;
  const cameraGain = resolved.exposureGain;
  const histogram = useMemo(() => {
    if (!samples) return null;
    const developed = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      developed[i] = developLuma(samples[i]! * cameraGain, cameraParams);
    }
    return sceneLogHistogram(developed);
  }, [samples, cameraParams, cameraGain]);

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
        // A lost context draws black and never throws; saying so is the only
        // honest failure mode left once the export guard has been passed.
        if (renderer.contextLost) {
          setGlError(
            'The graphics context was lost — the device ran out of GPU memory. Reload the page to continue.',
          );
          return;
        }
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
        setSamples(sceneSamples(decoded));

        // §V calls the constant relating a decoded middle grey to the working
        // space unit `g_cal`, and getting it wrong is what makes every stock
        // "look flat" or "block up". There is no device here to calibrate — so
        // measure the picture and *offer* the shift, rather than applying it
        // silently. Second-guessing the exposure the photographer chose is
        // exactly the kind of hidden rendering intent §V spends a page
        // switching off in the decoder. Measured on the *decoded* file: the
        // anchor calibrates the capture, not the develop.
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

  // The export bench renders the print at its own resolution and repaints the
  // preview when it is done with the graph; the renderer and canvas persist
  // beneath it for the life of the dialog.
  const openExport = useCallback(() => setExporting(true), []);

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
      {/* The ambient darkroom: red and blue glows drifting slowly behind the
          glass. It sits below every surface, catches nothing, and exists so
          the panels have moving light to blur — the motion is what makes the
          glassmorphism read as glass rather than as grey boxes. */}
      <div className="ambience" aria-hidden="true">
        <i className="ambience__red ambience__red--a" />
        <i className="ambience__red ambience__red--b" />
        <i className="ambience__blue" />
        <i className="ambience__shaft" />
      </div>
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
            onClick={openExport}
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

      <main className="stage" ref={stageRef}>
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
              camera={resolved.camera}
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
              tab={railTab}
              onTabChange={setRailTab}
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

      {exporting && source && rendererRef.current ? (
        <ExportDialog
          source={source}
          recipe={recipe}
          sourceSpace={sourceSpace}
          renderer={rendererRef.current}
          view={{ mode, split, clipWarning }}
          resolved={resolved}
          onClose={() => setExporting(false)}
        />
      ) : null}
    </div>
  );
}
