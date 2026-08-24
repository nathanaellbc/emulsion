# EMULSION

**A physically inspired digital film laboratory.** Most film-simulation apps are
a lookup table, a grain overlay, and a contrast curve applied to an
already-rendered image. EMULSION is built differently: a scene-referred capture
is carried through a chain of physically motivated transforms that mirror the
stages of analog photographic processing — latent image formation,
characteristic-curve density mapping, chemical development, interlayer
inhibition, optical print exposure, print-stock reproduction, stochastic grain
formation, subsurface light scattering (halation), and taking-lens diffusion.

The repository holds two artifacts of the same model:

| | |
|---|---|
| **`main.tex` → `main.pdf`** | The design document — a 60-page IEEEtran software design specification: closed-form models for every stage, the render architecture, the persistence schema, verification methodology, and a 24-month engineering roadmap. |
| **`web/`** | A browser implementation of that document. The whole chain runs on the GPU in the page (WebGL2); no file ever leaves the machine. |

## What it is not

It is not a LUT with a grain overlay. Three things are load-bearing:

- **The print stage is not optional.** A colour negative is a low-contrast,
  orange-masked, inverted record — nothing about it resembles a photograph.
  Everything people mean by "film look" is created in the second transfer, which
  is a curve applied to the negative's *transmittance* mediated by a crosstalk
  matrix, not three independent 1-D curves.
- **The orange mask is removed by balancing, not by an operation.** Dmin enters
  the printing density as a constant vector, exactly compensable by the printer
  lights, which is what makes the stock pairings neutral without hand-tuning.
- **Grain lives in the negative's density** (Campbell/Selwyn filtered-Poisson),
  so it is signal-dependent: strongest in the mid-scale, vanishing at both Dmin
  and Dmax, appearing in a print's shadows rather than its highlights.

## Layout

```
main.tex, sections/   the design document (LaTeX, IEEEtran)
web/
  src/core/           the imaging model — no DOM, no GL, fully unit-tested
    curve.ts          the characteristic curve (softplus toe-and-shoulder)
    development.ts    activity from time/temp/agitation; curve reshaping
    interlayer.ts     DIR coupling, two-scale highpass
    print.ts          crosstalk matrix, aim balance, silver, display transform
    grainPresets.ts   format/ISO grain looks (datasheet Selwyn values)
    halationPresets.ts
    resolve.ts        recipe + profiles -> dense parameters, once per edit
    chain.ts          the nine pointwise stages on the host, for testing
    profiles/         the stock/chemistry parameters (Appendix A as data)
  src/gl/             the same stages on the GPU
    renderer.ts       the render graph
    halationFit.ts    fits the pyramid weights to the stock's exponential PSF
    shaders/          GLSL for the nine stages + grain + halation + diffusion
  src/io/decode.ts    RAW via LibRaw (scene-referred); ordinary images via the browser
  src/ui/             the control rail, the D–log E plot, the viewport
  scripts/            headless verification + accuracy measurement
docs/superpowers/     design plans and specs
```

`core/` and `gl/shaders/` implement the same equations twice — a deliberate,
recorded risk: the GPU path is what renders, the host path is what can be tested
against the document's published values. Divergence is a defect, never a
tolerance. See `web/DEVIATIONS.md`.

## The web app

**Requirements:** WebGL2 with `EXT_color_buffer_float` (the chain works in
density, and density is not an 8-bit quantity).

```bash
cd web
npm install
npm run dev        # http://localhost:5173
```

Open the page and drop in a camera RAW file (`.dng`, `.raf`, `.cr3`, …) for a
genuinely scene-referred capture, or an ordinary image (JPEG/TIFF/AVIF) — which
runs, with the caveat that a tone curve was already baked in before the chain
saw it.

Controls are labelled in the units the model uses: printer lights in integer
**points** (1 point = 0.025 log E, twelve to a stop), the interlayer control as
**coupler activity**, grain by **Selwyn granularity** and micrometres. There is
no "warmth 0–100" anywhere, and that is deliberate.

### Verification

```bash
cd web
npm test           # 188 assertions against the document's published values
npm run typecheck  # strict TypeScript, no emit
npm run build      # production bundle in web/dist/
```

The suite checks the implementation against the design document, not against
itself: the push/pull ladder, the ISO round trip for every stock, the analytic
curve derivative against a central difference, the aim balance across the stock
pairings, and — for the spatial stages — mean preservation, edge polarity, and
cross-record transfer over a field.

Headless render verification (catches GLSL compile failures, which TypeScript
cannot):

```bash
cd web
npm run build && npm run preview &   # serve the build on :4173
node scripts/verify.mjs              # loads it in Chromium, fails on any error
```

## The design document

`main.tex` compiles to the 60-page PDF with pdfLaTeX:

```bash
pdflatex main && pdflatex main && pdflatex main
```

(no BibTeX pass is required; references are set inline). `IEEEtran.cls` is
vendored at the repo root.

## Findings

Implementing the document was its first real test. The places where the paper
turned out to be wrong, ambiguous, or inconsistent — and what was done about
each, with nothing resolved by loosening a tolerance — are recorded in
**[`web/DEVIATIONS.md`](web/DEVIATIONS.md)**, including the reversal exposure
anchor (ISO 2240 vs 5800) and the tungsten layer balance.

## License & trademarks

Film-stock and print-stock names are used descriptively to identify the
photographic response being modelled; all trademarks are the property of their
respective owners and no affiliation or endorsement is implied.
