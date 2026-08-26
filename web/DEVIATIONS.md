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
- **Optical simulation and aging are not implemented.** §XIII and §XIV. Their
  parameters are not carried either, rather than carried unused.
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
