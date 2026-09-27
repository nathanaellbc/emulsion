# Where implementing the paper revealed the paper

The design document is the artifact of record, and implementation is the first
real test of it. Every place where the two disagreed is here, with what was
done and why. Nothing on this list was resolved by loosening a tolerance.

Section and equation references point into `main.pdf` at the repository root.

---

## 1. The ISO shift equation contradicts its own explanation

**§V, eq. isoshift.** As printed:

> log E_film = log₁₀(E_anchored) + log₁₀(S/S₀) + x_ref

The sentence immediately beneath it says the equation is what makes "shooting
Portra 400 at 800" meaningful, because *"it shifts log E_film by −0.301"*. With
S = 800 and S₀ = 400 the printed equation gives **+0.301**, not −0.301.

The prose is right. Rating a film at a higher exposure index means giving it
less light, so the term must be negative. There is also no term in the printed
equation placing an 18% neutral anywhere in particular relative to the speed
point — with E_anchored = 0.18 it lands 1.84 log units *below* the speed point,
which is deep in the toe and cannot be what was meant.

**Implemented** (`core/resolve.ts`, `anchorShift`) as

    log E_film = log₁₀(E) − log₁₀(0.18) + x_sp + log₁₀(12.5) − log₁₀(EI/S)

where log₁₀(12.5) = 1.0969 is the ISO relation between the metered middle-grey
exposure (10/S) and the speed-point exposure (0.8/S). This puts a correctly
exposed neutral 1.10 log above the speed point, which for the Portra 400-type
profile lands it at a green density of 1.62 over a Dmin of 0.92 — a net 0.70,
inside the 0.65–0.75 a real mid-grey reaches on that stock.

The anchor deliberately uses the *nominal* stock speed rather than the developed
one. Development changes where the curve sits; it cannot change how much light
reached the film.

---

## 2. Appendix A's x₀ column is not the speed point it claims to be

**Appendix A vs §VI, eq. speedpoint.** Appendix A states that every x₀ is
derived from the rated ISO through S = 0.8/10^x_sp. §VI defines the speed point
as

    x_sp = x₀ + (κt/γ) · ln(e^(0.10/κt) − 1)

The second term is not zero and depends on κt. The published column behaves as
though x_sp were x₀ itself: four ISO-400 stocks all carry x₀ = −2.71 despite
carrying κt of 0.140, 0.145, 0.160 and 0.170, which puts their actual speed
points as much as 0.076 log apart.

Derived speeds from the printed column:

| Profile | Rated | From the printed x₀ | Error |
|---|---|---|---|
| `neg.portra400` | 400 | 401.6 | +0.4% |
| `neg.superia400` | 400 | 411.8 | +2.9% |
| `neg.ektar100` | 100 | 96.2 | −3.8% |
| `neg.gold200` | 200 | 211.3 | +5.7% |
| `neg.portra160` | 160 | 173.5 | +8.5% |
| `rev.provia100` | 100 | 107.5 | +7.5% |
| `rev.velvia50` | 50 | 54.4 | +8.9% |
| `mono.trix400` | 400 | 446.2 | +11.6% |
| `mono.hp5` | 400 | 476.6 | +19.2% |
| `neg.v3_500t` | 500 | 597.2 | +19.4% |

**Implemented:** x₀ is recomputed at load from the appendix's *stated
derivation* rather than its printed column
(`core/profiles/negatives.ts`, `speedCorrectedX0`). The published value is kept
on the profile as `publishedX0` so the correction stays auditable, and a test
asserts the move is under a third of a stop for every stock — a larger move
would mean the correction had started changing the fitted shape rather than
just repositioning it.

Shipping the printed column would have meant a stock that renders but is not the
stock named on it, which is the specific failure §I-C's "defaults are
measurements" claim exists to prevent. Every exposure calculation, every EI
rating, and the meaning of "push one stop" depends on this being right.

---

## 3. The contrast index band excludes a third of the shipping stocks

**§VI vs Appendix A.** §VI gives 0.55–0.62 as the contrast index of a
normal-process colour negative. Appendix A's own table does not satisfy it:

| Profile | CI | In band? |
|---|---|---|
| `neg.portra160` | 0.522 | below |
| `neg.portra400` | 0.583 | yes |
| `neg.gold200` | 0.625 | above |
| `neg.ektar100` | 0.681 | above |
| `neg.superia400` | 0.599 | yes |
| `neg.v3_500t` | 0.483 | below |

**Not corrected.** γ is the primary fitted quantity and these differences are
the stocks' character — Ektar's whole identity is a gamma of 0.72, and Vision3's
is 0.55. The band describes a typical stock; the table deliberately spans wider
than typical. Treating the band as a constraint would have meant flattening six
distinct stocks toward each other.

The suite asserts a sanity range instead, plus an exact per-stock lock, so a
change to the curve maths cannot drift a stock's character without a failing
test naming that stock.

---

## 4. A neutral does not reproduce as R = G = B, by design

**Design spec §7.2 (V-08) vs Appendix A.** The spec requires that "an 18% scene
neutral produces R = G = B within 1e-3 after aim balancing" for all forty stock
pairs. Appendix A sets the aim density to (1.09, 1.06, 1.03) for all four print
stocks and explains the gradient: it is the standard allowance for projector
lamp colour temperature, and is "what makes the neutral axis of a printed frame
lean very slightly warm".

A 0.03 density difference between records cannot come out as equal RGB. The two
statements cannot both hold, and the appendix is the one giving a physical
reason.

**Implemented** per the appendix. The suite asserts what eq. aimbalance actually
claims — that a neutral reproduces at the aim *density*, to 1e-3, across all
forty pairs — and separately asserts that the residual is exactly the offset the
aim gradient predicts, so it stays a stated choice rather than an accident.

---

## 5. The saturation-density equation is under-defined; its prose is not

**§X, eq. satdensity.** As printed:

    C(ς) = I + ς(C − I) + (1 − ς) ϖ J

where "J is the matrix of ones scaled to preserve neutrals". No value of ϖ is
given, and a matrix of ones cannot preserve neutrals under this composition —
C's own rows do not sum to one, so neither term is neutral-preserving to begin
with.

The paragraph introducing the equation says plainly what the control does:
"saturation is controlled by scaling the off-diagonal terms of the printing
density matrix C". The Swift API in Appendix D carries a
`scalingOffDiagonal(by:)` helper on `Matrix3x3` and nothing else that would
serve this equation.

**Implemented** as the prose and the API agree: `scaleOffDiagonal(C, ς)`
(`core/print.ts`, `crosstalkMatrix`).

---

## 6. The remjet-removed variant (since removed)

**Appendix A.** The halation table lists eleven negatives; the curve table lists
ten. `neg.v3_500t.xr` has halation parameters (α_h 0.55, ℓ_R 118 µm, ω 0.22) but
no curve row, because it differs from `neg.v3_500t` in halation alone.

The design spec deferred it on the grounds that halation is not evaluated in
Core, so the variant would have been byte-identical there. **Halation is
evaluated here**, so for a time it shipped as `neg.v3_500t_xr`, sharing the base
stock's curve. It was later removed from the bundle: the strong halation is
reachable on any stock through the halation intensity control, so the variant
carried no physics the base stock plus a slider does not. The parameters are
recorded here should a dedicated antihalation-backing model return.

---

## 7. The interlayer diffusion lengths are below the pixel, at every size this app renders

**§VIII, eq. twoscale.** The two-scale kernel is specified in micrometres at the
film plane — σ₁ ≈ 1.2 µm within the layer, σ₂ ≈ 6 µm through the interlayer —
and §VIII-D is explicit that this is so "the effect has a fixed physical size
regardless of output resolution".

A 35 mm frame is 36 mm wide. Rendered 2048 px across, one pixel is 17.6 µm, so
σ₂ is a third of a pixel and σ₁ is a fifteenth of one. The stage is therefore
almost entirely below the resolution it is being asked to render at. Measured on
a 0.6-density step edge, the rim the operator produces is:

| render width | pixel pitch | σ₁, σ₂ (px)  | rim (density) |
|--------------|-------------|--------------|---------------|
| 1024         | 35.2 µm     | 0.03, 0.17   | 0.00000       |
| 2048 preview | 17.6 µm     | 0.07, 0.34   | 0.0024        |
| 4096 export  |  8.8 µm     | 0.14, 0.68   | 0.0375        |
| 8192         |  4.4 µm     | 0.27, 1.37   | 0.0643        |
| 16384        |  2.2 µm     | 0.55, 2.73   | 0.1230        |

Grain, for scale, is σ ≈ 0.004 density. So the effect is invisible in the
preview and plainly visible in the export — a sixteen-fold step across an
operation the user cannot see happening.

**What was done: nothing.** The conversion stays physical and the stage is not
floored into visibility. Two reasons. Flooring the kernel at, say, half a pixel
would make the effect's size a function of the render resolution, which is the
one thing §VIII-D forbids; and scaling its strength by the fraction the pixel
grid can carry would be a magnitude model the paper does not publish, which is
exactly the class of unbacked tuning §8 below exists to keep out. The stage
switches off entirely below σ₂ = 0.25 px, where it produces nothing but costs
three passes.

The precedent is grain, which has the same property and is treated the same way:
its Selwyn σ is scaled by the render's own pixel aperture, so a preview and an
export legitimately differ. This is larger in degree.

Two things would resolve it, neither of which is this project's to decide: the
paper could publish a resolvable-fraction attenuation, making the preview honest
about what the export will do; or the preview could simply render finer, since
the effect is fully present by 8192 px. Recorded here rather than papered over.

---

## 8. Values the paper does not publish

Recorded so they are not mistaken for measurements.

- **Print stock x₀′.** Appendix A publishes no x₀′ column, correctly: the
  printer light is what positions the negative on the print curve, so x₀′ is
  fixed at zero and the aim balance absorbs it.
- **Monochrome reference time and temperature.** Appendix A gives t₀ and T₀ for
  C-41, E-6 and ECN-2 and nothing for the B&W family. 480 s at 20 °C — the
  conventional D-76 1:1 baseline — is used, as an engineering default.
- **Print primaries → Display P3.** §IX ends with "the resulting linear Y is
  converted from the print stock's primaries to Display P3", but no such matrix
  appears anywhere in the document. The print output is treated as already being
  in the display primaries. This is the largest unbacked assumption in the
  colour path.
- **Halation ring radius.** §XII gives base thickness t_b = 125 µm and says it
  drives r_min, without giving r_min. Derived as r = 2 t_b tan θ_c with θ_c the
  critical angle for n = 1.5, giving 224 µm at the film plane
  (`gl/halationFit.ts`).
- **Grain shape exponents.** §XI states σ_D² ∝ p^ν₁(1−p)^ν₂ in prose without a
  normalisation. Normalised here so the peak equals one, which is what keeps
  ν = (1, 1) identical to the un-generalised eq. grainvar.
- **The interlayer two-scale split.** §VIII gives σ₁, σ₂ and the constraint
  w₁ + w₂ = 1, and no values. w₂ = 0.35 at the recommended agitation, so the
  short scale carries the acutance and the long one the broad-area effect in
  roughly the ratio the prose describes.
- **The agitation coupling.** §VIII says agitation "inversely modulates σ₂ and
  w₂" without a law. Both are scaled by agitation^(−1/2), which at the ends of
  the slider's range (0.2× to 2×) reaches 2.2× and 0.71×.
- **The monochrome inhibition scalar.** §VIII says a monochrome stock has a
  scalar and no cross terms, and gives no number. 0.43, the mean of the
  published colour-negative diagonal.
- **The ideal negative's grain, halation and interlayer.** `neg.ideal` is a
  record no film makes, so its emulsion parameters describe no film either:
  Selwyn 0.004, σ₁ 1.0 µm, halation α 0.15 at 90 µm, the standard DIR matrix —
  a generic modern colour negative. They are live rather than switched off,
  which was a deliberate call: the alternative was disabling four sections and
  making the option a diagnostic instead of something you can work with. It is
  marked `fitStatus: 'E'` and its dropdown entry says so. These are the only
  stock parameters in the bundle that are not attached to a real emulsion.
- **Per-stock inhibition signatures.** Appendix A has no interlayer column.
  §VIII publishes one representative colour-negative matrix and two family
  rules — monochrome is scalar, reversal is scaled by 0.4 — so what ships is
  three family defaults rather than eleven invented signatures. This is the one
  place where a stock's identity does not reach a stage that it physically
  ought to: a Vision3 and a Gold 200 have measurably different DIR chemistry.

---

## 9. Deliberate departures from the design spec's architecture

Not errors in the paper — decisions this project made differently, and why.

- **The imaging chain exists twice.** `core/chain.ts` and
  `gl/shaders/chain.ts` implement the same nine stages. The spec's whole
  argument for a single `PointwiseChain.evaluate` is that bake and direct
  evaluation must not drift, and duplicating it takes that risk on knowingly:
  the GPU path is what renders, and the host path is what can be tested against
  Table VIII, the ISO round trip and the forty-pair aim balance. A fragment
  shader cannot assert any of those about itself. Divergence between the two
  files is a defect in one of them, never a tolerance to widen.
- **Most of the optical simulation, and aging, are not implemented.** §XIII
  and §XIV. Taking-lens diffusion (§XIII, eq. diffusion) is — it is the Glow
  stage, pre-exposure, in `gl/shaders/passes.ts` FRAG_GLOW. Vignetting,
  chromatic aberration, distortion and aging are not, and their parameters are
  not carried either, rather than carried unused.
- **Interlayer inhibition is implemented on the GPU only.** §VIII. `core/` gets
  a host replica of the operator — a separable Gaussian, the two-scale residual,
  the coupling matrix and the activity weight over a small field — because the
  properties worth asserting about a spatial stage are properties of a field
  (mean preservation, edge polarity, cross-record transfer) and a fragment
  shader cannot assert any of them about itself. `core/chain.ts`, which is
  pointwise, does not call it: the host chain remains the pointwise chain.
- **Halation and grain are implemented**, unlike the Core spec which excluded
  both as non-pointwise. They are the two most recognisable film cues and this
  project renders rather than baking a LUT, so there is no reason to exclude
  them.
- **The exponential halation PSF is fitted, not tuned.** §XII specifies a
  pyramid with weights w_j and does not give them. They are solved per channel
  by non-negative least squares against the stock's own PSF under the 2πr radial
  measure (`gl/halationFit.ts`), so the red halo is wider than the blue one
  because the transport says so.

---

## 10. The exposure anchor used the negative's speed criterion for a reversal stock

**§V / §VI vs ISO 2240.** The anchor placed mid-grey `log10(12.5)` *above* the
speed point for every stock, and the speed point is where the curve reaches
Dmin + 0.10. That is the ISO 5800 criterion, correct for a colour *negative* —
where Dmin + 0.10 is the shadow. But a *reversal* stock has gamma < 0, so the
toe of its characteristic curve is the **white** end, and Dmin + 0.10 is a
highlight. Anchoring mid-grey above it drove 18% grey to Dmin — pure white,
more than five stops over. Measured: Velvia 50 and Provia 100F both rendered a
neutral grey card at 1.000.

ISO 2240 anchors colour reversal film to the highlight, not the toe. **Fixed**
(`core/resolve.ts`): for gamma < 0 the anchor references mid-grey *down* from
the speed point by the same `log10(12.5)` interval, which lands it on the
straight line. Locked by a test that a reversal stock must not render 18% grey
above 0.8.

---

## 11. The tungsten layer balance carried a DC term and crushed the red record

**§V, eq. tungsten.** The layer balance shipped as `[-0.29, 0, +0.42]`, a
per-record log-exposure offset with a +0.043 mean. The equation describes a
*difference* of layer speeds between two illuminants, and a difference of
speeds has no DC term — it changes the cast, not the mid-tone density. The
non-zero mean shifted each record's overall exposure, and against the orange
mask it drove the red record off its toe: Vision3 500T in daylight rendered a
neutral grey as `[0.035, 0.110, 0.416]`, blue twelve times red — a blue
filter, not a cast.

The cast itself is correct and is kept: a tungsten-balanced stock in daylight
genuinely records blue over red. **Fixed**
(`core/profiles/negatives.ts`, `TUNGSTEN_BALANCE`): the shift is now mean-zero
and sized to the real daylight-on-tungsten relative layer speed (±0.14 log,
about 1.5 stops), so 18% grey stays put and the cast strengthens into the
highlights as the blue record climbs its straight line. Locked by a test that
the cast survives (blue exceeds red) while red stays alive (B/R < 4), and the
two pre-existing behavioural tests — the cast vanishes at 3200 K and
interpolates on mired — updated to the corrected magnitude.

---

## 12. The measured print LUTs needed an anchor the paper does not publish

The calculated print stage is one of two engines now; the other is the stock's
own measured response — the Kodak and Fujifilm Film Look LUTs, indexed on
Cineon log, the encoding of a scanned negative. The paper has no LUT engine
and publishes no anchor for one, so the anchor was derived, and it is recorded
here so it is not mistaken for the paper's.

The Cineon printing-density mapping carries five hundred code values per
density unit; the famous constants fall out of it (code 95 ≈ the dense end of
a normal negative, **445 = a correctly exposed 18% grey**, 685 = 90% white).
This model already knows where 18% grey lands on any stock — it is the neutral
density the aim balance is computed from — so the encode anchors that density
at code 445 exactly (`core/cineon.ts`, `core/engine.ts`). No tuning, one
derivation, and the tests hold every stock to it: the anchor round-trips, and
Dmin maps near the LUT's black while Dmax maps near its white on every
profile in the bundle.

Two consequences worth stating plainly:

- **The model's aim balance must not be applied in LUT mode.** The aim
  balance positions a neutral at the *model's* aim density; the measurement
  carries its own balance, baked into the table. Adding the model's aim would
  balance the print twice. In LUT mode the printer lights and print density
  fold into the negative as a density offset and nothing else moves it —
  which also means the lights act through the stock's *measured* cross-terms,
  so a red light moves the green record a little, where the model's lights,
  acting after its crosstalk matrix, move it not at all. The engine test
  asserts the measured behaviour and says why it differs.
- **A reversal stock prints inverted through both engines.** This is not a
  LUT-path defect: the model's print stage, taken literally, optically prints
  whatever is in the gate, and a reversal positive printed onto a
  negative print stock produces an inverted image — which is why labs made
  interpositives. The bypass scan is the only place a reversal reads as a
  positive, in both engines. Making reversal prints positive would be a new
  interpositive stage in the model, affecting both engines, and is not this
  change's to smuggle in.

The bundled files: 2383 D65 and 3513 D65 are the Kodak/Fujifilm Film Look
measurements (33³ each); 2393 is the Autodesk FPE measurement, which ships at
13³ — its interpolation error is measured along the loci the engine samples
(worst second-difference bound 0.030, against 0.018 for the 33³ Kodak table)
and the bound is asserted in the tests rather than assumed away. **Fujifilm
3521 has no measured LUT under a redistributable licence**, so it renders
through the model only, and the interface says so. Provenance for every file
is in `public/luts/SOURCES.md`; each file is validated at load and the engine
falls back to the model if a file is missing or fails validation.

---

## 13. The Color-Finale-style bench: three controls the paper does not publish

The interface gained a subtractive bench and a set of grain and halation
controls modelled on Color Finale's film-emulation panel. None of the
underlying laws are in the paper; what follows is each mapping and where the
engineering default sits, so none of it reads as a measurement.

- **Subtractive grading** is exact, not approximated: a dye-density offset
  *is* a transmittance multiply in linear light (cyan Δ density is
  red × 10^−Δ), so the CMY sliders and the density master act on the print
  output between stage 9 and the surround — after either engine's print,
  before the viewing condition. 'Suppress' adds neutral density; 'multiply'
  thins the dyes, and a dye scale of k is transmittance^k. Both are
  neutral-preserving, and equal CMY multiplies every record by one factor —
  the stock's own cast rides through untouched.
- **Grain response** reparameterises the grain's density dependence
  p → p^γ with γ = 2^(−2·response). Because the Selwyn shape function is
  normalised in its own argument, the peak moves along the tone scale while
  the amplitude stays exactly the datasheet's — a negative-scan look at −1,
  a positive-scan look at +1, the stock at 0.
- **Grain colour variation** interpolates the records' correlation
  ρ → 1 − mix·(1 − ρ_stock): 0 is one silver field in all three records, 1
  is the stock's own chroma grain. The Cholesky machinery already carried
  this; only the interpolation is new.
- **Halation dye transmission** collapses the recombined halo toward the
  base's amber — luminance × (1.0, 0.58, 0.24) in the working primaries —
  by the slider's fraction. The transport's per-channel split remains at 0.
  **Boost** is an ordinary saturation operation about the halo's own
  luminance. The amber vector is chosen for the base's stated absorption,
  not measured from a stock.
- **Defaults were retuned** to sit near Color Finale's visible-but-
  photographic look: dye transmission 0.55, boost 0.30, grain colour
  variation 35%, response 0. The stock profiles themselves are untouched.

The **print illuminant** selector (D55/D60/D65) exists only where
measurements exist: 2383 and 3513 ship in all three white points, 2393's FPE
measurement ships in one, and the calculated model has no print-illuminant
parameter at all — its projector allowance is baked into the aim. The
control greys out honestly in every place it has nothing real to switch.

---

## 14. The camera develop: a stage the paper not only fails to publish — it forbids it

**§V.** The document is unambiguous about the decode: a RAW is asked for
linear ACES with *every* rendering intent switched off, and §V spends a page
listing the conveniences — auto brightness, tone curves, noise reduction,
sharpening — that would destroy the model's correctness if the decoder applied
them. That is right for the *film model*, and it leaves nowhere for a
photographer to say what their sensor's develop *would have done* before the
film saw the light. The interface gained a Camera bench for exactly that, and
none of its mappings are in the paper — so, as with finding 13, each is
recorded here so none of it reads as a measurement.

**The controls, and what each actually does:**

- **Exposure** is the existing `capture.exposureCompensation` — one physical
  quantity, one control, relocated to the Camera page rather than duplicated.
  The Film page keeps only *Rated at* (EI), which is genuinely film-side:
  rating changes where the ISO anchor sits, and push development is the
  recovery. Two exposure sliders would have been precisely the kind of lie the
  interface refuses to tell.
- **Contrast** is a slope `k` on stops-over-grey in log₂, pivoting about the
  picture's own middle grey (finding 21; it pivoted on scene grey, 0.18, at
  first). The recipe stores the setting as a log2-slope in [−0.75,
  +0.75] so the slider's readout can show the multiplier the math uses
  (0.59×–1.68×).
- **Highlights / Shadows / Whites / Blacks** are additive stops at logistic
  masks centred +1.5 / −1.5 / +4 / −4 EV over that middle grey, widths 1.0 /
  1.0 / 1.0 / 1.0 stops (whites and blacks were 2.0; finding 21). The logistic is the house's own knee — the softplus derivative
  that builds every toe and shoulder elsewhere — so a mask "begins" as softly
  as a film curve does. The shadow-side masks are the mirrored form σ((c−t)/w);
  writing them the same way as the highlight side is the classic parametric
  curve-editor bug, and the first draft of this stage had it (caught by the
  monotonicity test, which is what the test is for).
- **Saturation** is `Y + s·(c − Y)` about AP1 luminance — the same
  luminance-preserving operator the halation boost uses, so the house has one
  saturation, not two. It is distinct from the print's *saturation density*
  (the crosstalk matrix, Film page), and both hints say so.
- **White balance and tint** moved to the Camera page unchanged — a UI
  relocation, not a model change.

**Properties the suite holds, since no published values exist to test
against:** identity at the defaults to 1e-9; monotonicity in luminance for
every control alone at its extreme *and* any pair at extremes (three or more
simultaneous extremes can invert the tone curve, as any parametric curve
editor can — documented here rather than clamped away); exact chromaticity
preservation under every tone control (they are a per-pixel scalar gain);
exact luminance preservation under saturation; mask locality; and the
bake/render parity that an exported LUT still matches the screen.

**Placement is the load-bearing decision.** The develop lives in the prepare
pass — after the input matrix and exposure gain, before the log — which
places it:

- *before the film*, so the characteristic curve, the layer balance and the
  interlayer inhibitor release all see the developed light;
- *before halation's threshold and the glow veil*, so a recovered highlight
  genuinely scatters less — the spatial stages track the grade for free,
  which is what "scene-referred" is for;
- *outside the LUT-bake domain*, exactly as the white balance is: the bake
  (`core/lut.ts`) applies the develop through the same `develop()` the host
  chain uses, so the exported file and the screen cannot drift. This is the
  same reasoning the prepare shader's header records for why nothing before
  the log is ever baked *into* the LUT's grid.

The one ordering worth naming: the develop is applied *before* the
panchromatic collapse for monochrome stocks — the sensor develops in colour,
and the film's silver sees luminance — which is what `core/chain.ts` does and
what the prepare shader does (the collapse happens downstream, in the
negative pass). `developIsIdentity` short-circuits the stage at the defaults,
so the 221 pre-existing tests are untouched: a default develop is the
no-intent decode §V demands, and the Camera bench is the explicit, visible
way to depart from it.

## 15. Translucent chrome contradicts the darkroom argument the tokens make

`styles/tokens.css` used to argue — correctly — that chrome must be opaque and
held below the photograph in value, because you cannot judge a print next to a
panel that is brighter than it or, worse, tinted by it. The interface is now
built from translucent glass: the rail, the top bar, the plot card, the export
bench and every pill let some of what is behind them through.

The risk is specific and is not aesthetic. A blurred surface samples the pixels
behind it. Put that surface beside the photograph and it picks up the
photograph's cast, so the neutral you are judging the print against is no
longer neutral — the panel drifts toward whatever the print is doing, and every
correction you make against it is made against a moving reference.

Two things hold the line:

- **Every blurred surface desaturates what passes through it.** `--blur` is
  `blur(24px) saturate(0.55)`, not `blur(24px)`. Chrome can therefore take on
  the *value* of what is behind it — which is harmless, and is what makes glass
  read as glass — but never its *hue*. The reference this was drawn from gets
  away with full-saturation glass because its glass floats over a decorative
  backdrop; here it floats over a working image, so the saturation clamp is
  load-bearing rather than stylistic.
- **The rail never overlaps the frame.** The stage is a two-column grid, so the
  rail samples the ground and its own ambient wash, never the print. Only the
  export bench and the busy pill are ever over the picture, and both are modal
  or momentary — you are not colour-judging beneath them.

What was genuinely given up: the ambient wash (`.shell::before`) puts a warm
low-left and a cold high-right gradient behind the whole interface at 7–13%
opacity. It is decoration, it is the one thing here that the old tokens file
would have rejected outright, and it is the reason the palette reads as moody
rather than as an amber instrument. It sits behind the chrome and stops at the
frame, so it tints no pixel of the photograph — but it does mean the greys
immediately around the frame are no longer strictly neutral.

Two smaller consequences of the same change:

- **Amber stopped being a fill.** Active state is now carried by raised glass —
  a lighter surface with a lit top edge — rather than by an accent-coloured
  button. The accent survives as light (the ambient wash, focus rings, live
  numerals) and colour survives as identity (the three record hues, the printer
  lights, the stock-family swatch). This is what keeps a dark interface from
  reading as a row of amber lozenges, and it is the reference's own rule.
- **Section headings no longer pin.** `.panel-section__head` was sticky inside
  the scrolling rail. Sections are now cards with air between them, and a
  heading that detaches from its card and floats over the next one reads as a
  bug. The headings scroll with their sections; the bench tabs and the plot
  still pin, which is what the pinning was actually for.

## 16. Two signs in the paper that do the opposite of what their prose says

**§XII, eq. haladd — halation removes light from every pixel.** As printed:

> E'_c = (1 − α_h β_c) E_c + α_h β_c (h_ℓc * S)

The paper says this "preserves total energy exactly when S = E_c". But S is
not E: it is the source term of eq. halsource, the soft-kneed part of the
scene *above the halation threshold*. With S ≠ E the attenuation term takes a
fraction α_h β_c of every pixel's light and the recombination returns only the
thresholded part. On a typical colour stock (α = 0.15, β = [1, 0.42, 0.22]) a
mid-grey far below any threshold loses 15 % of its red exposure; through the
print that is a 28 % drop in the displayed red of a neutral — a cyan cast the
aim balance cannot see, because the host chain it is computed on has no
halation. The control became the colour-balance slider the paragraph after the
equation warns about for exposure.

**Implemented** (`core/halation.ts`, and FRAG_HAL_COMBINE, which mirrors it)
as removing only what scatters:

    E'_c = E_c (1 − α_h β_c f) + α_h β_c · halo_c,   f = clamp(S / Y, 0, 1)

where Y is the pixel's luminance. f is the fraction of the pixel's own light
that is above threshold and therefore scatters; it is applied to all three
records so the pixel keeps its chromaticity. Below threshold f → 0 and the
pixel is untouched; where S = Y (no threshold) this is the paper's form
exactly, so the energy argument the paper makes still holds, now for the S it
actually uses.

**§X, eq. neutralaxis — "warm" cools the shadows.** As printed:

> D'_R += δ_RG ψ(D'),   D'_B += δ_BG ψ(D')

with ψ positive in the shadows, and the sentence beneath: "positive δ_RG warms
shadows and cools highlights". D' is dye density; more density in the red
record is more *cyan* dye and less red light. Positive δ_RG therefore adds cyan
to the shadows and takes it out of the highlights — the opposite of the prose.
The implementation also used to put the "tint" control on the blue record
alone, so neither slider did what its label said.

**Implemented** (`core/resolve.ts`, `neutralAxis`) as the tilt the prose
describes: warm w gives δ = (−w, 0, +w) — red density out and blue density in
where ψ > 0, so shadows warm and highlights cool together; tint t gives
δ_G = −t, following the white balance's convention that positive is green.
The operator is still an axis tilt, so it still cannot produce a non-monotone
neutral. Recipes saved before this change render their warm/tint settings
with the corrected sign.

## 17. The format table's frame sizes, and which edge they belong to

**§XI, eq. formatscale** lists W_mm as 102 mm for 4×5 and 10.3 mm for 8 mm,
and divides by the render *width*.

- 102 mm is the short, four-inch side of a 4×5 sheet; its image long edge is
  about 121 mm. Every other entry in the table (36 mm for 135, 56 mm for 6×6,
  24.9 mm for Super 35) is the long edge.
- 10.3 mm is not an 8 mm frame. Standard 8 exposes about 4.9 × 3.7 mm; at
  10.3 mm the grain was scaled against a frame twice the real width, i.e. half
  as coarse as it should be. The Standard 8 preset now uses 4.9 mm.
- Dividing by the width assumes a landscape image. A portrait photograph is the
  same frame turned on its side, so dividing its short edge into 36 mm made its
  pixel pitch 1.5× too coarse, and grain amplitude, halation reach, glow and
  interlayer all changed with the camera's orientation.

**Implemented** (`core/recipe.ts`, `core/resolve.ts`) as W_mm the frame's long
edge, mapped onto the image's long edge: the pitch is
W_mm / max(width, height).

## 18. The GPU and host paths had drifted in three places

The contract of finding 9 is that divergence between `core/` and the shaders
is a defect. Three were found and fixed; none was a tolerance.

- **The print LUT was sampled half a texel off.** Node k of an N-node 3D
  texture sits at (k + 0.5)/N, and the shader sampled at the raw code value,
  which `core/cube.ts` maps to k/(N − 1). For 2393's 13-node table that is up
  to ~40 Cineon codes (~0.08 D). The shader now remaps the coordinate, and
  honours the table's declared domain as the host does.
- **The Gaussian was cut at eight taps.** Any kernel wider than σ ≈ 2.7 px was
  truncated; the glow's broad veil (σ ≈ 11 px at a 2048 preview, ~22 px at a
  4096 export) was cut at 1.5σ on screen and 0.7σ in the export, so the export
  rendered a different veil. The blur now uses the host's 3σ support, spread
  at a stride of at most σ/16 beyond 48 taps.
- **A missing table rendered paper white.** Under the measured engine the aim
  balance is deliberately left out of the print offset (finding 12); when the
  table had not arrived — still loading, offline, or never measured under the
  recipe's illuminant (2393 exists only at D65) — the render fell back to the
  model *without* the balance, and a normally exposed grey printed as white.
  The model's balanced offset is now always resolved and used for the
  fallback, and the illuminant falls back to one the stock was measured under.


## 19. The input matrix of eq. minval is not a P3-to-ACEScg matrix

**§V, eq. minval** gives M_in, "decoded Display P3 linear to ACEScg", as

    0.9525  0.0343  0.0132
    0.0170  0.9754  0.0076
   −0.0018  0.0107  0.9911

— within a few percent of the identity. Display P3 and AP1 have primaries
far enough apart that no such matrix relates them: built from the published
primaries and white points with the Bradford adaptation D65 → D60, the first
row is (0.7358, 0.2122, 0.0520). The printed matrix treated a P3 red as an AP1
red. Because M_out is defined as its inverse, a display-referred source made
the round trip and looked plausible — but it entered the film far more
saturated than it was, so crosstalk, interlayer and the print dyes all worked
on the wrong colours; and a RAW source, which enters through the correct
AP0 → AP1 matrix, left through the near-identity M_out and was displayed
markedly desaturated.

**Implemented** (`core/colorspace.ts`) with the derived matrix, six places,
and `M_SRGB_TO_P3` carried to six places as well so that both matrices map
the D65 white onto the ACES white exactly. `regressions.test.ts` holds
M_SRGB_TO_AP1 to the ACES reference value.

The display end had the matching defect. The chain's output matrix produces
Display P3, but the WebGL canvas was never tagged P3, so the browser showed P3
numbers as sRGB ones. The renderer now sets `drawingBufferColorSpace` to
`display-p3` where the browser supports it and falls back to an AP1 → sRGB
output matrix where it does not; the export read-back and canvas carry the same
tag, so a saved file gets a matching profile. Display-referred sources are
likewise unpacked into Display P3 where the context can do so, so an iPhone
photograph keeps its gamut instead of being clipped to sRGB on upload.

One consequence is measured, not hidden: with a real AP1 → P3 matrix a
saturated deep shadow can cross zero in one channel, and the display clamp's
kink lands where the sRGB-style encode is steepest. The .cube export's
measured error (the ACCURACY line of its header) rose accordingly — 14 code values
at 33³, 4.5 at 129³ for a colour negative — and the header now names the gamut
clip alongside a steep curve as the reason.


## 20. Synthetic defocus without a captured depth map

§XIII marks synthetic defocus, cat-eye bokeh and aperture blade shape as
SHOULD (FR-10), and makes all three conditional on *capture* depth — LiDAR or
dual-camera disparity — which an imported file does not carry. **Implemented**
with the depth estimated on the device instead (`src/depth/`,
`gl/shaders/defocus.ts`, `core/defocus.ts`). Three things the paper does not
say had to be decided.

**Where the depth comes from.** Depth Anything V2 Small (Apache-2.0), run in
a Web Worker through ONNX Runtime Web: fp16 on WebGPU where the adapter has
`shader-f16`, int8 on WebAssembly everywhere else, with a WebGPU failure
falling back to the CPU. It is the network the `Depth-Anything-V2` Space
defines; the ONNX export was checked against that PyTorch code and the
official Small weights on the Space's demo images (fp16: correlation 1.00000,
mean error 0.04–0.12 % of the disparity range; int8: 0.3–1.4 %). The Space
itself runs Large, which is CC-BY-NC-4.0 and some 335 M parameters; Small is
the one that is both licensable and a sane phone download. The preprocessing
is `image2tensor`'s — short side to 518, both sides to a multiple of 14,
ImageNet normalisation — resampled with an antialiased Keys cubic rather than
cv2's aliasing one. The weights (50 MB fp16 or 27 MB int8) and the runtime
binary (26 MB) are fetched on first use, only after the user agrees to the
download, from a revision-pinned URL, into a Cache Storage bucket the service
worker never deletes; the app's own precache is unchanged at ~9.6 MB.

**How a relative map becomes a lens.** The network predicts affine-invariant
disparity — 1/z up to an unknown scale and shift — and the paper's CoC needs
metres. The CoC is linear in 1/z, so two anchors suffice: the far end of the
map (its 0.5th percentile) is taken as infinity, and the user supplies the
distance to the focus point, which is what a focus scale reads. The CoC is then
c = f²/(N(z_f − f)) · (1 − d/d_f), signed, and the rest of the lens is real:
the focal length (the format's normal lens by default, or the RAW file's),
f/1.2–f/22 in thirds, and the frame's pixel pitch, so a larger format at the
same f-number is shallower, as it is. The depth of field readout uses the same
formula with a permissible CoC of the frame diagonal over 1442 (0.030 mm on
35 mm); `defocus.test.ts` holds the two to each other exactly. **What the
infinity anchor costs:** a picture with no far background (a wall behind the
subject) has its farthest surface treated as infinitely far, which exaggerates
the blur there. The focus distance is the control that compensates.

**Where in the chain, and how.** Pre-exposure, on the scene-linear light, ahead
of the glow and halation — the paper's own placement argument for every
taking-lens effect. A defocused highlight therefore reaches the negative as a
bright disc, and the film's shoulder and the halation act on the disc, not on
a point that is blurred afterwards. The blur is a scatter-as-gather at half
resolution (capped at 1536 px on the long side, so an 8192 export gathers on
the same grid as the preview and the look does not change with export size),
with the far and near fields separated as in Jimenez's post-process depth of
field: behind the focal plane a neighbour spreads over a pixel only within the
smaller of the two blurs, so a sharp subject is never painted over by the soft
background; in front of it, a blurred foreground spreads over everything
within a reach dilated from 16-pixel tiles and is laid over by coverage.
Discs are weighted by the inverse of their area, so a point keeps its energy
however wide it spreads. CoCs up to about a grid pixel are blurred at full
resolution in the combine, and anything under half a pixel is the scene as it
was — the depth of field's interior keeps every pixel of detail. The aperture
is the paper's: an n-gon (5–9 blades) blended toward the circle by blade
curvature, intersected with two circles offset along the radial direction for
the cat's eye. The depth map is refined to the picture's own edges by a joint
bilateral upsample before any of this, because a 518-pixel network puts its
edges within a 518-pixel grid.

**On phones.** The first build crashed iOS Safari: a phone's tab is killed
outright past its memory ceiling, with nothing to catch. Five sources of the
peak were removed. First, the download no longer holds its chunks, the joined
buffer and a copy for the cache at once (three times the model). It streams
into the cache and is read back once. Second, a phone
(`depthProfile`) feeds the network 392 px on the short side instead of 518.
The attention matrices scale with the square of the token count, so that is
about a third of the memory. It also refines to a 1024 px guide. Third, iOS
runs the CPU path on ONNX Runtime's plain WebAssembly build (14 MB). The
WebGPU build is twice that, WebKit compiles every byte of it into the tab's
memory, and it would put a second GPU device beside the page's WebGL
context. Fourth, the runtime's memory arenas are off on a phone. Fifth, the
worker is torn down after every estimate, because WebAssembly memory never
shrinks. The export's memory cap counts the stage's extra surfaces.
`DEVICE=iphone node scripts/verify-defocus.mjs` runs the whole path in WebKit
as an iPhone 15. That proves it runs in Safari's engine. It does not prove it
fits a particular iPhone's memory, which only a device can.

**Limits, as §XIII predicted.** Hair, glass and reflections are where the
estimated depth is least trustworthy, and they are where the blur will be
wrong. Longitudinal chromatic aberration (§XIII's per-channel defocus offset)
is not implemented.


## 21. The Camera bench: a tint that was not green–magenta, a contrast that moved the brightness, and whites that reached the middle

An audit of the Camera bench against what each control says it does found
three defects. Each is held by a test in `regressions.test.ts` that failed
before its fix.

**Tint.** The white balance's tint added tint·0.05 to the illuminant's v in
CIE 1960 UCS. That is the wrong direction and the wrong size. Near daylight
the Planckian locus is not horizontal in (u, v), so a pure-v step is not
perpendicular to it, and 0.05 is a Duv beyond any lamp — the source white
landed at xy ≈ (0.46, 0.55), a saturated yellow-green, and its correction
turned a grey card 7.4× bluer at tint +1 and cut blue to 0.31 at −1. The
control labelled green–magenta was a blue–yellow control. **Fixed**
(`core/colorspace.ts`): the offset is now along the locus's own normal, taken
from the locus five mireds either side, and ±1 is a Duv of ±0.02
(`TINT_DUV`). On a grey card that is a CC20-sized green–magenta correction
with red and blue moving together. The sign is the temperature slider's:
the control says what the *light* was, so a green light (+) is corrected
toward magenta. The hint now says so. A recipe saved with a tint renders a
different, and now correct, colour.

**Contrast.** The slope pivoted on scene grey, 0.18, after the exposure gain.
That is the film's anchor, but it is only the picture's middle when the
picture happens to be anchored there, which a display-referred file almost
never is (the test chart's log-average is 0.12; after +1.08 EV it is 0.26).
Off the pivot, contrast was also an exposure control: the print's mean
code value ran 115 → 131 → 153 across 0.59× → 1.00× → 1.68×. **Fixed**
(`core/develop.ts`, `resolve.ts`, the prepare shader): the develop now
pivots on the picture's measured log-average after the exposure gain
(`camera.pivot`), and every mask is placed from it too, so "1.5 stops over
grey" means over *this picture's* grey. Pixels at the middle are untouched by
contrast, exactly. What remains of the mean's drift (122 → 128 → 140) is the
film's toe and shoulder and the display encoding acting asymmetrically on a
symmetric scene-side change, which is the film's business. An unmeasured
picture still pivots on 0.18. The exposure anchor, the histogram and the LUT
bake read the same resolved pivot, so none of them can drift from the screen.

**Whites and blacks.** Their logistic masks had a width of 2 stops at ±4
stops, so at the middle grey they still carried σ(−2) = 0.12 of their
setting: whites +2 lifted the middle by 0.24 stops and the −1 stop shadows by
0.15. That contradicts the hint ("the extreme top end"). **Fixed**: width
1.0, which leaves 0.018 of the setting at the middle (under 0.04 stops at
±2). Highlights and shadows are unchanged — at ±1.5 stops with width 1 they
are mid-scale controls by design and say so.

**Checked and correct:** the temperature direction and magnitude (3200 K
corrects a grey card to R:G:B ≈ 0.46 : 1 : 2.07 in sRGB, against 0.58 : 1 :
2.22 for a plain diagonal between the two Planckian whites — CAT02 differs
from a diagonal by that much), identity at 5500 K, the saturation operator
(luminance exact, host and GPU identical), exposure, the 18 %-grey anchor
suggestion, monotonicity of every control, and GPU/host parity of the whole
stage (`scripts/verify.mjs`, develop means). One simplification remains: the
histogram's samples are weighted with the source primaries' luminance before
the white balance, while the shader's tone gain reads AP1 luminance after it.
For anything but an extreme white balance the two differ by a small fraction
of a stop.


## 22. Every RAW rendered upside down, and its Compare looked like log

**Orientation.** The renderer read float sources, which are all RAW
decodes, without the vertical flip it applies to bitmaps. The comment
claimed LibRaw's rows were "already in texture order". They are not:
LibRaw delivers the top row first, as every image does, and `texImage2D`
puts the first row at the bottom of a GL render. Every RAW was therefore
previewed and exported mirrored top to bottom. An independent decode of
the test file (rawpy/LibRaw) has the bottle and the can upright; EMULSION
had them upside down. **Fixed** (`renderer.ts`, setSource): every source
is read flipped. The depth map's special case for float row order is gone
with it.

**The before half of Compare.** For a RAW, the "Scene" half put linear
light straight on the display. No camera shows a picture that way, and it
reads as flat and grey, like log footage beside a finished print. The half
is now "Original". For an ordinary file it is still the file itself. For a
RAW decode it passes through a neutral filmic curve (the Narkowicz fit of
ACES), a clean camera render without film. Exposure and the camera develop
still apply to both halves.

**Corners.** The interface follows the HIG's two rules for corners:

- Controls are capsules. That covers buttons, toolbar groups, chips,
  segmented controls and their thumbs, the bench tabs, pop-up menus and
  badges. They keep true half-circle ends even where the continuous
  (squircle) corner is used for everything else.
- Containers are concentric with their contents. The inspector's radius is
  the tab capsule's radius plus its 12 pt inset: 28 pt with a pointer,
  36 pt on touch. Cards inside it take that radius less the same inset.

On a phone the export sheet floats 8 pt inside the display, with 47 pt
corners concentric with the display's. The wordmark is plain text, not a
control, so it no longer sits in a glass container.
