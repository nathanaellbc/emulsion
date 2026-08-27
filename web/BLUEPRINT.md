# EMULSION — Application Blueprint

**Purpose of this document.** It describes exactly what the EMULSION web app *does*, so that a
new user interface can be built for it without reading the imaging code. It is a behavioural
specification, not a visual one: every screen, state, control, unit, range, default, disable
rule, side effect and data contract is recorded here. The visual language is described in
§11 as *what exists today*, not as a requirement.

**What must not change.** Everything under `src/core/`, `src/gl/` and `src/io/` is the model.
The UI is a view over a single serialisable object (the `Recipe`) plus a derived read-only
object (`ResolvedParameters`). A new UI replaces `src/ui/` and `src/styles/` only. If a
proposed control cannot be expressed as a field of `Recipe`, it does not exist in this app.

---

## 1. What the app is

A browser application that takes one photographic file and carries it through a physically
modelled analog film pipeline — latent image, characteristic curve, chemical development,
interlayer (DIR coupler) inhibition, optical print exposure, print-stock reproduction,
stochastic grain, halation, taking-lens diffusion, and a display transform — rendering the
result live on the GPU.

Key facts that shape the interface:

- **Single document, single file.** There is no project browser, no library, no gallery, no
  layers, no history stack, no accounts, no server. One image at a time.
- **Nothing leaves the device.** Decoding and rendering are local. This is stated in the empty
  state and is a product claim, not an implementation detail.
- **It is not a filter or a LUT-with-grain.** Controls are named for the physical quantity they
  set, in that quantity's unit — printer *points*, log exposure, density, stops, micrometres,
  Kelvin. There is deliberately no "warmth 0–100", no "film strength", no star ratings, no
  named looks beyond the honest presets listed in §6.
- **The instrument is as important as the picture.** A live D–log E (density vs. log exposure)
  plot showing the three colour records over a histogram of the actual photograph is a
  first-class element of the interface, not an optional inspector.
- **Everything is live.** Any control change re-resolves parameters and repaints within one
  animation frame. There is no "apply", no "render" button, no progress bar for edits.

Requirements: WebGL2 with `EXT_color_buffer_float`. Without it the app renders a fatal screen
(§9.1) and nothing else.

---

## 2. The data model

### 2.1 `Recipe` — the whole edit

The complete, serialisable state of an edit. Defined in `src/core/recipe.ts`. Persisted to
`localStorage` under key `emulsion.recipe.v1` on every change. The UI never writes any other
edit state anywhere.

```
Recipe {
  negativeId        string        // which film stock
  printId           string        // which print stock
  chemistryId       string        // which developer process
  format            FilmFormat    // simulated frame size
  seed              number        // grain seed, 1..64
  printEngine       'model'|'lut' // calculated print vs. measured print
  printIlluminant   'D55'|'D60'|'D65'

  capture     { exposureCompensation, filmSpeedOverride, whiteBalanceTempK, whiteBalanceTint }
  camera      { contrast, highlights, shadows, whites, blacks, saturation }
  develop     { pushPull, timeSeconds, temperatureK, agitation, developerConcentration }
  interlayer  { couplerActivity }
  printing    { printerLightR/G/B, printDensity, saturationDensity, highlightRolloff,
                shadowLift, neutralAxisWarm, neutralAxisTint, silverRetention }
  subtractive { cyan, magenta, yellow, density, densityMode }
  grain       { amount, size, response, colorMix, preset }
  halation    { intensity, radius, threshold, dyeTransmission, boost, preset }
  glow        { strength, sigma1Um, sigmaRatio, broad }
  output      { surroundExponent }
}
```

Contract for the UI:

- **Mutate through one path.** `update(draft => { draft.x.y = v })` — the app clones the recipe,
  applies the mutation, then runs `clampRecipe()` on the result. The UI must never write a
  recipe field directly, because clamping is what keeps every value inside the model's valid
  domain.
- **`clampRecipe` is authoritative.** The ranges in the control tables of §5 are the same ranges
  `clampRecipe` enforces. A control may present a narrower range; it may never present a wider
  one.
- **Backwards compatibility is handled in `clampRecipe`.** A stored recipe from an older version
  missing whole blocks (`camera`, `subtractive`, `glow`) degrades to defaults rather than
  throwing. A stored recipe naming a stock that no longer exists is repaired by `sanitizeRecipe`
  on load. Neither is the UI's concern beyond calling them.
- **`contentHash(recipe)` / `canonicalJSON(recipe)`** exist for cache keys and are stable across
  key order. Available if a new UI wants recipe identity (e.g. an unsaved-changes marker).

### 2.2 `ResolvedParameters` — the derived read-only state

`resolve(recipe, { renderWidthPx, sourceSpace })` produces the dense parameter set the shader
runs — matrices, curve parameters, print curve, aim balance, interlayer kernel sizes, sensitometry.
It is recomputed by `useMemo` on any change to recipe, render width, source colour space, or the
LUT-loaded counter.

The UI reads these fields for display:

| Field | Used for |
|---|---|
| `negative`, `print` | Display names, per-stock numbers (ISO, grain σ, halation length) |
| `curve` | Drawing the D–log E plot |
| `anchorShift`, `exposureGain`, `camera` | Positioning the histogram and the 18% grey marker on the plot |
| `monochrome` | Plot draws one grey curve instead of three coloured ones |
| `sensitometry` | Film section readout: `iso`, `contrastIndex`, `dMin`, `dMax`, `latitudeStops`, `margin` |
| `developmentActivity` | Development section meta (`A = 1.000`) |
| `interlayer.enabled`, `interlayer.sigma2Px` | Interlayer section meta |
| `printEngine`, `printLut` | Print section meta, engine toggle, illuminant options |
| `print.bypass` | Disables the entire print/subtractive control group |
| `warnings: string[]` | Notice strip (§9.3) |

`ResolvedParameters` is never written by the UI.

### 2.3 `DecodedSource` — the loaded file

```
DecodedSource { image, space, kind: 'raw'|'standard', fileName,
                camera?, iso?, shutter?, aperture?, focalLength?, caveat? }
```

`caveat` is set for display-referred files and must be surfaced (§9.3). `kind` drives the
provenance caption (§4.3).

---

## 3. Application states

| State | Condition | What is shown |
|---|---|---|
| **Fatal** | WebGL2 unavailable / renderer threw | Only a fatal panel with the error message. Nothing else mounts. |
| **Empty** | No file loaded | Top bar + full-width viewport area occupied by the drop zone (§4.5). The control rail and plot are absent entirely. |
| **Loaded** | A file decoded | Top bar + viewport + control rail (plot, notices, control panel). |
| **Busy** | Decoding a file | A small "Working" status indicator; the top bar's Export action is disabled. |
| **Dragging** | A file is dragged over the window | A drag-affordance treatment on the whole shell. |
| **Exporting** | Export bench open | A modal over the loaded state. The renderer and canvas persist beneath it and must not unmount. |

**Hard constraint:** the WebGL canvas element must live for the entire session. The GL context,
its compiled programs and every allocated render target belong to that element. A new UI must
not unmount, remount, key-change or conditionally render the canvas — including while the export
modal is open.

---

## 4. Screen anatomy

Present layout is a two-column stage under a fixed header. A new UI may rearrange this, but every
element below must have a home.

```
┌─────────────────────────────────────────────────────────────┐
│ TOP BAR   EMULSION · Digital film laboratory   [Open][Reset][Export print] │
├──────────────────────────────────────┬──────────────────────┤
│ VIEWPORT                             │ RAIL                 │
│  ├ bar: inspect stages | Compare | Clipping                 │
│  ├ frame: canvas (+ zoom, split seam, zoom badge)  │ D–log E plot        │
│  └ foot: filename · provenance caption             │ notices             │
│                                      │ control panel        │
└──────────────────────────────────────┴──────────────────────┘
```

### 4.1 Top bar

| Element | Behaviour |
|---|---|
| Brand | `EMULSION` + subtitle `Digital film laboratory`. Subtitle hides under 900 px. |
| **Open** | Ghost button. Opens a file picker with `accept` = `image/*` plus every RAW extension. Always enabled. |
| **Reset** | Ghost button. Replaces the recipe with `defaultRecipe()` — no confirmation. Disabled with no source. |
| **Export print** | Primary button. Opens the export bench. Disabled with no source or while busy. |

### 4.2 Viewport bar

- **Inspect stage** — four mutually exclusive modes, always available:

  | Mode | Shows |
  |---|---|
  | `print` | The finished print. Default. |
  | `negative` | Negative density, normalised — what is actually on the film before printing. |
  | `printDensity` | Print density before the display transform. |
  | `halationSource` | The source term: which parts of the scene are bright enough to scatter. |

- **Compare** — toggle chip. Off sets split = 0; on sets split = 0.5. When on, the viewport shows
  the decoded scene on the left of a draggable seam and the print on the right, with `Scene` and
  `Print` tags in the corners. The seam is a thin line with a keyboard-operable handle
  (`role="slider"`, arrow keys move it by 0.02, range 0.02–1).
- **Clipping** — toggle chip. Marks pixels that reach display white or display black on all three
  channels.

### 4.3 Viewport frame

- The GL canvas fills the frame, object-fit contained.
- **Zoom belongs to the picture, never the page.** The document sets `touch-action: pan-y` so the
  browser's own pinch is refused; the picture layer opts back in for its own gesture. Zoom is a
  pure CSS transform on the picture layer — render resolution is untouched.
  - Pinch (two pointers) — scale 1 to 8, anchored at the pinch midpoint.
  - `Ctrl`/`Cmd` + wheel (trackpad pinch) — anchored at the cursor.
  - Wheel/two-finger scroll while zoomed — pans. At scale 1 the wheel is left to the page.
  - Drag while zoomed — pans. At scale 1 a single pointer is left to the page.
  - Double tap / double click — in to 2.5× around the tap, or back out to 1× if already zoomed.
  - Panning is bounded: the picture can never be dragged off the frame.
  - A **zoom badge** (`3.2×`) appears when zoomed, sits on the frame (not the transformed layer),
    and returns to 1× on click.
  - A new photograph resets zoom to identity.
- The split seam handle and the Scene/Print tags ride the same transform as the picture, so they
  stay on the seam and in the corners at any zoom.

### 4.4 Viewport foot

- File name (monospace), or `—`.
- Provenance caption, built by joining with `·`:
  `RAW · linear ACES` or `Display-referred source` / camera model / `ISO nnn` /
  `<negative display name> on <print display name>`.

### 4.5 Empty state (drop zone)

The first thing anyone sees and the argument for the whole application. Contains:

- A characteristic-curve mark (toe / straight line / shoulder, with a point on the straight line).
- Title `EMULSION` with subtitle `Digital film laboratory`.
- Lede: *"A scene-referred capture carried through the stages of analog processing: latent image,
  characteristic curve, chemical development, optical print exposure, print stock, grain, and the
  light that scatters off the back of the base and comes home red."*
- Primary button **Choose an image**, and below it *"or drop one anywhere on this page"*.
- A decode error, if any, in an alert role.
- Three facts:
  - **RAW** — the first ten RAW extensions, uppercase, "and more, decoded linear with every
    rendering intent switched off".
  - **Also** — "JPEG, PNG, TIFF, WebP — with a tone curve already baked in, and the app will say so".
  - **Privacy** — "Decoding and rendering happen on this device. No upload, no server, no account".

### 4.6 File input paths

All three must work in every state:

1. The **Open** button / **Choose an image** button (file picker).
2. **Drop anywhere on the window** — drag-enter/leave is depth-counted so nested elements don't
   flicker the drag state; the first file of the drop is taken.
3. **Paste** — a `paste` event carrying a file loads it.

Accepted: 28 RAW extensions (`dng cr2 cr3 crw nef nrw arw srf sr2 raf orf rw2 pef ptx dcr kdc
mrw raw rwl 3fr fff iiq mos erf mef x3f srw gpr`) decoded via LibRaw-WASM to linear ACES AP0
with every rendering intent switched off; and ordinary images (`jpg jpeg png webp avif tif tiff
bmp gif`) decoded by the browser as sRGB, which sets a `caveat` that the UI must show.

On successful decode the app: sets the renderer source at preview width, stores the source,
computes a scene log histogram for the plot, and measures the file's log-average luminance
(offered, never applied — see §5.1).

---

## 5. The control rail

Sections are ordered in the order the work happens. That order is load-bearing: a user who moves
printer lights before setting development is balancing a negative that is about to change
underneath them.

The rail contains, top to bottom: **the D–log E plot** (§7), **the notices strip** (§9.3), then
**the control panel**.

The control panel is split into two pages, selected by a tab pair at the top of the panel:

- **Camera** — the scene-side grade, i.e. what a RAW develop would have done before the film saw
  the light.
- **Film** — the bench proper: stock, rating, development, print, and the spatial phenomena.

> **Current repository state.** The Camera/Film tab split exists in `Panel.tsx` but is not yet
> wired through `App.tsx`; `npx tsc -b --noEmit` currently reports 7 errors, all of them in
> `App.tsx`/`Panel.tsx`/`resolve.ts` from this in-progress refactor (missing `tab`/`onTabChange`
> and `camera` props, an argument-type slip on `sceneLogHistogram`, and two unused bindings).
> The new UI should implement the two-page rail as specified here and wire the props through.

### Control primitives

| Primitive | Behaviour |
|---|---|
| **Slider** | Label + live readout (value with an optional unit). A track with a fill. Optional **detents**: tick marks at meaningful values (0, 1×, the stock's own value, the normal process). Optional hint paragraph beneath. Optional disabled state. |
| **PointStepper** | Integer-only ±N control used exclusively for printer lights. Centre-anchored bar growing left or right of zero. Integer by design — printer points are integers in practice and integers are what makes a grade communicable. |
| **Choice** | Labelled select. The selected option's `detail` text renders as the hint beneath, so choosing a stock explains that stock. |
| **SegmentedControl** | A radiogroup row of mutually exclusive buttons with tooltips. |
| **Section** | Titled group with an optional right-aligned **meta** readout in monospace, showing a live derived number for that section. |
| **Readout / Stat** | A grid of label + monospace value pairs. Supports a `warn` tone. |

Every numeric readout uses tabular monospace figures so values do not jitter as they change.

---

### 5.1 Camera page

#### Section — Exposure & tone

| Control | Field | Range | Step | Readout | Detents |
|---|---|---|---|---|---|
| Exposure | `capture.exposureCompensation` | −5 … 5 | 1/3 | `+1.33 EV` | 0 |
| Contrast | `camera.contrast` | −0.75 … 0.75 | 0.01 | `1.42×` (= 2^v) | 0 |
| Highlights | `camera.highlights` | −1.5 … 1.5 | 0.05 | `+0.45 stops` | 0 |
| Shadows | `camera.shadows` | −1.5 … 1.5 | 0.05 | `+0.45 stops` | 0 |
| Whites | `camera.whites` | −2 … 2 | 0.05 | `+0.45 stops` | 0 |
| Blacks | `camera.blacks` | −2 … 2 | 0.05 | `+0.45 stops` | 0 |

Hints (verbatim, they carry the model's meaning):

- **Exposure** — "How much light the sensor delivered. This is the exposure the film receives —
  moving it slides the whole picture along the characteristic curve, which the plot beneath shows."
- **Contrast** — "Slope of the tone curve in log space about scene grey. 1.00× leaves it
  untouched; 1.68× is steep, 0.59× is flat."
- **Highlights** — "Recovers or pushes the bright mid-scale, a stop and a half over grey, with a
  soft knee. Chromaticity is preserved: a saturated highlight keeps its hue."
- **Shadows** — "Lifts or holds the dark mid-scale, a stop and a half under grey. Acts in log
  space, so a lifted shadow stays positive where a multiplicative lift cannot."
- **Whites** — "The extreme top end, four stops over grey: sets where speculars land. The film's
  shoulder takes it from here."
- **Blacks** — "The extreme bottom end, four stops under grey: how far down the shadows reach
  before the toe. True black stays black."

**The grey-anchor affordance.** Directly under the Exposure slider, when a middle grey has been
measured for the file, a line reads: *"This file's log-average luminance is `0.0731`."* followed
by either

- a link **"Anchor it to 18% grey (+1.30 EV)"** when the suggested shift differs from the current
  exposure by more than 0.05 EV, which sets `capture.exposureCompensation` to the suggestion; or
- the sentence *"It is already anchored near 18% grey."*

This is **offered, never applied**. The app deliberately does not second-guess the photographer's
exposure — silently applying it would be exactly the kind of hidden rendering intent the decode
path spends its effort switching off.

#### Section — Colour

| Control | Field | Range | Step | Readout | Detents |
|---|---|---|---|---|---|
| White balance | `capture.whiteBalanceTempK` | 2000 … 12000 | 50 | `5500 K` | `5500`, or `3200, 5500` for a tungsten-balanced stock |
| Tint | `capture.whiteBalanceTint` | −1 … 1 | 0.01 | `+0.24 G` / `−0.24 M` / `0.00` | 0 |
| Saturation | `camera.saturation` | 0 … 2 | 0.01 | `1.00×` | 1 |

The **White balance** hint is stock-dependent:

- Daylight-balanced stock: "What light the scene was under. Applied as a von Kries adaptation in
  cone space, not as a channel gain, because channel gain in a wide-gamut space rotates hue in
  saturated colours."
- Tungsten-balanced stock (`negative.aimIlluminantK === 3200`): "This stock's layers are balanced
  for 3200 K. Leaving this at 5500 K says the scene was daylight and the film was not corrected
  for it, which is where the blue cast comes from; setting it to 3200 K says the light matched
  the stock, and the cast goes away."

**Saturation** hint: "Scene-side, before the film. 1.00× is untouched. Luminance is preserved
exactly. The print's own saturation density — the crosstalk matrix — lives on the Film page, and
the two are genuinely different controls."

---

### 5.2 Film page

#### Section — Film
Meta: `ISO 400 · CI 0.58`, or for the ideal negative `ideal · γ 1.00` (an ideal record satisfies
the ISO criterion trivially, so printing a speed for it would invite belief in a number that
describes the criterion, not the film).

**Negative stock** — a Choice of 11 entries. The selected entry's note renders as the hint.

| id | Label | Family | ISO | Note (the hint text) |
|---|---|---|---|---|
| `neg.ideal` | None — ideal negative | colour neg. | — | "No stock at all: a straight line of gamma 1 with no toe, no shoulder, no fog and no mask, so that everything left in the picture is the print stock and your exposure…" |
| `neg.portra160` | Portra 160-type · C-41 | colour neg. | 160 | Low contrast, high DIR activity. The gentlest of the launch stocks. |
| `neg.portra400` | Portra 400-type · C-41 | colour neg. | 400 | The reference stock. Fitted against a full D-logE family, Wiener spectrum and MTF. |
| `neg.gold200` | Gold 200-type · C-41 | colour neg. | 200 | Consumer stock: warmer, more contrast, coarser grain. |
| `neg.ektar100` | Ektar 100-type · C-41 | colour neg. | 100 | Most saturated: highest gamma, finest grain, tightest halation. |
| `neg.superia400` | Superia 400-type · C-41 | colour neg. | 400 | Distinct green rendering. |
| `neg.v3_500t` | Vision3 500T-type · ECN-2 | colour neg. | 500 | Tungsten balanced (aim 3200 K). |
| `rev.velvia50` | Velvia 50-type · E-6 | transparency | 50 | Reversal: gamma is negative; defaults to the bypass print. |
| `rev.provia100` | Provia 100F-type · E-6 | transparency | 100 | The even-handed transparency. |
| `mono.trix400` | Tri-X 400-type · B&W | monochrome | 400 | One silver image; neutral grain, coarsest in the bundle. |
| `mono.hp5` | HP5 Plus-type · B&W | monochrome | 400 | Smallest well-formedness margin — the first stock the constraint binds on. |

**Side effects of choosing a stock** (all in one update): also set `chemistryId` to the stock's
own process, `printId` to the stock's `defaultPrint`, and clear `capture.filmSpeedOverride`.
A new UI must preserve this — a Velvia selection that keeps a C-41 developer and a print stage is
not a thing this model represents.

**Format** — Choice of 7, hinted "Grain and halation are specified in micrometres at the film
plane. A larger frame means the same physical grain covers less of the picture."

| Value | Label | Frame width |
|---|---|---|
| `format135` | 35 mm | 36.0 mm |
| `format645` | 645 | 56.0 mm |
| `format66` | 6×6 | 56.0 mm |
| `format45` | 4×5 | 102.0 mm |
| `super35` | Super 35 | 24.9 mm |
| `super16` | Super 16 | 12.5 mm |
| `standard8` | Standard 8 | 10.3 mm |

**Rated at** — Choice of exposure index. Options are the stock's ISO × {0.25, 0.5, 1, 2, 4, 8},
labelled `EI 800 — 1 stop under`, `EI 400 — box speed`, `EI 100 — 2 stop over`, etc. Writes
`capture.filmSpeedOverride`, or `null` when box speed is chosen. **Hidden entirely for the ideal
negative**, where rating is exposure compensation under another name. Hint: "Shooting a 400 stock
at 800 gives the film half the light, which moves the whole image down into the toe. Push
development is how you get it back — and what it costs is on the curve."

**Readout** — four stats from `resolved.sensitometry`:

| Stat | Value |
|---|---|
| Dmin | `dMin`, 2 dp |
| Dmax | `dMax`, 2 dp |
| Latitude | `latitudeStops` 1 dp + ` EV` |
| Margin | `margin`, 2 dp. **Warn tone when < 0.25.** Tooltip: "ΔD − 4(κt + κs). Below zero the toe and shoulder have met and there is no straight line left." |

#### Section — Development
Meta: `A = 1.000` (`resolved.developmentActivity`).

| Control | Field | Range | Step | Readout | Detents |
|---|---|---|---|---|---|
| Chemistry | `chemistryId` | Choice: C-41, ECN-2, E-6, B&W | — | — | — |
| Push / pull | `develop.pushPull` | −2 … 3 | 1 | `Normal` / `Push 2 stops` / `Pull 1 stop` | every integer |
| Agitation | `develop.agitation` | 0.2 … 2 | 0.05 | `1.00×` | 1 |
| Developer strength | `develop.developerConcentration` | 0.4 … 1.6 | 0.05 | `1.00×` | 1 |

Hints: Chemistry — "Cross-processing is available and behaves the way it does in a tank: the
curve reshapes, the fog rises, and nothing about it is a preset." Push/pull — "Gamma saturates
toward a ceiling, fog rises without one, and speed comes back only partly. A push is not an
exposure change and the curve says so." Agitation — "1.00 is the manufacturer's recommended
scheme. Toward zero is stand development."

`develop.timeSeconds` and `develop.temperatureK` exist in the recipe (null = the chemistry's
reference) but have **no control today**. A new UI may expose them; it is not required to.

#### Section — Interlayer
Meta, three states: `off` when activity < 0.001; `σ₂ = 0.34 px` when the operator is enabled;
`below the render` when the stage is asking for a kernel finer than this render can carry. The
third is not the same thing as off and the interface must say which.

| Control | Field | Range | Step | Readout | Detents |
|---|---|---|---|---|---|
| Coupler activity | `interlayer.couplerActivity` | 0 … 2 | 0.05 | `100%` | 1 |

Hint: "DIR couplers release an inhibitor that suppresses development next to where it was
released — a rim at every edge, and a green region suppressing the red and blue beside it. Not a
sharpness control: it works on the local difference between records, which no saturation slider
can reach. Agitation sets how far the inhibitor travels."

A standing note beneath: "The diffusion lengths are 1.2 µm and 6 µm at the film plane. A 35 mm
frame rendered 2048 px across has a 17.6 µm pixel, so the effect is genuinely below the
resolution until the export — it is not floored into visibility here."

#### Section — Print
Meta: `measured · 2383-type · D65`, or `calculated`, or `calculated · no measurement`.

**Print engine** — SegmentedControl, shown **only when a measured LUT exists for the stock**:

- `Measured` — the stock's own measured response (tooltip carries the LUT's source string).
- `Calculated` — the design document's print model: crosstalk matrix, aim balance, print curve.

Below it, an engine-dependent explanation:
- Measured: "Saturation, roll-off, shadow lift, neutral axis and silver are inside the
  measurement — they describe the print stock itself, and this LUT is that stock, measured."
- Calculated: "The print is computed from the stock's published curve parameters. The measured
  LUT for this stock is one toggle away."

When no LUT exists, the toggle is absent and a line reads: "No measured LUT ships for this stock,
so it renders through the calculated model."

**Print stock** — Choice of 5. The selected entry's `character` text is the hint.

| id | Label | Character |
|---|---|---|
| `prt.2383` | 2383-type | The default. Moderate saturation, warm-leaning neutral axis, gentle toe. |
| `prt.2393` | 2393-type | Higher saturation, deeper Dmax, harder shoulder. More contrast, less latitude. |
| `prt.3513` | 3513-type | Cooler neutral axis, different green and cyan, softer approach to Dmax. |
| `prt.3521` | 3521-type **· model only** | Higher-saturation rendering with characteristic magenta handling. |
| `prt.bypass` | Bypass (scan) | No print transfer. Negative density inverted and normalised only — the flat look of an unadjusted lab scan. |

Measured LUTs ship for 2383 (D55/D60/D65), 3513 (D55/D60/D65) and 2393 (D65 only). 3521 has no
redistributable measurement and is therefore labelled `· model only`.

**Print illuminant** — SegmentedControl over the LUT's own `illuminants` array. Shown only when a
LUT exists. **Disabled** unless the engine is `lut` *and* the LUT has more than one illuminant.
Explanation line, by case:
- Live: "The white point the print was measured under: 5500 K daylight, 6000 K, or 6500 K."
- Engine is model: "The illuminant follows the measurement — switch the engine to Measured to
  choose it."
- Single-illuminant LUT: "This measurement ships in a single white point, so there is nothing to
  switch."

**Printer lights** — a grouped control with a header showing the grade as a triple, e.g.
`(+3, 0, −2)`, and three integer PointSteppers labelled R, G, B, each in the record's own colour.
Range ±12, step 1. The whole group goes inert when the print is bypassed. Standing note: "One
point is 0.025 in log exposure; twelve make a stop. Authority is concentrated in the mid-scale
and vanishes at both ends, which is a property of the print curve rather than a guard rail
bolted on."

The remaining print controls:

| Control | Field | Range | Step | Readout | Detents | Disabled when |
|---|---|---|---|---|---|---|
| Print density | `printing.printDensity` | −24 … 24 | 1 | `+6 pts` | 0 | bypass |
| Saturation density | `printing.saturationDensity` | 0 … 2 | 0.01 | `1.00×` | 1 | bypass **or** engine = lut |
| Highlight roll-off | `printing.highlightRolloff` | 0.5 … 2 | 0.01 | `1.00×` | 1 | bypass **or** engine = lut |
| Shadow lift | `printing.shadowLift` | 0 … 0.6 | 0.01 | `0.00` | 0 | bypass **or** engine = lut |
| Neutral axis · warm | `printing.neutralAxisWarm` | −0.3 … 0.3 | 0.005 | `+0.045` (3 dp) | 0 | bypass **or** engine = lut |
| Neutral axis · tint | `printing.neutralAxisTint` | −0.3 … 0.3 | 0.005 | `+0.045` (3 dp) | 0 | bypass **or** engine = lut |
| Silver retention | `printing.silverRetention` | 0 … 1 | 0.01 | `None` at 0, `ENR` at 0.45, `Bleach bypass` at 1, else 2 dp | 0, 0.45, 1 | bypass **or** engine = lut |

The lut-disabled rule matters and must be preserved: those five parameters describe the print
stock itself, and when the measured stock is rendering, they are already inside the measurement.

Hints: Print density — "Print exposure time, all three channels together. More density is a
darker print." Saturation density — "Scales the unwanted absorptions in the printing density
matrix. Lower means less crosstalk, which reads as more saturation — and it acts before the print
curve, so shadows and highlights respond differently." Highlight roll-off — "The print stock's toe
softness. Film's celebrated highlight roll-off is this composed with the negative's shoulder; you
need both." Shadow lift — "Reduces the print's Dmax — the lifted black of a print on aged paper."
Neutral axis warm — "Tilts the neutral axis: warms shadows and cools highlights at once, the way a
real print does. It cannot produce a non-monotone neutral, which independent shadow and highlight
tints can." Silver retention — "Silver is spectrally neutral, so retaining it adds neutral density
on top of the dye image. Desaturation comes out strongest in the shadows on its own."

#### Section — Subtractive
The colourist's subtractive bench, acting on the print's dye amounts. It grades identically under
both print engines.
Meta: `C +0.05 · M −0.02 · Y 0.00`, or `no print` when bypassed.

| Control | Field | Range | Step | Readout | Detents | Disabled when |
|---|---|---|---|---|---|---|
| Cyan | `subtractive.cyan` | −0.3 … 0.3 | 0.005 | `+0.05` | 0 | bypass |
| Magenta | `subtractive.magenta` | −0.3 … 0.3 | 0.005 | `+0.05` | 0 | bypass |
| Yellow | `subtractive.yellow` | −0.3 … 0.3 | 0.005 | `+0.05` | 0 | bypass |
| Density | `subtractive.density` | 0 … 1 | 0.01 | `35%` | 0 | bypass |
| Density mode | `subtractive.densityMode` | Segmented: `Suppress` / `Multiply` | — | — | — | bypass |

Hints: Cyan — "Density of the dye that absorbs red. Pulling it (negative) warms the print; adding
it cools. Neutrals stay neutral under equal amounts of all three." Magenta — "Density of the dye
that absorbs green." Yellow — "Density of the dye that absorbs blue." Density — **mode-dependent**:
in Suppress, "Adds neutral density: a denser, quieter print, the way a lab print carries more
silver."; in Multiply, "Thins the dyes: a brighter, airier print with less contrast in the dyes
themselves." Segment tooltips: Suppress "The slider adds neutral density", Multiply "The slider
thins the dyes".

#### Section — Grain
Meta: `G꜀ 4.7` (the stock's Selwyn granularity × 1000, 1 dp).

**Preset** — Choice: `Custom` plus 7 presets. Choosing a preset writes `grain.preset`,
**`format`**, `grain.amount` and `grain.size` together. Choosing `Custom` sets `preset = null`
and changes nothing else.

| id | Label | Format | Amount | Size | Note |
|---|---|---|---|---|---|
| `grain.off` | Off | 135 | 0 | 1 | "No grain. The chain still runs; only the stochastic stage is skipped." |
| `grain.45` | Large format · 4×5 | 4×5 | 1 | 1 | The smooth tonality large format is prized for. |
| `grain.645` | Medium format · 645 | 645 | 1 | 1 | Noticeably finer than 35 mm at the same stock and speed. |
| `grain.135` | 35 mm · datasheet | 135 | 1 | 1 | The reference. **Default.** |
| `grain.135pushed` | 35 mm · pushed | 135 | 1.4 | 1.5 | Coarser, more present grain. A deliberate look, named as one. |
| `grain.super16` | Super 16 | S16 | 1 | 1 | The visible, dancing grain of 16 mm motion film. |
| `grain.standard8` | Standard 8 | Std 8 | 1 | 1 | Home-movie grain, huge on screen. |

| Control | Field | Range | Step | Readout | Detents |
|---|---|---|---|---|---|
| Amount | `grain.amount` | 0 … 2 | 0.01 | `Datasheet` at 1.00, else `1.35×` | 0, 1 |
| Grain size | `grain.size` | 0.4 … 3 | 0.01 | `0.85 µm` (= stock σ₁ × value) | 1 |
| Film response | `grain.response` | −1 … 1 | 0.02 | `0.00 — stock` / `−0.60 — shadows` / `+0.60 — highlights` | −1, 0, 1 |
| Color variation | `grain.colorMix` | 0 … 1 | 0.01 | `35%` | 0, 1 |

**Every one of these four sliders clears `grain.preset` to `null`** when moved by hand, which
flips the Preset choice to `Custom`.

Hints: Amount — "1.00 is the granularity the datasheet publishes. Grain is added in the negative's
density, so it is strongest in the mid-scale and vanishes at both Dmin and Dmax — which is why it
lives in the shadows of a print rather than in its highlights." Film response — "Where the grain
shows. A negative's grain is read in a print's shadows; a positive scan's grain sits in its
highlights. The stock's own density dependence is the centre." Color variation — "0 is silver: one
monochrome field in all three records. 100 is the stock's own chroma grain, each record its own
field."

#### Section — Halation

**Preset** — Choice: `Custom` plus 3. Choosing a preset writes `halation.preset`, `intensity` and
`radius`.

| id | Label | Intensity | Radius | Note |
|---|---|---|---|---|
| `hal.off` | Off | 0 | 1 | "No halation. Highlights stay clean; the pointwise chain is unaffected." |
| `hal.stock` | Stock's own | `null` | 1 | "The halation the datasheet implies for this stock — its own alpha and scattering lengths, untouched." **Default.** |
| `hal.strong` | Strong — backing removed | 0.55 | 1.3 | "The look of a stock with its antihalation backing gone: a broad orange-red halo around every specular highlight." |

| Control | Field | Range | Step | Readout | Detents |
|---|---|---|---|---|---|
| Intensity | `halation.intensity` (null → the stock's alpha) | 0 … 1 | 0.01 | `0.42 — stock` while null, else `0.42` | — |
| Scatter | `halation.radius` | 0.2 … 4 | 0.01 | `120 µm` (= stock red length × value) | 1 |
| Dye transmission | `halation.dyeTransmission` | 0 … 1 | 0.01 | `55%` | 0, 1 |
| Boost | `halation.boost` | 0 … 1 | 0.01 | `30%` | 0 |
| Threshold | `halation.threshold` | 0.2 … 6 | 0.05 | `1.60 · 3.2 EV over grey` | — |

All five clear `halation.preset`. When `intensity` is non-null, a link **"Return to the stock's
own value"** appears at the bottom of the section and sets it back to `null`.

Hints: Intensity — "Light that reaches the base, scatters and comes back. Red survives the round
trip best, so the halo is orange — that comes out of the per-channel scattering lengths, not out
of a tint." Scatter — "The red scattering length — how far the reflected light spreads. Green and
blue follow at 0.62 and 0.44 of it." Dye transmission — "How far the returning light takes the
base's amber: the dye layers absorb its blue, so the halo leans orange. 0 keeps the transport's
own per-channel split." Boost — "Saturation of the halo about its own luminance."

#### Section — Diffusion
Taking-lens diffusion / veiling glare, applied to the linear scene **before** the film is exposed,
so the film's shoulder compresses it.

| Control | Field | Range | Step | Readout | Detents |
|---|---|---|---|---|---|
| Strength | `glow.strength` | 0 … 0.5 | 0.005 | `None` / `0.06 — 1/8` / `0.11 — 1/4` / `0.19 — 1/2` / `0.30 — strong` | 0, 0.06, 0.11, 0.19 |
| Halo scale | `glow.sigma1Um` | 4 … 200 | 1 | `24 µm` | 24 |
| Veil breadth | `glow.broad` | 0 … 1 | 0.01 | `60%` | 0.6 |

`glow.sigmaRatio` (2 … 32, default 8) exists in the recipe with no control. Leave it that way
unless there is a reason not to.

Strength hint: "Taking-lens diffusion: a two-term veil of scattered light, convolved with the
scene before the film is exposed. Because it is pre-exposure the film's shoulder compresses it —
highlights bloom and the shadows next to them lift, the restrained look of a Pro-Mist, not a
screen blend."

#### Section — Viewing

| Control | Field | Range | Step | Readout | Detents |
|---|---|---|---|---|---|
| Surround | `output.surroundExponent` | 0.8 … 1.2 | 0.01 | `1.00 — room light` / `0.90 — dark` / `1.10 — bright` | 0.9, 1 |
| Grain seed | `seed` | 1 … 64 | 1 | `#7` | — |

Hints: Surround — "A print judged in a dark surround needs less contrast than the same print in
room light. 0.90 is the projection condition." Grain seed — "A different piece of film from the
same box."

---

## 6. What is *not* in the interface

Recording these so a new UI does not helpfully add them back:

- No named "looks", "filters", "film simulations" or presets beyond the grain and halation presets
  above. The stock list is the preset system.
- No abstract, unitless sliders. Every control is labelled in the quantity the model uses.
- No auto-anything applied silently — the grey anchor is offered as a link, never applied.
- No undo/redo, no history, no snapshot/compare-versions.
- No batch processing, no queue, no multi-image state.
- No sharing, upload, cloud, or account surface of any kind.
- No light theme. The interface commits to dark (§11).

---

## 7. The D–log E plot

The instrument's face, and a required element. It sits at the top of the rail, above the notices
and the control panel, and is sticky on wide layouts.

- **Axes.** x = log₁₀ E at the film plane, −5.2 … 1.2, integer ticks with a caption. y = density,
  0 … an auto ceiling of `max(dMin + ΔD) + 0.2` rounded up to the nearest 0.5, ticks every 0.5.
- **Curves.** Three characteristic curves in the record colours (red `--record-r`, green
  `--record-g`, blue `--record-b`), sampled at 181 points from `resolved.curve`. For a monochrome
  stock, one curve in the ink colour.
- **Histogram.** A filled area behind the curves showing where this photograph's tones actually
  land, shifted by `anchorShift` so it sits in film-log-exposure space. 160 bins over log-luminance
  −5 … 3, scaled to 42% of the plot height. The histogram arrives **already developed** (camera
  grade and exposure gain applied), so what it shows is the light the film is about to see.
- **18% grey marker** — a vertical line at `anchorShift + log10(developLuma(0.18 × exposureGain, camera))`.
  The anchor everything hangs on. Legend key in the caption row.
- **Speed point marker** — a vertical line at Dmin + 0.10, the shadow threshold that defines ISO.
  Legend key in the caption row.
- Everything is clipped to the plot frame.

**Why it matters, and what a new UI must preserve:** push development steepens the curves under a
stationary picture; changing exposure slides the picture beneath stationary curves. That
distinction is the entire difference between the two controls and it is much easier to see than to
explain. The plot must be drawn from `ResolvedParameters` — the same numbers the shader is
running — and must remain visible while the relevant controls are being moved.

---

## 8. The export bench

Opened by **Export print**. A modal dialog (`role="dialog"`, `aria-modal`, focus moved in on open,
focus restored on close, `Escape` closes, backdrop click closes, inner click does not).

It is a **bench, not a pipeline**: the print is re-rendered and re-encoded *while the settings are
being chosen*, so the save button acts on a file that already exists.

### Header
Title `Export print`, and the live output dimensions `4096 × 2731 px` (or `—` while rendering).

### Controls

**Format** — Choice, populated by **probing the running browser's own encoder**. Each candidate
type is test-encoded and the result's MIME checked, because `toBlob` silently substitutes PNG for
types it cannot encode. Nothing is listed that this browser does not genuinely produce.

| id | Label | Note | Lossy | Ext |
|---|---|---|---|---|
| `png` | PNG | Lossless · every pixel exactly as rendered | no | `png` |
| `jpeg` | JPEG | Lossy · smallest widely-compatible file | yes | `jpg` |
| `webp` | WebP | Lossy · smaller than JPEG at like quality | yes | `webp` |
| `avif` | AVIF | Lossy · smallest file, slowest to encode | yes | `avif` |

While probing: "Detecting what this browser can encode…". Hint: "Offered only where this browser's
own encoder produces it — a type it silently substitutes is not listed."

**Quality** — shown only for lossy formats. 1 … 100, step 1, detents at 60/80/90/100, default 90.
Readout is `90 · 4.2 MB` — a **measured** size, produced by re-encoding the print when the slider
settles (200 ms debounce), showing `90 · measuring…` in between. Nothing here is labelled
high/medium/low, because "quality 78" is not a quantity and a byte count is.

**Long edge** — a radiogroup of detents: 2048, 4096, 8192 and `Source · <n>`. A detent is offered
only if it **genuinely downscales** (smaller than the source's long edge) and fits inside the GL
context's own `MAX_TEXTURE_SIZE`. `Source` is always present. Each button's tooltip gives the exact
pixel dimensions. Default 4096, falling back to `Source` if the stored detent isn't on offer for
this image.

Standing note: "Grain, halation and interlayer are physical sizes in micrometres, so the export is
rendered again at this width's own pixel pitch rather than scaled — a finer one carries finer
stages than the preview showed."

**Filename** — shown live, monospace: `<source name> — <negative> on <print>.<ext>`.

### Pipeline and button states

1. **Render** (250 ms debounce after open or a resolution change): re-resolve at the export's pixel
   pitch, bind the print LUT if the measured engine is active, render at the target width into a
   hidden canvas, then repaint the live preview.
2. **Encode** (200 ms debounce after a render lands or format/quality changes): canvas → blob. No
   GL work.

The save buttons stay armed on the previous blob while a replacement is produced — **except across
a resolution change**, where the old blob is a different size and is withdrawn until the new one
exists. Save is disabled while `!blob || rendering`, labelled `Preparing…`.

Any render or encode failure is shown inside the dialog (never behind the backdrop).

### Actions

- **Cancel** — closes.
- On a **coarse pointer** that can share files: **Download** (secondary) and **Save to Photos**
  (primary, large). Save to Photos calls `navigator.share` with the file **already encoded** —
  iOS requires the call to be synchronous with the tap, so no awaited work may sit between the
  gesture and the share. A dismissed sheet is the user changing their mind, not a failure; both
  `shared` and `cancelled` close the dialog.
- Everywhere else: a single primary **Download · 4.2 MB**.

### Persistence
Format, quality and long edge persist under `emulsion.export.v1`, independently of the recipe.

---

## 9. Errors, warnings and provenance

### 9.1 Fatal
If the renderer cannot be constructed (no WebGL2, no float colour buffer), the entire app is
replaced by a panel: heading "EMULSION cannot start" and the error message. No other chrome.

### 9.2 Decode errors
Shown in the drop zone (empty state, `role="alert"`) or in the notices strip (loaded state).
Messages are written for a person: *"The browser could not decode IMG_0042.heic as an image."*

### 9.3 Notices strip
Between the plot and the control panel, present only when it has content. Three sources, in order:

1. The decode error, if any — warn tone.
2. `resolved.warnings[]` — warn tone. Currently two can occur:
   - "Development has driven the **red** record past the well-formedness bound — the straight line
     has closed up."
   - "Aim balance did not converge for *Portra 400-type* on *2383-type*; the print is unbalanced."
3. `source.caveat`, if any — neutral tone. For display-referred files: *"This file is
   display-referred: a tone curve, white balance and gamut mapping were baked in before EMULSION
   saw it. The chain runs on what survived. A RAW file gives the negative something closer to what
   a negative actually receives."*

Notices are informational. Nothing in this app blocks on a warning.

---

## 10. Performance and rendering contract

| Rule | Why |
|---|---|
| One render per animation frame, however fast a slider moves. Pending frames are cancelled and replaced. | A slider drag fires far faster than the GPU can draw. |
| Preview renders at a maximum width of **2048 px**. | The preview is not the export. |
| The render must be driven by a `useEffect` on `[resolved, mode, split, clipWarning, source]`, not by control callbacks. | Any state path that reaches the recipe repaints, without each control knowing it must. |
| The measured print LUT loads **asynchronously**. Until it arrives, the calculated model renders; when it lands, a version counter bump re-resolves and the LUT takes over mid-session with no reload and no flicker. | Loading is not a modal event. |
| The LUT must be bound to its texture unit **before** the render that reads it — in the live loop and the export path alike. | Sequencing bug otherwise. |
| Zoom is a CSS transform. It never changes render resolution. | Zoom must stay free. |
| The export renders again at its own pixel pitch; it never upscales and never merely resizes. | Grain, halation and interlayer are physical micrometre sizes. |

---

## 11. The present visual language

Recorded as the current state, not as a constraint on a new design — except where noted.

**The premise.** A safelight room. Near-black warm ground, one amber accent, and the photograph as
the only bright object on screen. All chrome is held below the image in value, because you cannot
judge a print next to a white panel.

**Committed to dark.** `index.html` sets `data-theme="dark"` and `color-scheme: dark`; there is no
light theme and no system-theme following. *A darkroom that follows the system theme into daylight
is not a darkroom.* If a new UI introduces a light mode, it should still offer this dark condition
as the working default.

**Tokens** (`src/styles/tokens.css`):

- Ground ascending: `#0a0908` → `#100e0d` → `#161412` → `#1d1a17`; sunken `#070606`. Warm-biased
  greys, because a neutral grey next to a warm print reads blue.
- Hairlines, two weights only: `rgba(232,227,220,.09)` and `.16`.
- Ink `#e8e3dc`, muted `#948a7e`, faint `#635c53`.
- Accent (the safelight) `#e08a3c` — used for state, never decoration.
- The three records at their own hues, used consistently everywhere a record appears (plot,
  printer lights, readouts): `--record-r #d8574a`, `--record-g #5aa86b`, `--record-b #4d84cf`.
- Warn `#d4553c`.
- 4 px spacing base; radius 3 px / 5 px; 140 ms ease, zeroed under `prefers-reduced-motion`.
- Body 13 px. Section titles are 10 px, uppercase, 0.08 em tracking. All numerals are monospace
  with tabular figures.
- Rail width 336 px; header 52 px plus `env(safe-area-inset-top)`.

**Responsive behaviour** (current):

- **≥ 900 px** — two columns: viewport + 336 px rail.
- **< 900 px** — one column: viewport sticky at 44 vh (44 svh where supported) over a scrolling
  rail. Brand subtitle hides.
- **Landscape, ≤ 520 px tall** — back to two columns with a `clamp(230px, 34vw, 330px)` rail, so a
  phone on its side keeps the picture wide.
- **< 560 px** — viewport bar wraps, the inspect segmented control becomes a scrollable flex row,
  the film readout drops to two columns, the drop zone stacks.
- **Coarse pointer** — larger hit targets throughout (buttons, chips, segments, selects, slider
  thumbs), and the export dialog goes full-bleed with a large primary action.

---

## 12. Build, test and verify

```bash
npm install
npm run dev        # http://localhost:5173
npm run typecheck  # strict TypeScript, no emit
npm test           # 221 assertions across 11 files, against the design document's published values
npm run build      # production bundle in dist/
```

Headless render verification — this is what catches a GLSL compile failure, which TypeScript
cannot see (a broken shader builds perfectly and throws at runtime):

```bash
npm run build && npm run preview &   # serve on :4173
node scripts/verify.mjs              # loads it in Chromium, fails on any console/page error
node scripts/compare-engines.mjs     # renders both print engines, reports the delta
```

`node scripts/make-test-chart.mjs` regenerates `public/test-chart.png` — a step wedge, memory
colours, saturated primaries and speculars several stops past white — which is what the
verification pass feeds the app.

**A new UI must keep `scripts/verify.mjs` passing.** It asserts a clean console, no page errors and
no failed requests on a real load of the built app.

---

## 13. Handover checklist for the new UI

- [ ] The GL canvas mounts once and never unmounts, including behind the export modal.
- [ ] All recipe writes go through the single `update(draft => …)` + `clampRecipe` path.
- [ ] Every control in §5 exists, with the exact field, range, step, unit, readout format, detents
      and disable rule listed.
- [ ] The stock-selection side effects (chemistry, print, EI reset) are preserved.
- [ ] The preset-clearing behaviour on grain and halation sliders is preserved.
- [ ] The `bypass` and `engine === 'lut'` disable rules on the print section are preserved.
- [ ] The D–log E plot is present, live, and drawn from `ResolvedParameters`.
- [ ] The grey anchor is offered as a link and never applied automatically.
- [ ] Notices surface `resolved.warnings`, decode errors and `source.caveat`.
- [ ] Drop-anywhere, paste and file-picker all load a file.
- [ ] Picture zoom (pinch, ctrl+wheel, double-tap, drag-pan, badge reset) works and the page never
      takes the pinch itself.
- [ ] The export bench probes formats, measures file size, offers only downscaling detents, and
      calls `navigator.share` synchronously with the tap.
- [ ] `emulsion.recipe.v1` and `emulsion.export.v1` persistence still works, including the
      degradation paths for old recipes.
- [ ] `npm run typecheck`, `npm test` and `node scripts/verify.mjs` all pass.

---

## 14. Reference

| Document | What it holds |
|---|---|
| `../main.tex` → `../main.pdf` | The 60-page design specification: closed-form models for every stage, render architecture, persistence schema, verification methodology. |
| `DEVIATIONS.md` | Thirteen recorded findings where implementing the paper revealed the paper — an ISO shift equation whose sign contradicts its own explanation, an x₀ column that leaves HP5 19% fast, interlayer diffusion lengths below the pixel at every render size, the Cineon anchor the LUT engine needed, and the Color-Finale-style bench. Nothing was resolved by loosening a tolerance. |
| `public/luts/SOURCES.md` | Provenance and licence position for every bundled measured print LUT. |
| `README.md` | The user-facing overview. |
