# EmulsionCore — Design Specification

**Date:** 2026-08-10
**Status:** Approved for planning
**Source of truth:** `main.tex` and `sections/` in this repository, built as `main.pdf` (60 pp).
Section references below (§V, §XV-E, Appendix A…) point into that document.

---

## 1. Context

The design document specifies EMULSION, an iOS digital film laboratory, as a
24-month programme across six modules (§XXII: 4–10 FTE, ~$4.4M). That is a
programme, not a single implementable spec, so it is decomposed along the module
boundaries the paper already defines in Table II.

| # | Sub-project | Depends on | Status |
|---|---|---|---|
| **A** | `EmulsionCore` — domain model, imaging math, parameter resolution | — | **this spec** |
| B | `EmulsionRender` — Metal kernels, render graph, LUT bake | A | not started |
| C | `EmulsionStore` — SQLite schema, repositories, sidecar | A | not started |
| D | `EmulsionCapture` — AVCaptureSession, ProRAW, scene-referred decode | A | not started |
| E | `EmulsionUI` / `EmulsionApp` — SwiftUI workspaces | A, B | not started |

Build order follows the paper's critical path (§XXII-F): A → B → E.

### 1.1 Hard constraint: no build or test on this machine

Development is happening on Windows 11. There is no Swift compiler, no Xcode, no
`metal` shader compiler, and no simulator, and none can be installed — Xcode is
macOS-only. **Every artifact produced under this spec is unverified source until
it reaches a Mac (or a Linux box with a Swift toolchain).** No claim of
"working", "passing", or "correct" may be made about this code from this machine.

This constraint shapes two decisions in the spec: the package is SwiftPM rather
than an Xcode project (so it can be built and tested headless on Linux CI, as
§A4 requires of `EmulsionCore`), and the deliverable includes an executable probe
so a human can inspect model output in one command rather than only receiving a
pass/fail.

---

## 2. Scope

### 2.1 In scope

`EmulsionCore` implements **the entire pointwise imaging chain** — everything
§XV-E enumerates as bakeable into the 3D LUT — plus the domain model, profile
loading and validation, parameter resolution, and sensitometric diagnostics.

### 2.2 Out of scope

- **Spatial and stochastic stages**: interlayer inhibition (§VIII), grain (§XI),
  halation (§XII), optical simulation (§XIII), aging (§XIV). Core carries their
  parameters in `ResolvedParameters` for module B to consume, and evaluates none
  of them. They are not pointwise and cannot be baked.
- Anything requiring Metal, SwiftUI, GRDB, or AVFoundation.
- Persistence, capture, UI, export.

### 2.3 Non-goals

- No plugin or node-graph architecture. §XVI defers compositional structure to
  the render graph in module B; duplicating it here is speculative generality.
- No performance optimisation. Core is host-side, called once per edit and once
  per LUT bake. Clarity wins over speed everywhere.

---

## 3. Architecture

SwiftPM package, `swift-tools-version: 6.0`, strict concurrency enabled.
`EmulsionCore` imports Foundation and nothing else.

```
ChromaLab/
├── main.tex, sections/, main.pdf          the design document
├── docs/superpowers/specs/                this spec
└── EmulsionCore/
    ├── Package.swift
    ├── Sources/
    │   ├── EmulsionCore/
    │   │   ├── Domain/         Recipe, stage structs, ParameterKey,
    │   │   │                   FilmFormat, StockRef, Record, Triple
    │   │   ├── Profiles/       StockProfile, CurveParameters,
    │   │   │                   ChemistryProfile, ProfileDecoder,
    │   │   │                   ProfileValidator, ProfileStore
    │   │   ├── Imaging/        ColorSpace, CharacteristicCurve,
    │   │   │                   Development, PrintTransfer,
    │   │   │                   PrinterLights, PointwiseChain
    │   │   ├── Sensitometry/   Sensitometry
    │   │   ├── Resolution/     ParameterResolver, ResolvedParameters,
    │   │   │                   TransientOverrides
    │   │   ├── Support/        Math, Matrix3x3, EmulsionError
    │   │   └── Resources/profiles/*.json   19 files, from Appendix A
    │   └── emulsion-probe/     main.swift
    └── Tests/EmulsionCoreTests/
```

### 3.1 Load-bearing properties

**No platform types cross the Core boundary.** `ResolvedParameters` holds
`Double`, `Triple`, and `Matrix3x3` — not `simd_float3x3`. Module B narrows to
`Float` at its own ABI boundary (Appendix B, `EMFrameParams`). Appendix D makes
the import matrix a CI-enforced rule; this is what keeps the validation suite
runnable without a device.

**`PointwiseChain.evaluate` is the single path module B bakes.** Appendix B's
`em_bake_lut` calls the shared chain rather than a reimplementation, because bake
and direct evaluation must not drift. The Swift function is correspondingly pure:
no I/O, no caching, no dependence on anything but its arguments.

**Profiles are data.** The 19 JSON resources (10 negative, 4 print, 5 chemistry)
are decoded and validated at load. `ProfileValidator` enforces
ΔD ≥ 4(κt + κs) before a profile can reach the chain, implementing §VI's
requirement that the validator "rejects any profile violating (10) at load time."

> **Note on `neg.v3_500t.xr`.** Appendix A's halation table lists an eleventh
> negative profile — the remjet-removed variant — but gives it no row in the
> curve-parameter table, because it differs from `neg.v3_500t` only in halation
> (α_h 0.55 vs 0.05, ℓ_R 118 vs 86 µm, ω 0.22 vs 0.01). Halation is not
> evaluated in Core, so the variant would be byte-identical here. It is
> therefore deferred to module B and **not** shipped as a Core resource, keeping
> the count at 19. This is a small inconsistency in the appendix, recorded under
> §9 item 6.

---

## 4. Public surface

Follows Appendix D, made concrete.

```swift
public enum Record: Int, Sendable { case r = 0, g = 1, b = 2 }

public struct Triple: Sendable, Hashable, Codable {
    public var r, g, b: Double
    public subscript(_ c: Record) -> Double { get set }
}

public struct CurveParameters: Sendable, Hashable {
    public var dMin, deltaD, gamma, x0, kappaT, kappaS: Triple
    public var maskDepletion, balanceShift: Triple
    public var isWellFormed: Bool          // ΔD ≥ 4(κt+κs), tested on |γ|
}

public enum CharacteristicCurve {
    public static func density(logE: Double, _ p: CurveParameters, _ c: Record) -> Double
    public static func pointGamma(logE: Double, _ p: CurveParameters, _ c: Record) -> Double
    public static func densityTriple(logE: Triple, _ p: CurveParameters) -> Triple
}

public enum Development {
    public static func activity(_ d: DevelopStage, _ chem: ChemistryProfile) -> Double
    public static func modulate(_ curve: CurveParameters, activity: Double,
                                chemistry: ChemistryProfile) -> CurveParameters
}

public enum PrintTransfer {
    public static func aimBalance(negative: CurveParameters, print: CurveParameters,
                                  crosstalk: Matrix3x3) throws -> Triple
    public static func printDensity(negativeDensity: Triple, _ p: ResolvedParameters) -> Triple
    public static func toDisplay(printDensity: Triple, _ p: PrintParameters) -> Triple
}

public enum Sensitometry {
    public static func speedPoint(_ p: CurveParameters, _ c: Record) -> Double
    public static func isoSpeed(_ p: CurveParameters) -> Double
    public static func contrastIndex(_ p: CurveParameters, _ c: Record) -> Double
    public static func latitude(_ p: CurveParameters, _ c: Record, fraction: Double) -> Double
}

public enum PointwiseChain {
    public static func evaluate(logExposure: Triple, _ p: ResolvedParameters) -> Triple
    public static func evaluate(sceneLinear: Triple, _ p: ResolvedParameters) -> Triple
}
```

### 4.1 Decisions where the paper leaves a choice

1. **Offsets resolve at load.** Appendix A stores each stock as a green record
   plus red/blue offsets, because that makes crossover reviewable by a human.
   The evaluation path must not know that encoding: `ProfileDecoder` expands
   offsets into complete per-record `Triple`s once, at decode.
2. **Reversal needs no special case.** γ < 0 flows through the same equations.
   Exactly two places must respect the sign: `isWellFormed` tests |γ|, and
   `Sensitometry.speedPoint` flips its offset term. Asserted by test, not trusted.
3. **Mask depletion is one fixed-point iteration** (§VI): compute density,
   correct Dmin by (12), recompute once. Not iterated to convergence — the paper
   states one pass is below AC-1 tolerance.
4. **`aimBalance` throws.** Four Newton steps from the straight-line estimate;
   non-convergence means a broken profile pair, and every render from it would be
   mis-balanced. Refusing beats a silently non-neutral neutral.

---

## 5. Data flow

### 5.1 Resolution — once per edit

```
StockProfile defaults        decoded JSON
  → ChemistryProfile modulation   Development.activity → .modulate
  → Recipe values                 the user's sparse edit
  → TransientOverrides            preview quality reductions
  = ResolvedParameters            dense, no optionals, Sendable, Hashable
```

`ParameterResolver` memoises the aim balance, keyed by (negative id + version,
print id + version, saturation). §IX-C computes it once per stock pair; it is
constant across slider movement and costs twelve Newton steps to recompute.

### 5.2 Evaluation — the nine pointwise stages (§XV-E order)

| # | Stage | Operation |
|---|---|---|
| 1 | Layer balance | `x_c += Δx_bal` (tungsten; zero for daylight stocks) |
| 2 | Characteristic curve | `D = Dmin + sp_κt(u) − sp_κs(u − ΔD)`, `u = γ(x − x₀)` |
| 3 | Mask depletion | correct `Dmin_c` per (12), recompute `D` once |
| 4 | Printing density | `D_eff = C · D` |
| 5 | Print exposure | `logE′ = log₁₀L_aim + 0.025(p_c + p_master) − D_eff` |
| 6 | Print curve | same softplus form, print parameters |
| 7 | Silver retention | `D′ += ϱ·D̄′` when ϱ > 0 |
| 8 | Neutral axis | `D′_R += δ_RG·ψ(D′)`, `D′_B += δ_BG·ψ(D′)` |
| 9 | Display | normalise by Dmin′/Dmax′, surround exponent, print primaries → P3 |

`evaluate(sceneLinear:)` prepends what lives **outside** the LUT domain: the
collapsed input + white-balance matrix, exposure anchoring (15), and the ISO
shift (16); then takes log₁₀ and calls `evaluate(logExposure:)`. The split is
required — the LUT domain is log exposure over [−4, +2] (§XV-E), so baking
anything before the log would make a white-balance change silently invalidate it.

The bypass print profile short-circuits stages 4–8, inverting and normalising
negative density only, producing the flat lab-scan look §IX specifies.

---

## 6. Error handling

**Principle: validate at the boundaries so the hot path is total.**
`PointwiseChain.evaluate` runs 91,125 times per LUT bake; it does not throw and
cannot fail.

### 6.1 Throwing boundary — profile load

```swift
case profileInvalid(id: String, reason: String)    // ΔD < 4(κt+κs), ΔD ≤ 0,
                                                   // κ ≤ 0, unknown chemistry ref
case profileMissing(id: String, version: Int?)
case aimBalanceDiverged(negative: String, print: String)
```

A malformed shipped profile is a packaging defect, not user error: trap in debug;
in release refuse to register that stock rather than substituting defaults. A
stock that renders but is not the stock named on it would falsify the paper's
"defaults are measurements" claim (§I-C).

### 6.2 Total hot path — five numerical guards

| Guard | Rationale |
|---|---|
| Floor scene values at 1e-7 before log₁₀ | §V: AP1 makes negatives rare, not impossible; log of a negative is undefined. Debug builds count occurrences — nonzero means the working space is wrong |
| Stable softplus `max(u,0) + a·log1p(exp(−|u|/a))`, never `log(1+x)` | §VI: the naive form loses all significant digits in the deep toe and stair-steps visibly |
| Clamp κ ≥ 1e-3 | The UI clamps sliders, but Core cannot assume the caller did |
| ΔD, ΔD′ > 0 by validation | Lets stages 7–9 divide without runtime checks |
| Non-finite inputs trap in debug, clamp in release | The paper's stated programmer-error policy (§XVII-H) |

---

## 7. Testing

Framework: `swift-testing`. Plus `emulsion-probe`, an executable target.

### 7.1 Tests against values the paper publishes

- **Push/pull response.** Table VIII gives A, γ, ΔDmin, true speed gain and CI
  for pull-2 … push-3. `Development.modulate` must reproduce all six rows to
  ±0.01 on γ, ±0.01 density on ΔDmin, ±0.02 EV on true speed, and ±0.01 on CI —
  one unit in the table's last printed digit. Disagreement means the
  implementation or the table is wrong; see risk A-03.
- **ISO speed round-trip.** Appendix A derives each x₀ from rated ISO via
  S = 0.8/10^x_sp, so `Sensitometry.isoSpeed` must return the declared ISO within
  2% for all ten stocks. Tests the implementation and the appendix together.
- **Contrast index bands.** §VI states 0.55–0.62 for normal-process colour
  negative, 0.50–0.58 for B&W pictorial. Each profile must land in its band.

### 7.2 Tests of claimed mathematical properties

- **Monotonicity (AC-6)** over [−5, +3] for every profile at every process
  setting: non-decreasing for negative stocks, non-increasing for reversal.
- **Analytic derivative matches central difference** to 1e-6 (claim R4).
- **Speed point inverts the curve (V-07):** D(x_sp) = Dmin + 0.10 ± 1e-4.
- **Softplus stability:** u/κ = ±800 yields finite, non-NaN, smooth output.
- **Well-formedness rejection:** ΔD < 4(κt+κs) throws at load.
- **Neutral balance (V-08):** for all 10 × 4 stock pairs, an 18% scene neutral
  produces R = G = B within 1e-3 after aim balancing. §IX-C claims this holds for
  every pair without hand-tuning; the test holds it to that.
- **Null test (V-16 / AC-7):** identity configuration with bypass print reduces
  to the plain colour transform.
- **Determinism:** identical `Recipe` yields identical `ResolvedParameters` and a
  stable canonical-JSON hash.

### 7.3 The probe

`swift run emulsion-probe` prints a per-stock sensitometric card (ISO, CI,
latitude, Dmin/Dmax, well-formedness margin), a 21-step wedge D–log E table, and
the forty-pair neutrality check — so a human can look at the model's output
rather than only learning that it passed.

### 7.4 What Core cannot validate

Stated so it is not mistaken for coverage:

- **AC-1** needs digitised datasheet curves that do not exist in this repository.
  This is risk T-01 and remains open.
- **AC-2** needs a reference print-through of a step wedge.
- **AC-3** (Wiener spectrum) and **AC-4** (halation radial profile) belong to
  module B; the phenomena are not implemented here.
- No NFR performance target is testable in Core.

---

## 8. Risks

| ID | Risk | Response |
|---|---|---|
| A-01 | No compilation or test run is possible on the development machine; first build on a Mac will surface syntax and type errors | Keep the module Foundation-only and small; prefer explicit types; expect a fix-up pass on first real build. Do not report the code as working |
| A-02 | Appendix A values are provisional fits (fit status P/E on three stocks), not measurements | Tests assert internal consistency (ISO round-trip, CI bands), never external fidelity. AC-1 stays open, per T-01 |
| A-03 | Table VIII's push/pull row values may not be exactly reproducible from the equations as parameterised | Treat a mismatch as a finding about the paper, report it, and correct whichever side is wrong rather than loosening tolerance silently |

---

## 9. Definition of done

1. `EmulsionCore` package with the layout of §3, compiling under Swift 6 strict
   concurrency **on a machine that can compile it**.
2. All nine pointwise stages implemented, composed by `PointwiseChain.evaluate`.
3. 19 profile JSON resources decoded and validated at load.
4. The test suite of §7.1–7.2 written and passing on that machine.
5. `emulsion-probe` producing the three reports of §7.3.
6. A written record of any place where implementing the paper revealed the paper
   to be wrong, ambiguous, or inconsistent.

Item 6 is not bookkeeping. Implementation is the first real test of a design
document, and the paper is the artifact of record.
