/**
 * The control rail — the lab bench.
 *
 * Two pages, in the order the work happens: the camera develop first (what
 * the sensor's develop would have done before the film saw the light), then
 * the film (the bench proper — stock, exposure rating, development, print and
 * the spatial phenomena). That order is not decoration. A user who moves
 * printer lights before setting development is balancing a negative that is
 * about to change underneath them, and a user who grades the develop after
 * choosing a stock is tuning light the film has already seen.
 */

import { pushLabel } from '../core/development';
import { IDEAL_NEGATIVE_ID, NEGATIVES } from '../core/profiles/negatives';
import { PRINT_STOCKS } from '../core/profiles/printStocks';
import { CHEMISTRY } from '../core/profiles/chemistry';
import { FORMAT_LABEL, FRAME_WIDTH_MM, type FilmFormat, type Recipe } from '../core/recipe';
import { GRAIN_PRESETS, grainPresetById } from '../core/grainPresets';
import { HALATION_PRESETS, halationPresetById } from '../core/halationPresets';
import type { ResolvedParameters } from '../core/resolve';
import { F_STOPS, NORMAL_FOCAL_MM, nearestStop } from '../core/defocus';
import type { DepthMap } from '../depth/estimate';
import { DEPTH_MODEL } from '../depth/model';
import type { DepthStatus } from './App';
import { Choice, Field, PointStepper, Section, SegmentedControl, Slider } from './controls';

/* The dot at the head of the stock dropdown. It is not decoration: each family
   is a physically different thing to hold up to the light, and the swatch says
   which — the orange integral mask of a colour negative, the full colour of a
   positive transparency, the silver of a monochrome. */
const FAMILY_SWATCH: Record<string, string> = {
  colorNegative: '#d2762e',
  transparency:
    'conic-gradient(from 210deg, var(--record-r), var(--record-g), var(--record-b), var(--record-r))',
  monochrome: 'linear-gradient(140deg, #d8d8dc, #6e6e76)',
};

export type RailTab = 'camera' | 'film';

export interface PanelProps {
  recipe: Recipe;
  resolved: ResolvedParameters;
  update: (mutate: (draft: Recipe) => void) => void;
  /** Log-average scene luminance of the decoded file, or null before it is measured. */
  measuredGrey: number | null;
  /** Which page the rail shows; the camera develop comes first. */
  tab: RailTab;
  lens: LensProps;
}

/** What the Lens section needs from the app beyond the recipe. */
export interface LensProps {
  depth: DepthMap | null;
  status: DepthStatus;
  /** The RAW file's own focal length, when it records one. */
  fileFocalLength: number | null;
  /** Estimate the depth, downloading the model if it has to. */
  onEstimate: () => void;
  focusView: boolean;
  onFocusView: (on: boolean) => void;
}

const FORMATS = Object.keys(FRAME_WIDTH_MM) as FilmFormat[];

/** Rating a film at a speed other than its nominal one, in third stops. */
const EI_CHOICES = [0.25, 0.5, 1, 2, 4, 8];

export function Panel({ recipe, resolved, update, measuredGrey, tab, lens }: PanelProps) {
  const { negative, sensitometry } = resolved;
  const marginTight = sensitometry.margin < 0.25;

  const ei = recipe.capture.filmSpeedOverride ?? negative.iso;
  const lutIlluminantLive =
    resolved.printEngine === 'lut' &&
    resolved.printLut !== null &&
    resolved.printLut.illuminants.length > 1;

  // The bench's own tab strip lives in App, as a direct child of the rail: a
  // display:contents panel was what used to flatten it into the rail on
  // phones, and older iOS WebKit drops the children of display:contents
  // elements entirely — the bug that hid the whole bench on those devices.
  return (
    <div className="panel" id="bench-page">
      {tab === 'camera' ? (
        <CameraPage
          recipe={recipe}
          resolved={resolved}
          update={update}
          measuredGrey={measuredGrey}
          lens={lens}
        />
      ) : (
        <FilmPage
          recipe={recipe}
          resolved={resolved}
          update={update}
          ei={ei}
          lutIlluminantLive={lutIlluminantLive}
          marginTight={marginTight}
        />
      )}
    </div>
  );
}

/**
 * The camera develop — what the sensor's develop would have done before the
 * film saw the light. The paper publishes nothing for this stage (§V switches
 * every rendering intent off at the decode), so every mapping is an
 * engineering default recorded in DEVIATIONS.md finding 14 — the sliders say
 * what they do in real units, and none of it claims to be a measurement.
 */
function CameraPage({
  recipe,
  resolved,
  update,
  measuredGrey,
  lens,
}: {
  recipe: Recipe;
  resolved: ResolvedParameters;
  update: (mutate: (draft: Recipe) => void) => void;
  measuredGrey: number | null;
  lens: LensProps;
}) {
  const { negative } = resolved;

  const anchorSuggestion =
    measuredGrey && measuredGrey > 1e-6 ? Math.log2(0.18 / measuredGrey) : null;
  const anchorWorthOffering =
    anchorSuggestion !== null &&
    Math.abs(anchorSuggestion - recipe.capture.exposureCompensation) > 0.05;

  return (
    <>
      <Section title="Exposure &amp; tone">
        <Slider
          label="Exposure"
          value={recipe.capture.exposureCompensation}
          min={-5}
          max={5}
          step={1 / 3}
          unit=" EV"
          format={(v) => (v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2))}
          detents={[0]}
          hint="How much light the sensor delivered. This is the exposure the film receives — moving it slides the whole picture along the characteristic curve, which the plot beneath shows."
          onChange={(v) => update((d) => (d.capture.exposureCompensation = v))}
        />
        {anchorSuggestion !== null ? (
          <p className="control__hint control__hint--action">
            This file’s log-average luminance is{' '}
            <span className="num">{measuredGrey!.toFixed(4)}</span>.{' '}
            {anchorWorthOffering ? (
              <button
                type="button"
                className="link"
                onClick={() =>
                  update((d) => (d.capture.exposureCompensation = anchorSuggestion))
                }
              >
                Anchor it to 18% grey ({anchorSuggestion > 0 ? '+' : ''}
                {anchorSuggestion.toFixed(2)} EV)
              </button>
            ) : (
              'It is already anchored near 18% grey.'
            )}
          </p>
        ) : null}
        <Slider
          label="Contrast"
          value={recipe.camera.contrast}
          min={-0.75}
          max={0.75}
          step={0.01}
          format={(v) => `${Math.pow(2, v).toFixed(2)}×`}
          detents={[0]}
          hint="Slope of the tone curve in log space, rotated about this picture's own middle grey — so it changes contrast without changing the picture's brightness. 1.00× leaves it untouched; 1.68× is steep, 0.59× is flat."
          onChange={(v) => update((d) => (d.camera.contrast = v))}
        />
        <Slider
          label="Highlights"
          value={recipe.camera.highlights}
          min={-1.5}
          max={1.5}
          step={0.05}
          unit=" stops"
          format={(v) => (v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2))}
          detents={[0]}
          hint="Recovers or pushes the bright mid-scale, a stop and a half over the picture’s middle grey, with a soft knee. Chromaticity is preserved: a saturated highlight keeps its hue."
          onChange={(v) => update((d) => (d.camera.highlights = v))}
        />
        <Slider
          label="Shadows"
          value={recipe.camera.shadows}
          min={-1.5}
          max={1.5}
          step={0.05}
          unit=" stops"
          format={(v) => (v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2))}
          detents={[0]}
          hint="Lifts or holds the dark mid-scale, a stop and a half under the picture’s middle grey. Acts in log space, so a lifted shadow stays positive where a multiplicative lift cannot."
          onChange={(v) => update((d) => (d.camera.shadows = v))}
        />
        <Slider
          label="Whites"
          value={recipe.camera.whites}
          min={-2}
          max={2}
          step={0.05}
          unit=" stops"
          format={(v) => (v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2))}
          detents={[0]}
          hint="The extreme top end, four stops over the picture's middle: sets where speculars land, and leaves the mid-scale alone. The film's shoulder takes it from here."
          onChange={(v) => update((d) => (d.camera.whites = v))}
        />
        <Slider
          label="Blacks"
          value={recipe.camera.blacks}
          min={-2}
          max={2}
          step={0.05}
          unit=" stops"
          format={(v) => (v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2))}
          detents={[0]}
          hint="The extreme bottom end, four stops under the picture’s middle: how far down the shadows reach before the toe. True black stays black."
          onChange={(v) => update((d) => (d.camera.blacks = v))}
        />
      </Section>

      <Section title="Colour">
        <Slider
          label="White balance"
          value={recipe.capture.whiteBalanceTempK}
          min={2000}
          max={12000}
          step={50}
          unit=" K"
          format={(v) => String(Math.round(v))}
          detents={negative.aimIlluminantK === 5500 ? [5500] : [3200, 5500]}
          hint={
            negative.aimIlluminantK === 5500
              ? 'What light the scene was under. Applied as a von Kries adaptation in cone space, not as a channel gain, because channel gain in a wide-gamut space rotates hue in saturated colours.'
              : `This stock's layers are balanced for ${negative.aimIlluminantK} K. Leaving this at 5500 K says the scene was daylight and the film was not corrected for it, which is where the blue cast comes from; setting it to ${negative.aimIlluminantK} K says the light matched the stock, and the cast goes away.`
          }
          onChange={(v) => update((d) => (d.capture.whiteBalanceTempK = v))}
        />
        <Slider
          label="Tint"
          value={recipe.capture.whiteBalanceTint}
          min={-1}
          max={1}
          step={0.01}
          detents={[0]}
          format={(v) => (v > 0 ? `+${v.toFixed(2)} G` : v < 0 ? `${v.toFixed(2)} M` : '0.00')}
          hint="The light's green–magenta error, like the temperature above: what the light was, not what to add. A green light (fluorescent, +) is corrected by adding magenta, a magenta one (−) by adding green. ±1 is a Duv of ±0.02, past any real lamp."
          onChange={(v) => update((d) => (d.capture.whiteBalanceTint = v))}
        />
        <Slider
          label="Saturation"
          value={recipe.camera.saturation}
          min={0}
          max={2}
          step={0.01}
          format={(v) => `${v.toFixed(2)}×`}
          detents={[1]}
          hint="Scene-side, before the film. 1.00× is untouched. Luminance is preserved exactly. The print's own saturation density — the crosstalk matrix — lives on the Film page, and the two are genuinely different controls."
          onChange={(v) => update((d) => (d.camera.saturation = v))}
        />
      </Section>

      <LensSection recipe={recipe} resolved={resolved} update={update} lens={lens} />
    </>
  );
}

const PHASE_LABEL: Record<string, string> = {
  runtime: 'Downloading the runtime',
  model: 'Downloading the depth model',
  compile: 'Preparing the model',
  infer: 'Estimating depth',
  refine: 'Refining the edges',
};

/** Full stops get a detent; the thirds between them are the steps. */
const FULL_STOPS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22];

function fmtMetres(m: number): string {
  if (!Number.isFinite(m)) return '∞';
  if (m < 1) return `${m.toFixed(2)} m`;
  if (m < 10) return `${m.toFixed(1)} m`;
  return `${Math.round(m)} m`;
}

/**
 * The taking lens: synthetic defocus (§XIII). Scene-side, so it lives on the
 * Camera page — a lens forms the image before any film sees it. The depth
 * comes from Depth Anything V2 run on this device, and every control is a
 * lens quantity: millimetres, an f-number, metres.
 */
function LensSection({
  recipe,
  resolved,
  update,
  lens,
}: {
  recipe: Recipe;
  resolved: ResolvedParameters;
  update: (mutate: (draft: Recipe) => void) => void;
  lens: LensProps;
}) {
  const d = recipe.defocus;
  const r = resolved.defocus;
  const { status, depth } = lens;
  const normal = NORMAL_FOCAL_MM[recipe.format];
  const stopIndex = F_STOPS.indexOf(nearestStop(d.fNumber) as (typeof F_STOPS)[number]);
  const progress = status.kind === 'working' ? status.progress : null;
  const measured = progress !== null && progress.total > 1;

  return (
    <Section
      title="Lens"
      meta={d.enabled ? <>{Math.round(r.focalLengthMm)} mm · f/{r.fNumber}</> : <>defocus off</>}
    >
      <Field
        label="Synthetic defocus"
        hint={`The picture’s depth is estimated on this device by ${DEPTH_MODEL.name} (${DEPTH_MODEL.license}); the photograph never leaves it. The blur is a thin lens’s circle of confusion, applied to the scene’s light before the film — so defocused highlights reach the negative as bright discs, and the halation and the film’s shoulder act on them.`}
      >
        <SegmentedControl
          label="Synthetic defocus"
          value={d.enabled ? 'on' : 'off'}
          options={[
            { value: 'off', label: 'Off', title: 'Everything as sharp as the file is' },
            {
              value: 'on',
              label: 'On',
              title: 'Blur by depth, through a lens with a real focal length and aperture',
            },
          ]}
          onChange={(v) => update((draft) => (draft.defocus.enabled = v === 'on'))}
        />
      </Field>

      {d.enabled ? (
        <>
          {status.kind === 'working' ? (
            <div className="lens-card" role="status">
              <div className="lens-card__row">
                <span className="lens-card__title">
                  {progress ? PHASE_LABEL[progress.phase] : 'Starting'}
                </span>
                {measured ? (
                  <span className="lens-card__meta num">
                    {(progress.loaded / 1e6).toFixed(1)} / {(progress.total / 1e6).toFixed(1)} MB
                  </span>
                ) : null}
              </div>
              <span className="depth-status__bar" aria-hidden="true">
                <i
                  className={measured ? undefined : 'is-indeterminate'}
                  style={
                    measured
                      ? { width: `${Math.min(100, (100 * progress.loaded) / progress.total)}%` }
                      : undefined
                  }
                />
              </span>
            </div>
          ) : null}

          {status.kind === 'needs-download' ? (
            <div className="lens-card">
              <p className="lens-card__text">
                The depth model downloads once and stays on this device — offline included.
              </p>
              <button type="button" className="btn btn--primary btn--block" onClick={lens.onEstimate}>
                Download depth model · <span className="num">{status.megabytes} MB</span>
              </button>
            </div>
          ) : null}

          {status.kind === 'error' ? (
            <div className="lens-card lens-card--warn" role="alert">
              <p className="lens-card__text">Depth estimation failed: {status.message}</p>
              <button type="button" className="btn btn--block" onClick={lens.onEstimate}>
                Try again
              </button>
            </div>
          ) : null}

          {depth ? (
            <div className="lens-card">
              <p className="lens-card__text">
                {lens.focusView
                  ? 'Tap the picture where it should be sharp. Dimmed parts fall outside the depth of field.'
                  : 'Focus lands where you tap the picture.'}
              </p>
              <button
                type="button"
                className={`btn btn--block${lens.focusView ? ' btn--primary' : ''}`}
                aria-pressed={lens.focusView}
                onClick={() => lens.onFocusView(!lens.focusView)}
              >
                {lens.focusView ? 'Done' : 'Pick the focus point'}
              </button>
              <span className="lens-card__meta num">
                {depth.variant} · {depth.backend === 'webgpu' ? 'GPU' : 'CPU'} · {depth.inferMs} ms ·{' '}
                {depth.width}×{depth.height}
              </span>
            </div>
          ) : null}

          <Slider
            label="Focus distance"
            value={Math.log10(d.focusDistanceM)}
            min={Math.log10(0.3)}
            max={2}
            step={0.005}
            format={(v) => fmtMetres(Math.pow(10, v))}
            detents={[0, Math.log10(3), 1]}
            hint="How far away the focus point is — what the lens’s focus scale would read. The depth map is relative; this is the one distance that makes it metric, with the farthest part of the picture taken as infinity."
            onChange={(v) => update((draft) => (draft.defocus.focusDistanceM = Math.pow(10, v)))}
          />
          <Slider
            label="Focal length"
            value={Math.log2(r.focalLengthMm)}
            min={Math.log2(8)}
            max={Math.log2(600)}
            step={0.01}
            format={(v) => {
              const f = Math.pow(2, v);
              return `${f < 20 ? f.toFixed(1) : Math.round(f)} mm${d.focalLengthMm === null ? ' — normal' : ''}`;
            }}
            detents={[Math.log2(normal)]}
            hint={`A normal lens for this format is ${normal} mm. The blur grows with the square of the focal length, so a longer lens at the same f-number and distance throws the background much further out.`}
            onChange={(v) =>
              update((draft) => {
                const f = Math.pow(2, v);
                draft.defocus.focalLengthMm = Math.abs(f - normal) / normal < 0.015 ? null : f;
              })
            }
          />
          {lens.fileFocalLength && Math.abs(lens.fileFocalLength - r.focalLengthMm) > 0.5 ? (
            <button
              type="button"
              className="link"
              onClick={() => update((draft) => (draft.defocus.focalLengthMm = lens.fileFocalLength))}
            >
              Use the file’s lens ({Math.round(lens.fileFocalLength)} mm)
            </button>
          ) : null}
          <Slider
            label="Aperture"
            value={Math.max(0, stopIndex)}
            min={0}
            max={F_STOPS.length - 1}
            step={1}
            format={(v) => `f/${F_STOPS[Math.round(v)]}`}
            detents={FULL_STOPS.map((f) => F_STOPS.indexOf(f as (typeof F_STOPS)[number]))}
            hint="In third stops. Each full stop takes the blur’s diameter down by a factor of √2."
            onChange={(v) => update((draft) => (draft.defocus.fNumber = F_STOPS[Math.round(v)]!))}
          />
          <Slider
            label="Keep sharp from"
            value={Math.log10(d.nearSharpM ?? d.focusDistanceM)}
            min={Math.log10(0.2)}
            max={Math.log10(d.focusDistanceM)}
            step={0.005}
            format={(v) =>
              d.nearSharpM === null || Math.pow(10, v) >= d.focusDistanceM * 0.995
                ? 'Focus plane'
                : fmtMetres(Math.pow(10, v))
            }
            detents={[Math.log10(d.focusDistanceM)]}
            disabled={d.foreground <= 1e-4}
            hint="The near limit of the sharp zone. Everything between this distance and the focus point stays sharp, and the foreground only starts to blur in front of it. At the right end it is the lens's own behaviour: blur starts at the focal plane."
            onChange={(v) =>
              update((draft) => {
                const m = Math.pow(10, v);
                draft.defocus.nearSharpM = m >= draft.defocus.focusDistanceM * 0.995 ? null : m;
              })
            }
          />
          <Slider
            label="Foreground blur"
            value={d.foreground}
            min={0}
            max={1}
            step={0.01}
            format={(v) => (v < 0.005 ? 'Cut — sharp' : v > 0.995 ? 'Lens' : `${Math.round(v * 100)}%`)}
            detents={[0, 1]}
            hint="How much of the lens's blur the foreground — anything nearer than the focus — receives. 100% is the lens; lower softens it; 0 cuts it off entirely and keeps the foreground sharp. The background is not affected."
            onChange={(v) => update((draft) => (draft.defocus.foreground = v))}
          />

          <div className="readout readout--pairs">
            <Stat
              label="Near"
              value={r.nearLimitM <= 0 ? 'Cut' : fmtMetres(r.nearLimitM)}
              title="The nearest distance that is acceptably sharp, after the near-limit and foreground settings"
            />
            <Stat label="Far" value={fmtMetres(r.farLimitM)} title="The farthest distance that is acceptably sharp" />
            <Stat
              label="Hyperfocal"
              value={fmtMetres(r.hyperfocalM)}
              title="Focused here, everything from half this distance to infinity is acceptably sharp"
            />
            <Stat
              label="CoC"
              value={`${r.acceptableCocMm.toFixed(3)} mm`}
              title="The permissible circle of confusion for this frame: its diagonal over 1442"
            />
          </div>

          <Choice
            label="Aperture blades"
            value={String(d.blades)}
            options={[
              { value: '0', label: 'Round' },
              ...[5, 6, 7, 8, 9].map((n) => ({ value: String(n), label: `${n} blades` })),
            ]}
            hint="The iris’s shape is the shape of every out-of-focus highlight."
            onChange={(v) => update((draft) => (draft.defocus.blades = Number(v)))}
          />
          <Slider
            label="Blade curvature"
            value={d.bladeCurvature}
            min={0}
            max={1}
            step={0.01}
            format={(v) => (v < 0.005 ? 'Straight' : v > 0.995 ? 'Round' : `${Math.round(v * 100)}%`)}
            disabled={d.blades === 0}
            hint="Straight blades draw a crisp polygon; curved ones round it off toward a circle."
            onChange={(v) => update((draft) => (draft.defocus.bladeCurvature = v))}
          />
          <Slider
            label="Cat’s eye"
            value={d.catEye}
            min={0}
            max={1}
            step={0.01}
            format={(v) => (v < 0.005 ? 'None' : `${Math.round(v * 100)}%`)}
            detents={[0]}
            hint="Optical vignetting: toward the frame’s edge the lens barrel cuts into the aperture, and the discs narrow into lemons. At the centre they stay round whatever this says."
            onChange={(v) => update((draft) => (draft.defocus.catEye = v))}
          />
        </>
      ) : null}
    </Section>
  );
}

/**
 * The film bench proper: what stock, how it was rated, how it was developed,
 * how it was printed, and the spatial phenomena. Exposure and white balance
 * live on the Camera page — they describe the light before the film, not the
 * film itself. Rating (EI) stays here because it is genuinely film-side:
 * rating changes where the anchor sits, and push development is the recovery.
 */
function FilmPage({
  recipe,
  resolved,
  update,
  ei,
  lutIlluminantLive,
  marginTight,
}: {
  recipe: Recipe;
  resolved: ResolvedParameters;
  update: (mutate: (draft: Recipe) => void) => void;
  ei: number;
  lutIlluminantLive: boolean;
  marginTight: boolean;
}) {
  const { negative, print, sensitometry } = resolved;
  return (
    <>
      <Section
        title="Film"
        meta={
          // A record with no fog reaches Dmin + 0.10 the instant it starts
          // responding, so the ideal negative satisfies ISO 10 000. That is a
          // property of the criterion rather than of the film, and printing it
          // as a speed would invite someone to believe it.
          recipe.negativeId === IDEAL_NEGATIVE_ID ? (
            <>ideal · γ {resolved.curve.gamma[1].toFixed(2)}</>
          ) : (
            <>
              ISO {Math.round(sensitometry.iso)} · CI {sensitometry.contrastIndex.toFixed(2)}
            </>
          )
        }
      >
        <Choice
          label="Negative stock"
          value={recipe.negativeId}
          options={NEGATIVES.map((n) => ({
            value: n.id,
            label: `${n.displayName} · ${n.process}`,
            detail: n.note,
            swatch: FAMILY_SWATCH[n.family],
          }))}
          onChange={(id) =>
            update((d) => {
              const stock = NEGATIVES.find((n) => n.id === id)!;
              d.negativeId = id;
              d.chemistryId = stock.chemistryId;
              d.printId = stock.defaultPrint;
              d.capture.filmSpeedOverride = null;
            })
          }
        />

        <Choice
          label="Format"
          value={recipe.format}
          options={FORMATS.map((f) => ({ value: f, label: FORMAT_LABEL[f] }))}
          hint="Grain and halation are specified in micrometres at the film plane. A larger frame means the same physical grain covers less of the picture."
          onChange={(f) => update((d) => (d.format = f))}
        />

        {/* Rating is film-side: it changes where the anchor sits, and push
            development — on this page — is the recovery. There is no box
            speed to deviate from on the ideal negative, where rating is
            exposure compensation under another name (Camera page). */}
        {recipe.negativeId === IDEAL_NEGATIVE_ID ? null : (
          <Choice
            label="Rated at"
            value={String(ei)}
            options={EI_CHOICES.map((m) => {
              const v = Math.round(negative.iso * m);
              return {
                value: String(v),
                label: `EI ${v}${m === 1 ? ' — box speed' : m > 1 ? ` — ${Math.log2(m)} stop under` : ` — ${-Math.log2(m)} stop over`}`,
              };
            })}
            hint="Shooting a 400 stock at 800 gives the film half the light, which moves the whole image down into the toe. Push development is how you get it back — and what it costs is on the curve. Scene exposure itself is on the Camera page."
            onChange={(v) =>
              update((d) => {
                const n = Number(v);
                d.capture.filmSpeedOverride = n === negative.iso ? null : n;
              })
            }
          />
        )}

        <div className="readout">
          <Stat label="Dmin" value={sensitometry.dMin.toFixed(2)} />
          <Stat label="Dmax" value={sensitometry.dMax.toFixed(2)} />
          <Stat label="Latitude" value={`${sensitometry.latitudeStops.toFixed(1)} EV`} />
          <Stat
            label="Margin"
            value={sensitometry.margin.toFixed(2)}
            tone={marginTight ? 'warn' : undefined}
            title="ΔD − 4(κt + κs). Below zero the toe and shoulder have met and there is no straight line left."
          />
        </div>
      </Section>

      <Section title="Development" meta={<>A = {resolved.developmentActivity.toFixed(3)}</>}>
        <Choice
          label="Chemistry"
          value={recipe.chemistryId}
          options={CHEMISTRY.map((c) => ({ value: c.id, label: c.displayName }))}
          hint="Cross-processing is available and behaves the way it does in a tank: the curve reshapes, the fog rises, and nothing about it is a preset."
          onChange={(id) => update((d) => (d.chemistryId = id))}
        />
        <Slider
          label="Push / pull"
          value={recipe.develop.pushPull}
          min={-2}
          max={3}
          step={1}
          format={pushLabel}
          detents={[-2, -1, 0, 1, 2, 3]}
          hint="Gamma saturates toward a ceiling, fog rises without one, and speed comes back only partly. A push is not an exposure change and the curve says so."
          onChange={(v) => update((d) => (d.develop.pushPull = v))}
        />
        <Slider
          label="Agitation"
          value={recipe.develop.agitation}
          min={0.2}
          max={2}
          step={0.05}
          format={(v) => `${v.toFixed(2)}×`}
          detents={[1]}
          hint="1.00 is the manufacturer's recommended scheme. Toward zero is stand development."
          onChange={(v) => update((d) => (d.develop.agitation = v))}
        />
        <Slider
          label="Developer strength"
          value={recipe.develop.developerConcentration}
          min={0.4}
          max={1.6}
          step={0.05}
          format={(v) => `${v.toFixed(2)}×`}
          detents={[1]}
          onChange={(v) => update((d) => (d.develop.developerConcentration = v))}
        />
      </Section>

      <Section
        title="Interlayer"
        meta={
          recipe.interlayer.couplerActivity < 1e-3 ? (
            <>off</>
          ) : resolved.interlayer.enabled ? (
            <>σ₂ = {resolved.interlayer.sigma2Px.toFixed(2)} px</>
          ) : (
            // Not the same thing as off, and worth saying which: the stage is
            // asking for a kernel finer than this render can carry.
            <>below the render</>
          )
        }
      >
        <Slider
          label="Coupler activity"
          value={recipe.interlayer.couplerActivity}
          min={0}
          max={2}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          detents={[1]}
          hint="DIR couplers release an inhibitor that suppresses development next to where it was released — a rim at every edge, and a green region suppressing the red and blue beside it. Not a sharpness control: it works on the local difference between records, which no saturation slider can reach. Agitation sets how far the inhibitor travels. The diffusion lengths are 1.2 µm and 6 µm at the film plane; a 35 mm frame rendered 2048 px across has a 17.6 µm pixel, so the effect is genuinely below the resolution until the export — it is not floored into visibility here."
          onChange={(v) => update((d) => (d.interlayer.couplerActivity = v))}
        />
      </Section>

      <Section
        title="Print"
        meta={
          resolved.printLut ? (
            resolved.printEngine === 'lut' ? (
              <>
                measured · {resolved.printLut.displayName} · {recipe.printIlluminant}
              </>
            ) : (
              <>calculated</>
            )
          ) : (
            <>calculated · no measurement</>
          )
        }
      >
        {resolved.printLut ? (
          <Field
            label="Engine"
            hint={
              resolved.printEngine === 'lut'
                ? 'Saturation, roll-off, shadow lift, neutral axis and silver are inside the measurement — they describe the print stock itself, and this LUT is that stock, measured.'
                : 'The print is computed from the stock’s published curve parameters. The measured LUT for this stock is one toggle away.'
            }
          >
            <SegmentedControl
              label="Print engine"
              value={recipe.printEngine}
              options={[
                {
                  value: 'lut',
                  label: 'Measured',
                  title: `The stock's own measured response — ${resolved.printLut.source}`,
                },
                {
                  value: 'model',
                  label: 'Calculated',
                  title: 'The document’s print model: crosstalk matrix, aim balance, print curve',
                },
              ]}
              onChange={(v) => update((d) => (d.printEngine = v))}
            />
          </Field>
        ) : (
          <p className="control__hint">
            No measured LUT ships for this stock, so it renders through the calculated model.
          </p>
        )}

        <Choice
          label="Print stock"
          value={recipe.printId}
          options={PRINT_STOCKS.map((p) => ({
            value: p.id,
            label: p.id === 'prt.3521' ? `${p.displayName} · model only` : p.displayName,
            detail: p.character,
          }))}
          onChange={(id) => update((d) => (d.printId = id))}
        />

        {resolved.printLut ? (
          <Field
            label="Print illuminant"
            disabled={!lutIlluminantLive}
            hint={
              lutIlluminantLive
                ? 'The white point the print was measured under: 5500 K daylight, 6000 K, or 6500 K.'
                : resolved.printLut.illuminants.length > 1
                  ? 'The illuminant follows the measurement — switch the engine to Measured to choose it.'
                  : 'This measurement ships in a single white point, so there is nothing to switch.'
            }
          >
            <SegmentedControl
              label="Print illuminant"
              value={resolved.printLut.illuminant}
              options={resolved.printLut.illuminants.map((i) => ({
                value: i,
                label: i,
                title: `The measurement balanced for ${i} projection`,
              }))}
              onChange={(v) =>
                lutIlluminantLive && update((d) => (d.printIlluminant = v as 'D55' | 'D60' | 'D65'))
              }
            />
          </Field>
        ) : null}

        <div className={`lights${print.bypass ? ' is-inert' : ''}`}>
          <div className="lights__head">
            <span className="control__label">Printer lights</span>
            <span className="lights__grade num">
              ({fmtPoint(recipe.printing.printerLightR)}, {fmtPoint(recipe.printing.printerLightG)},{' '}
              {fmtPoint(recipe.printing.printerLightB)})
            </span>
          </div>
          <PointStepper
            label="R"
            record="r"
            limit={12}
            value={recipe.printing.printerLightR}
            onChange={(v) => update((d) => (d.printing.printerLightR = v))}
          />
          <PointStepper
            label="G"
            record="g"
            limit={12}
            value={recipe.printing.printerLightG}
            onChange={(v) => update((d) => (d.printing.printerLightG = v))}
          />
          <PointStepper
            label="B"
            record="b"
            limit={12}
            value={recipe.printing.printerLightB}
            onChange={(v) => update((d) => (d.printing.printerLightB = v))}
          />
          <p className="control__hint">
            One point is 0.025 in log exposure; twelve make a stop. Authority is concentrated in the
            mid-scale and vanishes at both ends, which is a property of the print curve rather than a
            guard rail bolted on.
          </p>
        </div>

        <Slider
          label="Print density"
          value={recipe.printing.printDensity}
          min={-24}
          max={24}
          step={1}
          unit=" pts"
          format={(v) => (v > 0 ? `+${v}` : String(v))}
          detents={[0]}
          disabled={print.bypass}
          hint="Print exposure time, all three channels together. More density is a darker print."
          onChange={(v) => update((d) => (d.printing.printDensity = v))}
        />
        <Slider
          label="Saturation density"
          value={recipe.printing.saturationDensity}
          min={0}
          max={2}
          step={0.01}
          format={(v) => `${v.toFixed(2)}×`}
          detents={[1]}
          disabled={print.bypass || resolved.printEngine === 'lut'}
          hint="Scales the unwanted absorptions in the printing density matrix. Lower means less crosstalk, which reads as more saturation — and it acts before the print curve, so shadows and highlights respond differently."
          onChange={(v) => update((d) => (d.printing.saturationDensity = v))}
        />
        <Slider
          label="Highlight roll-off"
          value={recipe.printing.highlightRolloff}
          min={0.5}
          max={2}
          step={0.01}
          format={(v) => `${v.toFixed(2)}×`}
          detents={[1]}
          disabled={print.bypass || resolved.printEngine === 'lut'}
          hint="The print stock's toe softness. Film's celebrated highlight roll-off is this composed with the negative's shoulder; you need both."
          onChange={(v) => update((d) => (d.printing.highlightRolloff = v))}
        />
        <Slider
          label="Shadow lift"
          value={recipe.printing.shadowLift}
          min={0}
          max={0.6}
          step={0.01}
          format={(v) => v.toFixed(2)}
          detents={[0]}
          disabled={print.bypass || resolved.printEngine === 'lut'}
          hint="Reduces the print's Dmax — the lifted black of a print on aged paper."
          onChange={(v) => update((d) => (d.printing.shadowLift = v))}
        />
        <Slider
          label="Neutral axis · warm"
          value={recipe.printing.neutralAxisWarm}
          min={-0.3}
          max={0.3}
          step={0.005}
          format={(v) => (v > 0 ? `+${v.toFixed(3)}` : v.toFixed(3))}
          detents={[0]}
          disabled={print.bypass || resolved.printEngine === 'lut'}
          hint="Tilts the neutral axis: warms shadows and cools highlights at once, the way a real print does. It cannot produce a non-monotone neutral, which independent shadow and highlight tints can."
          onChange={(v) => update((d) => (d.printing.neutralAxisWarm = v))}
        />
        <Slider
          label="Neutral axis · tint"
          value={recipe.printing.neutralAxisTint}
          min={-0.3}
          max={0.3}
          step={0.005}
          format={(v) => (v > 0 ? `+${v.toFixed(3)}` : v.toFixed(3))}
          detents={[0]}
          disabled={print.bypass || resolved.printEngine === 'lut'}
          hint="The same tilt on the green–magenta axis: positive greens the shadows and turns the highlights magenta, together."
          onChange={(v) => update((d) => (d.printing.neutralAxisTint = v))}
        />
        <Slider
          label="Silver retention"
          value={recipe.printing.silverRetention}
          min={0}
          max={1}
          step={0.01}
          format={(v) =>
            v < 0.005 ? 'None' : v > 0.995 ? 'Bleach bypass' : Math.abs(v - 0.45) < 0.005 ? 'ENR' : v.toFixed(2)
          }
          detents={[0, 0.45, 1]}
          disabled={print.bypass || resolved.printEngine === 'lut'}
          hint="Silver is spectrally neutral, so retaining it adds neutral density on top of the dye image. Desaturation comes out strongest in the shadows on its own."
          onChange={(v) => update((d) => (d.printing.silverRetention = v))}
        />
      </Section>

      <Section
        title="Subtractive"
        meta={
          print.bypass ? (
            <>no print</>
          ) : (
            <>
              C {fmtD(recipe.subtractive.cyan)} · M {fmtD(recipe.subtractive.magenta)} · Y{' '}
              {fmtD(recipe.subtractive.yellow)}
            </>
          )
        }
      >
        <Slider
          label="Cyan"
          value={recipe.subtractive.cyan}
          min={-0.3}
          max={0.3}
          step={0.005}
          detents={[0]}
          disabled={print.bypass}
          format={fmtD}
          hint="Density of the dye that absorbs red. Pulling it (negative) warms the print; adding it cools. Neutrals stay neutral under equal amounts of all three."
          onChange={(v) => update((d) => (d.subtractive.cyan = v))}
        />
        <Slider
          label="Magenta"
          value={recipe.subtractive.magenta}
          min={-0.3}
          max={0.3}
          step={0.005}
          detents={[0]}
          disabled={print.bypass}
          format={fmtD}
          hint="Density of the dye that absorbs green."
          onChange={(v) => update((d) => (d.subtractive.magenta = v))}
        />
        <Slider
          label="Yellow"
          value={recipe.subtractive.yellow}
          min={-0.3}
          max={0.3}
          step={0.005}
          detents={[0]}
          disabled={print.bypass}
          format={fmtD}
          hint="Density of the dye that absorbs blue."
          onChange={(v) => update((d) => (d.subtractive.yellow = v))}
        />
        <Slider
          label="Density"
          value={recipe.subtractive.density}
          min={0}
          max={1}
          step={0.01}
          detents={[0]}
          disabled={print.bypass}
          format={(v) => `${Math.round(v * 100)}%`}
          hint={
            recipe.subtractive.densityMode === 'suppress'
              ? 'Adds neutral density: a denser, quieter print, the way a lab print carries more silver.'
              : 'Thins the dyes: a brighter, airier print with less contrast in the dyes themselves.'
          }
          onChange={(v) => update((d) => (d.subtractive.density = v))}
        />
        <Field label="Density mode" disabled={print.bypass}>
          <SegmentedControl
            label="Density mode"
            value={recipe.subtractive.densityMode}
            options={[
              { value: 'suppress', label: 'Suppress', title: 'The slider adds neutral density' },
              { value: 'multiply', label: 'Multiply', title: 'The slider thins the dyes' },
            ]}
            onChange={(v) => update((d) => (d.subtractive.densityMode = v as 'suppress' | 'multiply'))}
          />
        </Field>
      </Section>

      <Section
        title="Grain"
        meta={<>G꜀ {(negative.grain.selwyn * 1000).toFixed(1)}</>}
      >
        <Choice
          label="Preset"
          value={recipe.grain.preset ?? 'custom'}
          options={[
            { value: 'custom', label: 'Custom', detail: 'Amount and size set by hand below.' },
            ...GRAIN_PRESETS.map((p) => ({ value: p.id, label: p.displayName, detail: p.note })),
          ]}
          onChange={(id) =>
            update((d) => {
              if (id === 'custom') {
                d.grain.preset = null;
                return;
              }
              const p = grainPresetById(id);
              d.grain.preset = p.id;
              d.format = p.format;
              d.grain.amount = p.amount;
              d.grain.size = p.size;
            })
          }
        />
        <Slider
          label="Amount"
          value={recipe.grain.amount}
          min={0}
          max={2}
          step={0.01}
          format={(v) => (Math.abs(v - 1) < 0.005 ? 'Datasheet' : `${v.toFixed(2)}×`)}
          detents={[0, 1]}
          hint="1.00 is the granularity the datasheet publishes. Grain is added in the negative's density, so it is strongest in the mid-scale and vanishes at both Dmin and Dmax — which is why it lives in the shadows of a print rather than in its highlights."
          onChange={(v) => update((d) => { d.grain.amount = v; d.grain.preset = null; })}
        />
        <Slider
          label="Grain size"
          value={recipe.grain.size}
          min={0.4}
          max={3}
          step={0.01}
          format={(v) => `${(negative.grain.sigma1um * v).toFixed(2)} µm`}
          detents={[1]}
          onChange={(v) => update((d) => { d.grain.size = v; d.grain.preset = null; })}
        />
        <Slider
          label="Film response"
          value={recipe.grain.response}
          min={-1}
          max={1}
          step={0.02}
          format={(v) =>
            Math.abs(v) < 0.02
              ? '0.00 — stock'
              : v < 0
                ? `${v.toFixed(2)} — shadows`
                : `+${v.toFixed(2)} — highlights`
          }
          detents={[-1, 0, 1]}
          hint="Where the grain shows. A negative's grain is read in a print's shadows; a positive scan's grain sits in its highlights. The stock's own density dependence is the centre."
          onChange={(v) => update((d) => { d.grain.response = v; d.grain.preset = null; })}
        />
        <Slider
          label="Color variation"
          value={recipe.grain.colorMix}
          min={0}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          detents={[0, 1]}
          hint="0 is silver: one monochrome field in all three records. 100 is the stock's own chroma grain, each record its own field."
          onChange={(v) => update((d) => { d.grain.colorMix = v; d.grain.preset = null; })}
        />
      </Section>

      <Section title="Halation">
        <Choice
          label="Preset"
          value={recipe.halation.preset ?? 'custom'}
          options={[
            { value: 'custom', label: 'Custom', detail: 'Intensity and radius set by hand below.' },
            ...HALATION_PRESETS.map((p) => ({ value: p.id, label: p.displayName, detail: p.note })),
          ]}
          onChange={(id) =>
            update((d) => {
              if (id === 'custom') {
                d.halation.preset = null;
                return;
              }
              const p = halationPresetById(id);
              d.halation.preset = p.id;
              d.halation.intensity = p.intensity;
              d.halation.radius = p.radius;
            })
          }
        />
        <Slider
          label="Intensity"
          value={recipe.halation.intensity ?? negative.halation.alpha}
          min={0}
          max={1}
          step={0.01}
          format={(v) =>
            recipe.halation.intensity === null ? `${v.toFixed(2)} — stock` : v.toFixed(2)
          }
          hint="Light that reaches the base, scatters and comes back. Red survives the round trip best, so the halo is orange — that comes out of the per-channel scattering lengths, not out of a tint."
          onChange={(v) => update((d) => { d.halation.intensity = v; d.halation.preset = null; })}
        />
        <Slider
          label="Scatter"
          value={recipe.halation.radius}
          min={0.2}
          max={4}
          step={0.01}
          format={(v) => `${(negative.halation.lengthRedUm * v).toFixed(0)} µm`}
          detents={[1]}
          hint="The red scattering length — how far the reflected light spreads. Green and blue follow at 0.62 and 0.44 of it."
          onChange={(v) => update((d) => { d.halation.radius = v; d.halation.preset = null; })}
        />
        <Slider
          label="Dye transmission"
          value={recipe.halation.dyeTransmission}
          min={0}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          detents={[0, 1]}
          hint="How far the returning light takes the base's amber: the dye layers absorb its blue, so the halo leans orange. 0 keeps the transport's own per-channel split."
          onChange={(v) => update((d) => { d.halation.dyeTransmission = v; d.halation.preset = null; })}
        />
        <Slider
          label="Boost"
          value={recipe.halation.boost}
          min={0}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          detents={[0]}
          hint="Saturation of the halo about its own luminance."
          onChange={(v) => update((d) => { d.halation.boost = v; d.halation.preset = null; })}
        />
        <Slider
          label="Threshold"
          value={recipe.halation.threshold}
          min={0.2}
          max={6}
          step={0.05}
          format={(v) => `${v.toFixed(2)} · ${(Math.log2(v / 0.18)).toFixed(1)} EV over grey`}
          onChange={(v) => update((d) => { d.halation.threshold = v; d.halation.preset = null; })}
        />
        {recipe.halation.intensity !== null ? (
          <button
            type="button"
            className="link"
            onClick={() => update((d) => (d.halation.intensity = null))}
          >
            Return to the stock's own value
          </button>
        ) : null}
      </Section>

      <Section title="Diffusion">
        <Slider
          label="Strength"
          value={recipe.glow.strength}
          min={0}
          max={0.5}
          step={0.005}
          format={(v) =>
            v < 0.005 ? 'None' : v < 0.08 ? `${v.toFixed(2)} — 1/8` : v < 0.15 ? `${v.toFixed(2)} — 1/4` : v < 0.25 ? `${v.toFixed(2)} — 1/2` : `${v.toFixed(2)} — strong`
          }
          detents={[0, 0.06, 0.11, 0.19]}
          hint="Taking-lens diffusion: a two-term veil of scattered light, convolved with the scene before the film is exposed. Because it is pre-exposure the film's shoulder compresses it — highlights bloom and the shadows next to them lift, the restrained look of a Pro-Mist, not a screen blend."
          onChange={(v) => update((d) => (d.glow.strength = v))}
        />
        <Slider
          label="Halo scale"
          value={recipe.glow.sigma1Um}
          min={4}
          max={200}
          step={1}
          format={(v) => `${v.toFixed(0)} µm`}
          detents={[24]}
          hint="The tight halo around highlights, in micrometres at the film plane. The broad veil follows at a fixed multiple of this."
          onChange={(v) => update((d) => (d.glow.sigma1Um = v))}
        />
        <Slider
          label="Veil breadth"
          value={recipe.glow.broad}
          min={0}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          detents={[0.6]}
          hint="How much of the veil is the broad, contrast-lowering term versus the tight halo. More broad means a softer, lower-contrast image; less means a crisper halo."
          onChange={(v) => update((d) => (d.glow.broad = v))}
        />
      </Section>

      <Section title="Viewing">
        <Slider
          label="Surround"
          value={recipe.output.surroundExponent}
          min={0.8}
          max={1.2}
          step={0.01}
          format={(v) =>
            Math.abs(v - 1) < 0.005 ? '1.00 — room light' : v < 1 ? `${v.toFixed(2)} — dark` : `${v.toFixed(2)} — bright`
          }
          detents={[0.9, 1]}
          hint="A print judged in a dark surround needs less contrast than the same print in room light. 0.90 is the projection condition."
          onChange={(v) => update((d) => (d.output.surroundExponent = v))}
        />
        <Slider
          label="Grain seed"
          value={recipe.seed}
          min={1}
          max={64}
          step={1}
          format={(v) => `#${v}`}
          hint="A different piece of film from the same box."
          onChange={(v) => update((d) => (d.seed = v))}
        />
      </Section>
    </>
  );
}

function fmtPoint(v: number) {
  return v > 0 ? `+${v}` : String(v);
}

function fmtD(v: number) {
  return v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2);
}

function Stat({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone?: 'warn';
  title?: string;
}) {
  return (
    <div className={`stat${tone ? ` stat--${tone}` : ''}`} title={title}>
      <span className="stat__label">{label}</span>
      <span className="stat__value num">{value}</span>
    </div>
  );
}
