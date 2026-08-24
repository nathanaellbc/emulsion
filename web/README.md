# EMULSION — digital film laboratory

A browser application that carries a scene-referred capture through the stages of
analog photographic processing: latent image formation, characteristic-curve
density mapping, chemical development, optical print exposure, print stock
reproduction, stochastic grain formation, and the light that scatters off the
back of the film base and comes home red.

It implements the design document at the repository root (`main.tex`,
`main.pdf`, 60 pp) — the pointwise chain of §XV-E, the grain model of §XI, the
halation model of §XII and the interlayer inhibition of §VIII. Everything runs
on the GPU in the page; no file leaves the machine.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 145 assertions against the paper's published values
npm run build
```

## What it is not

It is not a lookup table with a grain overlay. The distinction is the whole
point of the design document, and it is load-bearing in three specific places:

- **The print stage is not optional.** A negative is a low-contrast,
  orange-masked, inverted record with a gamma near 0.6. Nothing about it
  resembles a photograph. Every quality people mean by "film look" is created in
  the second transfer, and that transfer is a curve applied to the negative's
  *transmittance* mediated by a crosstalk matrix — not three independent 1-D
  curves, and therefore not expressible as one.
- **The orange mask is removed by balancing, not by an operation.** Dmin enters
  the printing density as a constant vector, so it is exactly compensable by the
  printer lights. The aim balance computes them once per stock pair, which is
  what makes forty stock pairings neutral without any of them being hand-tuned.
- **Grain lives in the negative's density.** So it is strongest in the
  mid-scale and vanishes at both Dmin and Dmax, and it therefore appears in a
  print's shadows rather than its highlights — a property of where it is
  injected, not a curve applied to a noise texture.

## Layout

```
src/
  core/            the imaging model — no DOM, no GL, fully tested
    math.ts        stable softplus and its derivative
    curve.ts       the characteristic curve, mask depletion, validation
    development.ts activity from time/temp/agitation/push; curve reshaping
    interlayer.ts  DIR coupling, the two-scale highpass, the activity weight
    print.ts       crosstalk matrix, aim balance, silver, display transform
    sensitometry.ts ISO, contrast index, latitude, speed point
    colorspace.ts  ACEScg working space, von Kries white balance
    resolve.ts     recipe + profiles -> dense parameters, once per edit
    chain.ts       the nine stages on the host, for testing
    profiles/      Appendix A as data
  gl/
    renderer.ts    the render graph
    halationFit.ts solves the pyramid weights against the stock's PSF
    shaders/       the same nine stages, on the GPU
  io/decode.ts     RAW via LibRaw; ordinary images via the browser
  ui/              the control rail, the D-log E plot, the viewport
```

`core/` and `gl/shaders/` implement the same equations twice. That is a real
risk of drift, taken deliberately — see DEVIATIONS.md §9.

## Reading the interface

The **D–log E plot** is the instrument. It draws the three records from the
resolved parameters — the same numbers the shader is running — over a histogram
of where this photograph's tones actually fall. Push development and the curves
steepen under a stationary picture; change exposure and the picture slides
beneath stationary curves. That is the difference between the two controls, and
it is easier to see than to explain.

Every control is labelled in the unit the model uses. Printer lights are integer
**points** because a point is 0.025 in log exposure and twelve make a stop, and
because integers are what makes a grade communicable between a lab and a client.
There is no "warmth 0–100" anywhere, and that is deliberate. The interlayer
control is called **coupler activity** and not "sharpness" for the same reason:
it is the strength of the DIR effect, and what it does — suppressing red and
blue development beside a green edge — is not something a sharpness control or a
saturation control can reach, because it acts on the local difference between
records rather than on either one alone.

The four **inspection stages** show the chain mid-flight: the print, the negative
density that is actually on the film, the print density before the display
transform, and the halation source term.

The first entry in the stock list, **None — ideal negative**, is the fifth
instrument. It is a straight line of gamma 1 with no toe, no shoulder, no fog
and no orange mask, so everything left in the picture is the print stock and the
exposure. Switching between it and Portra 400 under a fixed print is the
cleanest way to see what a negative actually contributes — which is most of what
the design document argues about.

## Findings against the design document

Implementation is the first real test of a design document. Seven places where
the paper turned out to be wrong, ambiguous or inconsistent — including an ISO
shift equation whose sign contradicts its own explanatory sentence, an x₀ column
that leaves HP5 19% fast, and interlayer diffusion lengths that are below the
pixel at every resolution this renders — are recorded in **DEVIATIONS.md**, with
what was done and why. None was resolved by loosening a tolerance.

## Verification

`npm test` runs 145 assertions against values the paper publishes: Table VIII's
push/pull ladder, the ISO round trip for every stock, monotonicity across every
process setting, the analytic derivative against a central difference, the aim
balance across all forty stock pairs, and — for the one stage that is spatial
rather than pointwise — mean preservation, edge polarity and cross-record
transfer of the interlayer operator over a field.

`node scripts/verify.mjs` loads the built app in headless Chromium and fails on
any console error, page error or failed request. TypeScript cannot check GLSL,
so a shader that fails to compile builds perfectly and throws at runtime; this
is what catches that. It needs a preview server on port 4173 and writes
screenshots to `verify-shots/`.

`node scripts/make-test-chart.mjs` regenerates `public/test-chart.png` — a step
wedge, memory colours, saturated primaries and speculars several stops past
white, which is what the verification pass feeds the app.

## Requirements

WebGL2 with `EXT_color_buffer_float`. The chain works in density, and density is
not an 8-bit quantity.
