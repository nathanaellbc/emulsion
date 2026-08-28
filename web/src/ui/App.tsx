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
  primaryAcceptAttribute,
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
 * Fill-rate budget for the live preview: a fullscreen float chain (grain,
 * halation, diffusion) costs per pixel on every pass, and a phone pays in
 * heat and lost contexts for pixels its screen can never show. The preview is
 * capped at this display's width in device pixels — the widest the picture is
 * ever drawn — which leaves a desktop untouched and asks a phone for about a
 * quarter of the work. The export bench still renders at full resolution.
 */
function previewBudget(): number {
  const dpr = window.devicePixelRatio || 1;
  return Math.min(PREVIEW_MAX_WIDTH, Math.round(window.innerWidth * dpr));
}

/**
 * The topbar Open input uses the shared primary-picker policy: a desktop gets
 * every extension so a RAW file is one click; a phone gets the filter its own
 * OS picker can honour without hiding the product's headline input (see
 * decode.ts, primaryAcceptAttribute).
 */
const OPEN_ACCEPT =
  typeof window !== 'undefined' ? primaryAcceptAttribute() : ACCEPT_ATTRIBUTE;

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
  /** The phone's picture-row height in px; null = follow the aspect ratio. */
  const [pictureH, setPictureH] = useState<number | null>(null);

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

  // The grip's chosen height lands here as a custom property; null removes it
  // so the row falls back to the aspect-driven clamp.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    if (pictureH === null) stage.style.removeProperty('--picture-h');
    else stage.style.setProperty('--picture-h', `${Math.round(pictureH)}px`);
  }, [pictureH]);

  /**
   * The grip sends raw intent; the stage is where it becomes a decision. The
   * floor keeps a sliver of photograph judgeable, the ceiling is the print at
   * its natural size — the width the frame actually offers, divided by the
   * print's aspect, plus the chrome of bar, foot and grip — so the picture can
   * grow to full size but the row never invents emptiness beyond it.
   */
  const resizePicture = useCallback((h: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    const frame = stage.querySelector('.viewport__frame');
    if (!frame) return;
    const style = getComputedStyle(frame);
    const inner = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const aspect = parseFloat(stage.style.getPropertyValue('--print-aspect')) || 1.5;
    const natural = inner / aspect + 120;
    setPictureH(Math.min(Math.max(h, 140), Math.max(natural, 180)));
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
  /** Reset is staged: the first click arms it, the second, within a beat, confirms. */
  const [resetArmed, setResetArmed] = useState(false);
  const resetTimer = useRef<number | null>(null);

  const sourceSpace: SourceSpace = source?.space ?? 'srgb';

  const resolved: ResolvedParameters = useMemo(
    () => resolve(recipe, { renderWidthPx: renderWidth, sourceSpace }),
    [recipe, renderWidth, sourceSpace, lutVersion],
  );

  const update = useCallback((mutate: (draft: Recipe) => void) => {
    setRecipe((prev) => {
      // The recipe is JSON by contract (it is persisted as JSON), so a JSON
      // round-trip clones it. structuredClone is unavailable on iOS < 15.4,
      // where its absence would silently dead-end every control.
      const draft: Recipe = JSON.parse(JSON.stringify(prev)) as Recipe;
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

  // Persistence is debounced: a slider fires tens of updates a second and a
  // synchronous localStorage write per update is main-thread jank on a phone.
  // The final state lands a beat after the last change.
  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(recipe));
      } catch {
        // A refused write (private mode, quota) is not worth a crash.
      }
    }, 300);
    return () => window.clearTimeout(t);
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
        renderer.setSource(decoded.image, previewBudget());
        setRenderWidth(renderer.renderWidth);
        setSource(decoded);
        setSamples(sceneSamples(decoded));
        // A new photograph arrives at the aspect's own size; the grip's last
        // choice belonged to the previous picture.
        setPictureH(null);

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

  // Reset destroys the whole grade in one mutation, and the no-undo stance
  // means nothing brings it back — so the destruction is staged. The first
  // click arms the button for three seconds; a second click confirms, and
  // otherwise the button disarms itself. No history stack, no modal: the
  // mis-click that would have cost a session now costs one extra click.
  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );
  const armReset = useCallback(() => {
    setResetArmed(true);
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setResetArmed(false), 3000);
  }, []);
  const doReset = useCallback(() => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = null;
    setResetArmed(false);
    setRecipe(defaultRecipe());
  }, []);

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
            className={`btn btn--ghost${resetArmed ? ' btn--armed' : ''}`}
            onClick={resetArmed ? doReset : armReset}
            disabled={!source}
          >
            {resetArmed ? 'Confirm reset' : 'Reset'}
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
          accept={OPEN_ACCEPT}
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
          onPictureResize={resizePicture}
        />

        {source ? (
          <aside className="rail">
            {/* The bench switcher is a direct child of the rail, above the
                plot — a plain flex child on every viewport, no
                display:contents flattening, which older iOS WebKit renders
                as nothing (the bug that hid the whole bench on phones). */}
            <div
              className="rail-tabs"
              role="tablist"
              aria-label="Bench"
              onKeyDown={(e) => {
                if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                e.preventDefault();
                const next = e.key === 'ArrowRight' ? 'film' : 'camera';
                setRailTab(next);
                e.currentTarget
                  .querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)
                  ?.focus();
              }}
            >
              <button
                type="button"
                role="tab"
                data-tab="camera"
                id="bench-tab-camera"
                aria-controls="bench-page"
                aria-selected={railTab === 'camera'}
                className={`rail-tab${railTab === 'camera' ? ' is-on' : ''}`}
                onClick={() => setRailTab('camera')}
              >
                Camera
              </button>
              <button
                type="button"
                role="tab"
                data-tab="film"
                id="bench-tab-film"
                aria-controls="bench-page"
                aria-selected={railTab === 'film'}
                className={`rail-tab${railTab === 'film' ? ' is-on' : ''}`}
                onClick={() => setRailTab('film')}
              >
                Film
              </button>
            </div>
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
            <Panel recipe={recipe} resolved={resolved} update={update} measuredGrey={measuredGrey} tab={railTab} />
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
