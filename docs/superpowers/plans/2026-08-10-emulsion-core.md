# EmulsionCore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `EmulsionCore`, a Foundation-only Swift package implementing the complete pointwise imaging chain of the ChromaLab design document — scene RGB to display RGB — with a test suite and an inspectable CLI probe.

**Architecture:** Namespaced enums holding static pure functions (`CharacteristicCurve`, `Development`, `PrintTransfer`, `Sensitometry`), composed in documented order by `PointwiseChain.evaluate`. Stock parameters are JSON resources decoded and validated at load, so the evaluation path is total and cannot fail. This is sub-project A of five; module B (Metal) later bakes `PointwiseChain.evaluate` into a 45³ LUT by calling this exact code.

**Tech Stack:** Swift 6.0, SwiftPM, `swift-testing`, Foundation only. No Metal, SwiftUI, GRDB, or AVFoundation.

## Global Constraints

- **Swift tools version 6.0**, strict concurrency enabled. All public types `Sendable`.
- **`EmulsionCore` imports Foundation and nothing else.** This is CI-enforced per Appendix D's import matrix and is what keeps the suite runnable headless.
- **`Double` throughout.** Narrowing to `Float` happens at module B's ABI boundary, not here.
- **The evaluation path never throws.** Only profile decode/validate and `aimBalance` throw.
- **Softplus always uses the stable form** `max(u,0) + a·log1p(exp(−|u|/a))` and `log1p`, never `log(1+x)`.
- **Source of truth is `main.tex` / `main.pdf` in this repository.** Equation numbers below refer to the built PDF. Where implementation contradicts the paper, record it (Task 14) — do not silently bend either side.
- **This plan cannot be executed on the machine that wrote it.** Windows, no Swift toolchain. Every `swift build` / `swift test` step requires macOS or Linux with Swift 6. The plan is written for that machine.
- **Git:** `D:\Projects\ChromaLab` is not yet a repository. Task 1 initialises it.

---

### Task 1: Package skeleton and numerically stable math

**Files:**
- Create: `EmulsionCore/Package.swift`
- Create: `EmulsionCore/Sources/EmulsionCore/Support/Math.swift`
- Test: `EmulsionCore/Tests/EmulsionCoreTests/MathTests.swift`

**Interfaces:**
- Consumes: nothing.
- Produces: `Math.softplus(_ u: Double, _ a: Double) -> Double`, `Math.logistic(_ t: Double) -> Double`, `Math.clampSoftness(_ k: Double) -> Double`.

- [ ] **Step 1: Initialise the repository and package**

```bash
cd /path/to/ChromaLab
git init
mkdir -p EmulsionCore/Sources/EmulsionCore/Support
mkdir -p EmulsionCore/Tests/EmulsionCoreTests
```

Create `EmulsionCore/Package.swift`:

```swift
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "EmulsionCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "EmulsionCore", targets: ["EmulsionCore"]),
        .executable(name: "emulsion-probe", targets: ["emulsion-probe"]),
    ],
    targets: [
        .target(
            name: "EmulsionCore",
            resources: [.process("Resources")],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .executableTarget(
            name: "emulsion-probe",
            dependencies: ["EmulsionCore"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "EmulsionCoreTests",
            dependencies: ["EmulsionCore"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
```

- [ ] **Step 2: Write the failing test**

`Tests/EmulsionCoreTests/MathTests.swift`:

```swift
import Testing
import Foundation
@testable import EmulsionCore

@Suite("Math")
struct MathTests {
    @Test("softplus approaches max(u,0) for small a")
    func softplusApproachesRelu() {
        #expect(abs(Math.softplus(2.0, 0.001) - 2.0) < 1e-6)
        #expect(abs(Math.softplus(-2.0, 0.001) - 0.0) < 1e-6)
    }

    @Test("softplus is finite at extreme arguments")
    func softplusStable() {
        // u/a = ±800 overflows the naive a*log(1+exp(u/a)) form.
        let hi = Math.softplus(80.0, 0.1)
        let lo = Math.softplus(-80.0, 0.1)
        #expect(hi.isFinite)
        #expect(lo.isFinite)
        #expect(abs(hi - 80.0) < 1e-9)
        #expect(lo >= 0.0 && lo < 1e-300 || lo == 0.0)
    }

    @Test("softplus derivative is the logistic")
    func softplusDerivative() {
        let a = 0.14, u = 0.37, h = 1e-6
        let numeric = (Math.softplus(u + h, a) - Math.softplus(u - h, a)) / (2 * h)
        #expect(abs(numeric - Math.logistic(u / a)) < 1e-6)
    }
}
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `cd EmulsionCore && swift test --filter MathTests`
Expected: FAIL — "cannot find 'Math' in scope".

- [ ] **Step 4: Implement**

`Sources/EmulsionCore/Support/Math.swift`:

```swift
import Foundation

/// Numerically stable primitives shared by the density models.
public enum Math {
    /// Minimum softness. The UI clamps sliders so well-formedness cannot be
    /// violated interactively, but Core cannot assume the caller respected that.
    public static let minSoftness: Double = 1e-3

    /// Softplus with sharpness `a`, evaluated in the stable form.
    ///
    /// The naive `a * log(1 + exp(u/a))` overflows for large `u/a`, and
    /// `log(1+x)` loses all significant digits for small `x`, which produces a
    /// visibly stair-stepped toe in deep shadow.
    public static func softplus(_ u: Double, _ a: Double) -> Double {
        let a = max(a, minSoftness)
        return max(u, 0) + a * log1p(exp(-abs(u) / a))
    }

    public static func logistic(_ t: Double) -> Double {
        if t >= 0 {
            return 1 / (1 + exp(-t))
        } else {
            let e = exp(t)
            return e / (1 + e)
        }
    }

    public static func clampSoftness(_ k: Double) -> Double { max(k, minSoftness) }
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `swift test --filter MathTests`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add EmulsionCore/Package.swift EmulsionCore/Sources EmulsionCore/Tests
git commit -m "feat(core): package skeleton and stable softplus"
```

---

### Task 2: Value types — Record, Triple, Matrix3x3

**Files:**
- Create: `EmulsionCore/Sources/EmulsionCore/Domain/Record.swift`
- Create: `EmulsionCore/Sources/EmulsionCore/Support/Matrix3x3.swift`
- Test: `EmulsionCore/Tests/EmulsionCoreTests/ValueTypeTests.swift`

**Interfaces:**
- Consumes: nothing.
- Produces: `Record` (`.r`/`.g`/`.b`), `Triple` (with `subscript(Record)`, `init(_:_:_:)`, `init(repeating:)`, `map`, arithmetic operators), `Matrix3x3` (with `init(rows:)`, `*` against `Triple`, `identity`).

- [ ] **Step 1: Write the failing test**

```swift
import Testing
@testable import EmulsionCore

@Suite("Value types")
struct ValueTypeTests {
    @Test("Triple subscripts by record")
    func tripleSubscript() {
        var t = Triple(0.58, 0.92, 1.28)
        #expect(t[.r] == 0.58)
        #expect(t[.b] == 1.28)
        t[.g] = 1.0
        #expect(t.g == 1.0)
    }

    @Test("Matrix multiply matches hand calculation")
    func matrixMultiply() {
        let m = Matrix3x3(rows: (Triple(1, 2, 3), Triple(4, 5, 6), Triple(7, 8, 9)))
        let v = Triple(1, 0, -1)
        let r = m * v
        #expect(r.r == -2)   // 1*1 + 2*0 + 3*(-1)
        #expect(r.g == -2)   // 4 - 6
        #expect(r.b == -2)   // 7 - 9
    }

    @Test("Identity is identity")
    func identity() {
        let v = Triple(0.1, 0.2, 0.3)
        let r = Matrix3x3.identity * v
        #expect(r == v)
    }
}
```

- [ ] **Step 2: Run and verify it fails**

Run: `swift test --filter ValueTypeTests`
Expected: FAIL — "cannot find 'Triple' in scope".

- [ ] **Step 3: Implement Record and Triple**

`Sources/EmulsionCore/Domain/Record.swift`:

```swift
import Foundation

public enum Record: Int, Sendable, CaseIterable, Codable {
    case r = 0, g = 1, b = 2
}

/// A per-record value. Core's substitute for `simd_float3`; module B narrows
/// to Float at its own ABI boundary.
public struct Triple: Sendable, Hashable, Codable {
    public var r, g, b: Double

    public init(_ r: Double, _ g: Double, _ b: Double) {
        self.r = r; self.g = g; self.b = b
    }
    public init(repeating v: Double) { self.init(v, v, v) }

    public subscript(_ c: Record) -> Double {
        get { switch c { case .r: r; case .g: g; case .b: b } }
        set { switch c { case .r: r = newValue; case .g: g = newValue; case .b: b = newValue } }
    }

    public func map(_ f: (Double) -> Double) -> Triple { Triple(f(r), f(g), f(b)) }

    public static func + (a: Triple, b: Triple) -> Triple { Triple(a.r + b.r, a.g + b.g, a.b + b.b) }
    public static func - (a: Triple, b: Triple) -> Triple { Triple(a.r - b.r, a.g - b.g, a.b - b.b) }
    public static func * (a: Triple, s: Double) -> Triple { Triple(a.r * s, a.g * s, a.b * s) }
    public static func * (a: Triple, b: Triple) -> Triple { Triple(a.r * b.r, a.g * b.g, a.b * b.b) }
    public static func / (a: Triple, b: Triple) -> Triple { Triple(a.r / b.r, a.g / b.g, a.b / b.b) }

    public var sum: Double { r + g + b }
    public var isFinite: Bool { r.isFinite && g.isFinite && b.isFinite }
}
```

- [ ] **Step 4: Implement Matrix3x3**

`Sources/EmulsionCore/Support/Matrix3x3.swift`:

```swift
import Foundation

public struct Matrix3x3: Sendable, Hashable, Codable {
    public var row0, row1, row2: Triple

    public init(rows: (Triple, Triple, Triple)) {
        row0 = rows.0; row1 = rows.1; row2 = rows.2
    }

    public static let identity = Matrix3x3(rows: (
        Triple(1, 0, 0), Triple(0, 1, 0), Triple(0, 0, 1)
    ))

    public static func * (m: Matrix3x3, v: Triple) -> Triple {
        Triple((m.row0 * v).sum, (m.row1 * v).sum, (m.row2 * v).sum)
    }

    /// Scales off-diagonal terms only. Used by the saturation-density control
    /// and by per-print-stock crosstalk variation.
    public func scalingOffDiagonal(by s: Double) -> Matrix3x3 {
        Matrix3x3(rows: (
            Triple(row0.r, row0.g * s, row0.b * s),
            Triple(row1.r * s, row1.g, row1.b * s),
            Triple(row2.r * s, row2.g * s, row2.b)
        ))
    }
}
```

- [ ] **Step 5: Run and verify pass, then commit**

Run: `swift test --filter ValueTypeTests` — Expected: PASS, 3 tests.

```bash
git add EmulsionCore/Sources/EmulsionCore/Domain/Record.swift \
        EmulsionCore/Sources/EmulsionCore/Support/Matrix3x3.swift \
        EmulsionCore/Tests/EmulsionCoreTests/ValueTypeTests.swift
git commit -m "feat(core): Record, Triple, Matrix3x3 value types"
```

---

### Task 3: CurveParameters and the well-formedness validator

**Files:**
- Create: `EmulsionCore/Sources/EmulsionCore/Profiles/CurveParameters.swift`
- Create: `EmulsionCore/Sources/EmulsionCore/Support/EmulsionError.swift`
- Test: `EmulsionCore/Tests/EmulsionCoreTests/CurveParameterTests.swift`

**Interfaces:**
- Consumes: `Triple`, `Record`.
- Produces: `CurveParameters` (fields `dMin, deltaD, gamma, x0, kappaT, kappaS, maskDepletion, balanceShift: Triple`; `isWellFormed: Bool`; `wellFormednessMargin(_:) -> Double`; `validate(id:) throws`), `EmulsionError`.

- [ ] **Step 1: Write the failing test**

```swift
import Testing
@testable import EmulsionCore

@Suite("CurveParameters")
struct CurveParameterTests {
    /// Portra 400-type green record, Appendix A Table XL.
    static let portra400 = CurveParameters(
        dMin: Triple(0.58, 0.92, 1.28),
        deltaD: Triple(1.95, 1.90, 1.85),
        gamma: Triple(0.61, 0.63, 0.66),
        x0: Triple(-2.76, -2.71, -2.66),
        kappaT: Triple(0.150, 0.140, 0.130),
        kappaS: Triple(0.120, 0.110, 0.110),
        maskDepletion: Triple(0.00, 0.06, 0.10),
        balanceShift: Triple(0, 0, 0))

    @Test("A shipping profile is well formed")
    func shippingProfileValid() {
        #expect(Self.portra400.isWellFormed)
    }

    @Test("Margin is deltaD - 4(kt+ks)")
    func margin() {
        // green: 1.90 - 4*(0.140+0.110) = 0.90
        #expect(abs(Self.portra400.wellFormednessMargin(.g) - 0.90) < 1e-12)
    }

    @Test("Reversal gamma is tested on magnitude")
    func reversalUsesMagnitude() {
        let velvia = CurveParameters(
            dMin: Triple(0.11, 0.10, 0.12), deltaD: Triple(3.14, 3.10, 3.03),
            gamma: Triple(-2.01, -1.95, -1.87), x0: Triple(-1.83, -1.80, -1.76),
            kappaT: Triple(0.098, 0.090, 0.084), kappaS: Triple(0.146, 0.140, 0.136),
            maskDepletion: Triple(0, 0, 0), balanceShift: Triple(0, 0, 0))
        #expect(velvia.isWellFormed)
    }

    @Test("Violating deltaD >= 4(kt+ks) throws")
    func malformedThrows() {
        let bad = CurveParameters(
            dMin: Triple(repeating: 0.1), deltaD: Triple(repeating: 0.5),
            gamma: Triple(repeating: 0.6), x0: Triple(repeating: -2.0),
            kappaT: Triple(repeating: 0.2), kappaS: Triple(repeating: 0.2),
            maskDepletion: Triple(repeating: 0), balanceShift: Triple(repeating: 0))
        #expect(!bad.isWellFormed)
        #expect(throws: EmulsionError.self) { try bad.validate(id: "test.bad") }
    }
}
```

- [ ] **Step 2: Run and verify it fails**

Run: `swift test --filter CurveParameterTests`
Expected: FAIL — "cannot find 'CurveParameters' in scope".

- [ ] **Step 3: Implement EmulsionError**

`Sources/EmulsionCore/Support/EmulsionError.swift`:

```swift
import Foundation

public enum EmulsionError: Error, Sendable, Equatable {
    case profileInvalid(id: String, reason: String)
    case profileMissing(id: String, version: Int?)
    case aimBalanceDiverged(negative: String, print: String)
    case resourceUnreadable(name: String)
}

extension EmulsionError: CustomStringConvertible {
    public var description: String {
        switch self {
        case let .profileInvalid(id, reason):   "profile '\(id)' invalid: \(reason)"
        case let .profileMissing(id, version):  "profile '\(id)' v\(version.map(String.init) ?? "current") not found"
        case let .aimBalanceDiverged(n, p):     "aim balance did not converge for (\(n), \(p))"
        case let .resourceUnreadable(name):     "bundled resource '\(name)' unreadable"
        }
    }
}
```

- [ ] **Step 4: Implement CurveParameters**

`Sources/EmulsionCore/Profiles/CurveParameters.swift`:

```swift
import Foundation

/// Per-record parameters of the softplus density model.
/// Reversal stocks carry `gamma < 0`; the equations are otherwise unchanged.
public struct CurveParameters: Sendable, Hashable, Codable {
    public var dMin, deltaD, gamma, x0, kappaT, kappaS: Triple
    public var maskDepletion: Triple
    public var balanceShift: Triple

    public init(dMin: Triple, deltaD: Triple, gamma: Triple, x0: Triple,
                kappaT: Triple, kappaS: Triple,
                maskDepletion: Triple, balanceShift: Triple) {
        self.dMin = dMin; self.deltaD = deltaD; self.gamma = gamma; self.x0 = x0
        self.kappaT = kappaT; self.kappaS = kappaS
        self.maskDepletion = maskDepletion; self.balanceShift = balanceShift
    }

    /// deltaD - 4(kappaT + kappaS). The engineering constraint, not the weaker
    /// sufficient condition; it also guarantees a straight-line region.
    public func wellFormednessMargin(_ c: Record) -> Double {
        deltaD[c] - 4 * (kappaT[c] + kappaS[c])
    }

    public var isWellFormed: Bool {
        Record.allCases.allSatisfy { c in
            deltaD[c] > 0
                && abs(gamma[c]) > 0
                && kappaT[c] >= Math.minSoftness
                && kappaS[c] >= Math.minSoftness
                && wellFormednessMargin(c) >= 0
        }
    }

    public func validate(id: String) throws {
        for c in Record.allCases {
            guard deltaD[c] > 0 else {
                throw EmulsionError.profileInvalid(id: id, reason: "deltaD <= 0 on \(c)")
            }
            guard abs(gamma[c]) > 0 else {
                throw EmulsionError.profileInvalid(id: id, reason: "gamma == 0 on \(c)")
            }
            guard kappaT[c] >= Math.minSoftness, kappaS[c] >= Math.minSoftness else {
                throw EmulsionError.profileInvalid(id: id, reason: "softness below floor on \(c)")
            }
            guard wellFormednessMargin(c) >= 0 else {
                throw EmulsionError.profileInvalid(
                    id: id,
                    reason: "deltaD \(deltaD[c]) < 4(kt+ks) on \(c)")
            }
        }
    }
}
```

- [ ] **Step 5: Run, verify pass, commit**

Run: `swift test --filter CurveParameterTests` — Expected: PASS, 4 tests.

```bash
git add EmulsionCore/Sources/EmulsionCore/Profiles/CurveParameters.swift \
        EmulsionCore/Sources/EmulsionCore/Support/EmulsionError.swift \
        EmulsionCore/Tests/EmulsionCoreTests/CurveParameterTests.swift
git commit -m "feat(core): CurveParameters with well-formedness validation"
```

---

### Task 4: The characteristic curve

**Files:**
- Create: `EmulsionCore/Sources/EmulsionCore/Imaging/CharacteristicCurve.swift`
- Test: `EmulsionCore/Tests/EmulsionCoreTests/CharacteristicCurveTests.swift`

**Interfaces:**
- Consumes: `CurveParameters`, `Math`, `Triple`, `Record`.
- Produces: `CharacteristicCurve.density(logE:_:_:) -> Double`, `.pointGamma(logE:_:_:) -> Double`, `.densityTriple(logE:_:) -> Triple`, `.densityWithMask(logE:_:) -> Triple`.

- [ ] **Step 1: Write the failing test**

```swift
import Testing
import Foundation
@testable import EmulsionCore

@Suite("Characteristic curve")
struct CharacteristicCurveTests {
    let p = CurveParameterTests.portra400

    @Test("Density approaches dMin far below the toe")
    func toeAsymptote() {
        let d = CharacteristicCurve.density(logE: -8.0, p, .g)
        #expect(abs(d - p.dMin.g) < 1e-6)
    }

    @Test("Density approaches dMax far above the shoulder")
    func shoulderAsymptote() {
        let d = CharacteristicCurve.density(logE: 8.0, p, .g)
        #expect(abs(d - (p.dMin.g + p.deltaD.g)) < 0.02)
    }

    @Test("Straight line has slope gamma")
    func straightLineSlope() {
        // Midpoint of the straight line: u = deltaD/2
        let xMid = p.x0.g + (p.deltaD.g / 2) / p.gamma.g
        let g = CharacteristicCurve.pointGamma(logE: xMid, p, .g)
        #expect(abs(g - p.gamma.g) < 0.01)
    }

    @Test("Analytic derivative matches central difference")
    func derivativeMatchesNumeric() {
        let h = 1e-6
        for c in Record.allCases {
            for x in stride(from: -5.0, through: 3.0, by: 0.05) {
                let numeric = (CharacteristicCurve.density(logE: x + h, p, c)
                             - CharacteristicCurve.density(logE: x - h, p, c)) / (2 * h)
                let analytic = CharacteristicCurve.pointGamma(logE: x, p, c)
                #expect(abs(numeric - analytic) < 1e-6)
            }
        }
    }

    @Test("Curve is monotonically non-decreasing for negative stocks")
    func monotone() {
        for c in Record.allCases {
            var previous = -Double.infinity
            for x in stride(from: -5.0, through: 3.0, by: 0.01) {
                let d = CharacteristicCurve.density(logE: x, p, c)
                #expect(d >= previous - 1e-12)
                previous = d
            }
        }
    }
}
```

- [ ] **Step 2: Run and verify it fails**

Run: `swift test --filter CharacteristicCurveTests`
Expected: FAIL — "cannot find 'CharacteristicCurve' in scope".

- [ ] **Step 3: Implement**

`Sources/EmulsionCore/Imaging/CharacteristicCurve.swift`:

```swift
import Foundation

public enum CharacteristicCurve {
    /// Straight-line coordinate u = gamma * (x - x0).
    @inline(__always)
    static func u(logE x: Double, _ p: CurveParameters, _ c: Record) -> Double {
        p.gamma[c] * (x - p.x0[c])
    }

    /// D(x) = dMin + sp_kt(u) - sp_ks(u - deltaD).
    public static func density(logE x: Double, _ p: CurveParameters, _ c: Record) -> Double {
        let uu = u(logE: x, p, c)
        return p.dMin[c]
            + Math.softplus(uu, p.kappaT[c])
            - Math.softplus(uu - p.deltaD[c], p.kappaS[c])
    }

    /// Point gamma: the closed-form derivative dD/dx, consumed by the grain and
    /// interlayer models in module B and by the printer-light sensitivity.
    public static func pointGamma(logE x: Double, _ p: CurveParameters, _ c: Record) -> Double {
        let uu = u(logE: x, p, c)
        let toe = Math.logistic(uu / max(p.kappaT[c], Math.minSoftness))
        let shoulder = Math.logistic((uu - p.deltaD[c]) / max(p.kappaS[c], Math.minSoftness))
        return p.gamma[c] * (toe - shoulder)
    }

    public static func densityTriple(logE x: Triple, _ p: CurveParameters) -> Triple {
        Triple(density(logE: x.r, p, .r),
               density(logE: x.g, p, .g),
               density(logE: x.b, p, .b))
    }

    /// Density with orange-mask depletion applied as a single fixed-point
    /// iteration. The correction is small and one pass is below AC-1 tolerance.
    public static func densityWithMask(logE x: Triple, _ p: CurveParameters) -> Triple {
        let first = densityTriple(logE: x, p)
        var adjusted = p
        for c in Record.allCases {
            let fraction = (first[c] - p.dMin[c]) / p.deltaD[c]
            adjusted.dMin[c] = p.dMin[c] - p.maskDepletion[c] * fraction
        }
        return densityTriple(logE: x, adjusted)
    }
}
```

- [ ] **Step 4: Run and verify pass**

Run: `swift test --filter CharacteristicCurveTests`
Expected: PASS, 5 tests. The derivative test evaluates 161 points × 3 records; if it fails at the extremes, the softplus stability guard in Task 1 is wrong.

- [ ] **Step 5: Commit**

```bash
git add EmulsionCore/Sources/EmulsionCore/Imaging/CharacteristicCurve.swift \
        EmulsionCore/Tests/EmulsionCoreTests/CharacteristicCurveTests.swift
git commit -m "feat(core): characteristic curve with closed-form point gamma"
```

---

### Task 5: Sensitometric diagnostics

**Files:**
- Create: `EmulsionCore/Sources/EmulsionCore/Sensitometry/Sensitometry.swift`
- Test: `EmulsionCore/Tests/EmulsionCoreTests/SensitometryTests.swift`

**Interfaces:**
- Consumes: `CharacteristicCurve`, `CurveParameters`.
- Produces: `Sensitometry.speedPoint(_:_:) -> Double`, `.isoSpeed(_:) -> Double`, `.contrastIndex(_:_:) -> Double`, `.latitude(_:_:fraction:) -> Double`.

**Note for the implementer:** the speed-point offset is `u*/gamma`, and dividing by a negative gamma flips the sign automatically. Reversal stocks therefore need no branch here — contrary to the spec's phrasing "flips its offset term," which describes the effect rather than the mechanism. Record this in Task 14.

- [ ] **Step 1: Write the failing test**

```swift
import Testing
import Foundation
@testable import EmulsionCore

@Suite("Sensitometry")
struct SensitometryTests {
    let p = CurveParameterTests.portra400

    @Test("Speed point inverts the curve (V-07)")
    func speedPointInverts() {
        for c in Record.allCases {
            let xsp = Sensitometry.speedPoint(p, c)
            let d = CharacteristicCurve.density(logE: xsp, p, c)
            #expect(abs(d - (p.dMin[c] + 0.10)) < 1e-4)
        }
    }

    @Test("ISO speed recovers the rated speed")
    func isoRoundTrip() {
        // Appendix A sets x0 from rated ISO via S = 0.8 / 10^x_sp.
        let s = Sensitometry.isoSpeed(p)
        #expect(abs(s - 400) / 400 < 0.02)
    }

    @Test("Contrast index lands in the paper's colour-negative band")
    func contrastIndexBand() {
        let ci = Sensitometry.contrastIndex(p, .g)
        #expect(ci >= 0.55 && ci <= 0.62)
    }

    @Test("Latitude is reported in stops and is plausible")
    func latitude() {
        let l = Sensitometry.latitude(p, .g, fraction: 0.5)
        #expect(l > 8 && l < 20)
    }
}
```

- [ ] **Step 2: Run and verify it fails**

Run: `swift test --filter SensitometryTests`
Expected: FAIL — "cannot find 'Sensitometry' in scope".

- [ ] **Step 3: Implement**

`Sources/EmulsionCore/Sensitometry/Sensitometry.swift`:

```swift
import Foundation

public enum Sensitometry {
    /// Log exposure producing dMin + 0.10. Exact inversion of the toe branch;
    /// the shoulder term is negligible at this density.
    public static func speedPoint(_ p: CurveParameters, _ c: Record) -> Double {
        let kt = max(p.kappaT[c], Math.minSoftness)
        let uStar = kt * log(expm1(0.10 / kt))
        return p.x0[c] + uStar / p.gamma[c]
    }

    /// Arithmetic ISO speed from the green record: S = 0.8 / 10^x_sp.
    public static func isoSpeed(_ p: CurveParameters) -> Double {
        0.8 / pow(10.0, speedPoint(p, .g))
    }

    /// Slope of the chord from the speed point to a point 2.00 higher.
    public static func contrastIndex(_ p: CurveParameters, _ c: Record) -> Double {
        let xsp = speedPoint(p, c)
        let dLo = CharacteristicCurve.density(logE: xsp, p, c)
        let dHi = CharacteristicCurve.density(logE: xsp + 2.00, p, c)
        return (dHi - dLo) / 2.00
    }

    /// Interval over which point gamma exceeds `fraction` of its maximum,
    /// reported in stops. Sampled then bisected — the analytic bracket is the
    /// straight line, and two bisection passes are well inside tolerance.
    public static func latitude(_ p: CurveParameters, _ c: Record,
                                fraction: Double = 0.5) -> Double {
        let peak = abs(p.gamma[c])
        let threshold = fraction * peak
        var lo: Double? = nil, hi: Double? = nil
        for x in stride(from: -6.0, through: 4.0, by: 0.005) {
            if abs(pointGammaMagnitude(x, p, c)) >= threshold {
                if lo == nil { lo = x }
                hi = x
            }
        }
        guard let l = lo, let h = hi else { return 0 }
        return (h - l) / log10(2.0)
    }

    private static func pointGammaMagnitude(_ x: Double, _ p: CurveParameters,
                                            _ c: Record) -> Double {
        abs(CharacteristicCurve.pointGamma(logE: x, p, c))
    }
}
```

- [ ] **Step 4: Run and verify pass**

Run: `swift test --filter SensitometryTests`
Expected: PASS, 4 tests. If `isoRoundTrip` fails, Appendix A's x₀ values and this formula disagree — record it (Task 14) before adjusting either.

- [ ] **Step 5: Commit**

```bash
git add EmulsionCore/Sources/EmulsionCore/Sensitometry/Sensitometry.swift \
        EmulsionCore/Tests/EmulsionCoreTests/SensitometryTests.swift
git commit -m "feat(core): sensitometric diagnostics"
```

---

### Task 6: Chemistry profiles and development modulation

**Files:**
- Create: `EmulsionCore/Sources/EmulsionCore/Profiles/ChemistryProfile.swift`
- Create: `EmulsionCore/Sources/EmulsionCore/Imaging/Development.swift`
- Create: `EmulsionCore/Sources/EmulsionCore/Domain/DevelopStage.swift`
- Test: `EmulsionCore/Tests/EmulsionCoreTests/DevelopmentTests.swift`

**Interfaces:**
- Consumes: `CurveParameters`, `Triple`.
- Produces: `ChemistryProfile`, `DevelopStage`, `Development.activity(_:_:) -> Double`, `.modulate(_:activity:chemistry:) -> CurveParameters`, `.agitationEfficiency(_:_:) -> Double`.

- [ ] **Step 1: Write the failing test — Table VIII as a fixture**

```swift
import Testing
import Foundation
@testable import EmulsionCore

@Suite("Development")
struct DevelopmentTests {
    static let c41 = ChemistryProfile(
        id: "chem.c41", gammaInfinityRatio: 1.60, phi0: 0.045, betaFog: 2.1,
        alphaSpeed: 0.35, rhoPerStop: 1.35, tauToe: 0.30, tauRange: 0.12,
        fogPerRecord: Triple(0.82, 1.00, 1.34),
        referenceTimeSeconds: 195, referenceTemperatureK: 311.15,
        activationEnergyOverR: 8.4e3, perChannelActivity: Triple(1, 1, 1))

    @Test("Normal process is activity 1.0")
    func normalIsUnity() {
        let stage = DevelopStage()   // defaults: normal process
        let a = Development.activity(stage, Self.c41)
        #expect(abs(a - 1.0) < 1e-6)
    }

    @Test("Agitation efficiency is normalised to 1 at the recommended scheme")
    func agitationNormalised() {
        #expect(abs(Development.agitationEfficiency(1.0, Self.c41) - 1.0) < 1e-9)
    }

    @Test("Push of n stops multiplies activity by rho^n")
    func pushMultipliesActivity() {
        var stage = DevelopStage(); stage.pushPull = 1.0
        #expect(abs(Development.activity(stage, Self.c41) - 1.35) < 1e-6)
    }

    @Test("Gamma at normal process returns the nominal gamma")
    func gammaAtUnity() {
        let p = CurveParameterTests.portra400
        let m = Development.modulate(p, activity: 1.0, chemistry: Self.c41)
        #expect(abs(m.gamma.g - p.gamma.g) < 1e-9)
    }

    /// Table VIII, "Modelled Push/Pull Response, Typical Color Negative".
    /// Tolerance is one unit in the table's last printed digit.
    ///
    /// KNOWN RISK (A-03): a hand check of Push 1 gives gamma = 0.716 from the
    /// equations against 0.69 printed. If this fails, do NOT loosen the
    /// tolerance — record the discrepancy per Task 14 and reconcile the paper.
    @Test("Reproduces Table VIII push/pull response", arguments: [
        (stops: -2.0, activity: 0.55, gamma: 0.44),
        (stops: -1.0, activity: 0.74, gamma: 0.53),
        (stops:  0.0, activity: 1.00, gamma: 0.61),
        (stops:  1.0, activity: 1.35, gamma: 0.69),
        (stops:  2.0, activity: 1.82, gamma: 0.77),
        (stops:  3.0, activity: 2.46, gamma: 0.83),
    ])
    func tableVIII(row: (stops: Double, activity: Double, gamma: Double)) {
        var stage = DevelopStage(); stage.pushPull = row.stops
        let a = Development.activity(stage, Self.c41)
        #expect(abs(a - row.activity) < 0.01)

        let m = Development.modulate(CurveParameterTests.portra400,
                                     activity: a, chemistry: Self.c41)
        #expect(abs(m.gamma.g - row.gamma) < 0.01)
    }
}
```

- [ ] **Step 2: Run and verify it fails**

Run: `swift test --filter DevelopmentTests`
Expected: FAIL — "cannot find 'ChemistryProfile' in scope".

- [ ] **Step 3: Implement ChemistryProfile and DevelopStage**

`Sources/EmulsionCore/Profiles/ChemistryProfile.swift`:

```swift
import Foundation

public struct ChemistryProfile: Sendable, Hashable, Codable {
    public var id: String
    public var gammaInfinityRatio: Double     // gamma_inf / gamma_0
    public var phi0: Double                   // fog magnitude
    public var betaFog: Double                // fog exponent
    public var alphaSpeed: Double             // speed recovery coefficient
    public var rhoPerStop: Double             // activity multiplier per push stop
    public var tauToe: Double                 // toe softness drift
    public var tauRange: Double               // density range drift
    public var fogPerRecord: Triple           // per-layer fog scaling
    public var referenceTimeSeconds: Double
    public var referenceTemperatureK: Double
    public var activationEnergyOverR: Double  // Ea/R, kelvin
    public var perChannelActivity: Triple     // cross-processing efficiency

    // Agitation efficiency constants, family-wide.
    public var etaInfinity: Double = 1.22
    public var eta0: Double = 0.61
    public var etaScale: Double = 0.85
}
```

`Sources/EmulsionCore/Domain/DevelopStage.swift`:

```swift
import Foundation

public struct DevelopStage: Sendable, Hashable, Codable {
    public var pushPull: Double = 0.0            // stops, positive is push
    public var timeSeconds: Double? = nil        // nil means the chemistry reference
    public var temperatureK: Double? = nil       // nil means the chemistry reference
    public var agitation: Double = 1.0           // 1.0 is the recommended scheme
    public var developerConcentration: Double = 1.0

    public init() {}
}
```

- [ ] **Step 4: Implement Development**

`Sources/EmulsionCore/Imaging/Development.swift`:

```swift
import Foundation

public enum Development {
    /// Saturating agitation efficiency, normalised so eta(1) == 1.
    public static func agitationEfficiency(_ ag: Double, _ chem: ChemistryProfile) -> Double {
        func raw(_ a: Double) -> Double {
            chem.etaInfinity - (chem.etaInfinity - chem.eta0) * exp(-a / chem.etaScale)
        }
        return raw(ag) / raw(1.0)
    }

    /// Collapses time, temperature, agitation, concentration and push into a
    /// single activity scalar. A == 1 is the manufacturer's normal process.
    public static func activity(_ d: DevelopStage, _ chem: ChemistryProfile) -> Double {
        let t = d.timeSeconds ?? chem.referenceTimeSeconds
        let T = d.temperatureK ?? chem.referenceTemperatureK
        let arrhenius = exp(chem.activationEnergyOverR
                            * (1.0 / chem.referenceTemperatureK - 1.0 / T))
        let base = (t / chem.referenceTimeSeconds)
            * arrhenius
            * agitationEfficiency(d.agitation, chem)
            * d.developerConcentration
        return base * pow(chem.rhoPerStop, d.pushPull)
    }

    /// Reshapes the curve. Host-side only — costs no GPU instruction.
    public static func modulate(_ curve: CurveParameters, activity A: Double,
                                chemistry chem: ChemistryProfile) -> CurveParameters {
        var out = curve
        let logA = log(max(A, 1e-6))
        let log10A = log10(max(A, 1e-6))

        for c in Record.allCases {
            // Gamma: saturating, gamma(1) == nominal by construction of aGamma.
            let gammaInf = curve.gamma[c] * chem.gammaInfinityRatio
            let ratio = gammaInf / (gammaInf - curve.gamma[c])
            let aGamma = 1.0 / log(ratio)
            out.gamma[c] = gammaInf * (1 - exp(-A / aGamma))

            // Fog: rises without saturation, blue layer fastest.
            let phi = chem.phi0 * chem.fogPerRecord[c]
            out.dMin[c] = curve.dMin[c] + phi * (pow(A, chem.betaFog) - 1)

            // Speed: recovers only a fraction of the nominal push.
            out.x0[c] = curve.x0[c] - chem.alphaSpeed * log10A

            // Toe and range drift.
            out.kappaT[c] = curve.kappaT[c] * (1 + chem.tauToe * logA)
            out.deltaD[c] = curve.deltaD[c] * (1 + chem.tauRange * logA)
        }
        return out
    }
}
```

- [ ] **Step 5: Run the tests**

Run: `swift test --filter DevelopmentTests`
Expected: 4 tests PASS. `tableVIII` may FAIL on the gamma column — that is the predicted A-03 finding. Do not adjust the tolerance. Record the measured values and proceed; Task 14 reconciles it.

- [ ] **Step 6: Commit**

```bash
git add EmulsionCore/Sources/EmulsionCore/Profiles/ChemistryProfile.swift \
        EmulsionCore/Sources/EmulsionCore/Imaging/Development.swift \
        EmulsionCore/Sources/EmulsionCore/Domain/DevelopStage.swift \
        EmulsionCore/Tests/EmulsionCoreTests/DevelopmentTests.swift
git commit -m "feat(core): chemistry profiles and development modulation"
```

---

### Task 7: Domain model — stages, ParameterKey, Recipe

**Files:**
- Create: `EmulsionCore/Sources/EmulsionCore/Domain/FilmFormat.swift`
- Create: `EmulsionCore/Sources/EmulsionCore/Domain/StockRef.swift`
- Create: `EmulsionCore/Sources/EmulsionCore/Domain/Stages.swift`
- Create: `EmulsionCore/Sources/EmulsionCore/Domain/ParameterKey.swift`
- Create: `EmulsionCore/Sources/EmulsionCore/Domain/Recipe.swift`
- Test: `EmulsionCore/Tests/EmulsionCoreTests/RecipeTests.swift`

**Interfaces:**
- Consumes: `Triple`, `DevelopStage`.
- Produces: `FilmFormat` (with `frameWidthMM`), `StockRef`, `CaptureStage`, `PrintStage`, `InterlayerStage`, `GrainStage`, `HalationStage`, `OpticalStage`, `AgingStage`, `OutputStage`, `ParameterKey`, `Recipe` (with `canonicalJSON()`, `contentHash`).

- [ ] **Step 1: Write the failing test**

```swift
import Testing
import Foundation
@testable import EmulsionCore

@Suite("Recipe")
struct RecipeTests {
    @Test("Frame widths match the paper's format table")
    func frameWidths() {
        #expect(FilmFormat.format135.frameWidthMM == 36.0)
        #expect(FilmFormat.super35.frameWidthMM == 24.9)
        #expect(FilmFormat.super16.frameWidthMM == 12.5)
        #expect(FilmFormat.format45.frameWidthMM == 102.0)
    }

    @Test("Canonical JSON is stable across encodings")
    func canonicalStable() throws {
        let r = Recipe(negativeStock: StockRef(id: "neg.portra400", version: 3),
                       printStock: StockRef(id: "prt.2383", version: 2),
                       chemistry: StockRef(id: "chem.c41", version: 1))
        let a = try r.canonicalJSON()
        let b = try r.canonicalJSON()
        #expect(a == b)
    }

    @Test("Equal recipes hash equally, different ones do not")
    func hashDiscriminates() throws {
        var a = Recipe(negativeStock: StockRef(id: "neg.portra400", version: 3),
                       printStock: StockRef(id: "prt.2383", version: 2),
                       chemistry: StockRef(id: "chem.c41", version: 1))
        let b = a
        #expect(try a.contentHash() == (try b.contentHash()))
        a.printing.printerLightR = 27
        #expect(try a.contentHash() != (try b.contentHash()))
    }

    @Test("Printer lights are integers within one stop")
    func printerLightRange() {
        var s = PrintStage()
        s.printerLightR = 40
        #expect(s.clamped().printerLightR == 12)
        s.printerLightR = -40
        #expect(s.clamped().printerLightR == -12)
    }
}
```

- [ ] **Step 2: Run and verify it fails**

Run: `swift test --filter RecipeTests`
Expected: FAIL — "cannot find 'FilmFormat' in scope".

- [ ] **Step 3: Implement formats, refs and stages**

`Sources/EmulsionCore/Domain/FilmFormat.swift`:

```swift
import Foundation

public enum FilmFormat: String, Sendable, Codable, CaseIterable {
    case format135, format645, format66, format45
    case super35, super16, standard8

    /// Simulated frame width in millimetres. Drives every physical scaling.
    public var frameWidthMM: Double {
        switch self {
        case .format135: 36.0
        case .format645: 56.0
        case .format66:  56.0
        case .format45:  102.0
        case .super35:   24.9
        case .super16:   12.5
        case .standard8: 10.3
        }
    }
}
```

`Sources/EmulsionCore/Domain/StockRef.swift`:

```swift
import Foundation

public struct StockRef: Sendable, Hashable, Codable {
    public var id: String
    public var version: Int
    public init(id: String, version: Int) { self.id = id; self.version = version }
}
```

`Sources/EmulsionCore/Domain/Stages.swift`:

```swift
import Foundation

public struct CaptureStage: Sendable, Hashable, Codable {
    public var exposureCompensation: Double = 0.0   // stops
    public var filmSpeedOverride: Double? = nil     // shoot at a different EI
    public var whiteBalanceTempK: Double = 5500
    public var whiteBalanceTint: Double = 0.0
    public init() {}
}

public struct PrintStage: Sendable, Hashable, Codable {
    public var printerLightR: Int = 0               // printer points
    public var printerLightG: Int = 0
    public var printerLightB: Int = 0
    public var printDensity: Int = 0                // master, +/- 24
    public var saturationDensity: Double = 1.0
    public var highlightRolloff: Double = 1.0       // multiplier on print kappaT
    public var shadowLift: Double = 0.0             // reduces print dMax
    public var neutralAxisWarm: Double = 0.0        // delta_RG
    public var neutralAxisTint: Double = 0.0        // delta_BG
    public var silverRetention: Double = 0.0        // rho, 0...1
    public init() {}

    public func clamped() -> PrintStage {
        var s = self
        s.printerLightR = min(max(s.printerLightR, -12), 12)
        s.printerLightG = min(max(s.printerLightG, -12), 12)
        s.printerLightB = min(max(s.printerLightB, -12), 12)
        s.printDensity  = min(max(s.printDensity, -24), 24)
        s.silverRetention = min(max(s.silverRetention, 0), 1)
        return s
    }
}

/// Carried for module B; not evaluated in Core.
public struct InterlayerStage: Sendable, Hashable, Codable {
    public var couplerActivity: Double = 1.0
    public init() {}
}
public struct GrainStage: Sendable, Hashable, Codable {
    public var amount: Double = 1.0
    public init() {}
}
public struct HalationStage: Sendable, Hashable, Codable {
    public var intensity: Double? = nil             // nil means the stock default
    public init() {}
}
public struct OpticalStage: Sendable, Hashable, Codable {
    public var vignetteAmount: Double = 0.0
    public var diffusionAmount: Double = 0.0
    public init() {}
}
public struct AgingStage: Sendable, Hashable, Codable {
    public var dustDensity: Double = 0.0
    public var scratchDensity: Double = 0.0
    public init() {}
}

public struct OutputStage: Sendable, Hashable, Codable {
    public var surroundExponent: Double = 1.0       // 0.9 for dark-surround
    public init() {}
}
```

- [ ] **Step 4: Implement ParameterKey and Recipe**

`Sources/EmulsionCore/Domain/ParameterKey.swift`:

```swift
import Foundation

/// Stable identity for every scalar the pipeline consumes.
/// ADDITIVE ONLY: raw values appear in persisted recipes and sidecars, so a
/// removed case silently drops a user's setting.
public enum ParameterKey: String, Sendable, Codable, CaseIterable {
    case exposureCompensation, filmSpeed, whiteBalanceTemp, whiteBalanceTint
    case pushPull, developmentTime, developmentTemp, agitation
    case couplerActivity
    case printerLightR, printerLightG, printerLightB, printDensity
    case saturationDensity, highlightRolloff, shadowLift
    case neutralAxisWarm, neutralAxisTint, silverRetention
    case grainAmount
    case halationIntensity
    case diffusionAmount, vignetteAmount
    case dustDensity, scratchDensity
    case surroundExponent
}
```

`Sources/EmulsionCore/Domain/Recipe.swift`:

```swift
import Foundation

public struct Recipe: Sendable, Hashable, Codable {
    public var negativeStock: StockRef
    public var printStock: StockRef
    public var chemistry: StockRef

    public var capture = CaptureStage()
    public var develop = DevelopStage()
    public var interlayer = InterlayerStage()
    public var printing = PrintStage()
    public var grain = GrainStage()
    public var halation = HalationStage()
    public var optical = OpticalStage()
    public var aging = AgingStage()
    public var output = OutputStage()

    public var format: FilmFormat = .format135
    public var seed: UInt32 = 0

    public init(negativeStock: StockRef, printStock: StockRef, chemistry: StockRef) {
        self.negativeStock = negativeStock
        self.printStock = printStock
        self.chemistry = chemistry
    }

    /// Sorted keys and fixed formatting, so two recipes that render identically
    /// serialise identically.
    public func canonicalJSON() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }

    /// FNV-1a over the canonical bytes. Core has no CryptoKit (Foundation only);
    /// module C rehashes with SHA-256 where a cache key needs collision
    /// resistance against adversarial input, which this does not.
    public func contentHash() throws -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in try canonicalJSON() {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01B3
        }
        return String(hash, radix: 16)
    }
}
```

- [ ] **Step 5: Run, verify pass, commit**

Run: `swift test --filter RecipeTests` — Expected: PASS, 4 tests.

```bash
git add EmulsionCore/Sources/EmulsionCore/Domain
git add EmulsionCore/Tests/EmulsionCoreTests/RecipeTests.swift
git commit -m "feat(core): domain model, parameter keys, canonical recipe hashing"
```

---

### Task 8: Stock profiles — schema, decoder, resources

**Files:**
- Create: `EmulsionCore/Sources/EmulsionCore/Profiles/StockProfile.swift`
- Create: `EmulsionCore/Sources/EmulsionCore/Profiles/ProfileDecoder.swift`
- Create: `EmulsionCore/Sources/EmulsionCore/Profiles/ProfileStore.swift`
- Create: `EmulsionCore/Sources/EmulsionCore/Resources/profiles/*.json` (19 files)
- Test: `EmulsionCore/Tests/EmulsionCoreTests/ProfileTests.swift`

**Interfaces:**
- Consumes: `CurveParameters`, `ChemistryProfile`, `EmulsionError`.
- Produces: `StockKind`, `FitStatus`, `StockProfile`, `ProfileDecoder.decode(data:) throws -> StockProfile`, `ProfileStore.bundled() throws -> ProfileStore`, `ProfileStore.profile(id:version:) throws -> StockProfile`, `.profiles(kind:) -> [StockProfile]`, `.chemistry(id:) throws -> ChemistryProfile`.

The JSON stores a green record plus red/blue offsets, per Appendix A. `ProfileDecoder` expands them into complete `Triple`s so the evaluation path never sees the offset encoding.

- [ ] **Step 1: Write the failing test**

```swift
import Testing
import Foundation
@testable import EmulsionCore

@Suite("Profiles")
struct ProfileTests {
    @Test("All bundled profiles decode and validate")
    func allDecode() throws {
        let store = try ProfileStore.bundled()
        #expect(store.profiles(kind: .negative).count == 10)
        #expect(store.profiles(kind: .print).count == 4)
        for p in store.profiles(kind: .negative) + store.profiles(kind: .print) {
            try p.curve.validate(id: p.id)
        }
    }

    @Test("Offsets expand into complete per-record parameters")
    func offsetsExpand() throws {
        let store = try ProfileStore.bundled()
        let p = try store.profile(id: "neg.portra400", version: nil)
        // Green from the table, red = green + offset (-0.02).
        #expect(abs(p.curve.gamma.g - 0.63) < 1e-9)
        #expect(abs(p.curve.gamma.r - 0.61) < 1e-9)
        #expect(abs(p.curve.gamma.b - 0.66) < 1e-9)
        // dMin is absolute, not an offset: the orange mask.
        #expect(abs(p.curve.dMin.r - 0.58) < 1e-9)
        #expect(abs(p.curve.dMin.b - 1.28) < 1e-9)
    }

    @Test("Every negative profile recovers its declared ISO")
    func isoRoundTripAllStocks() throws {
        let store = try ProfileStore.bundled()
        for p in store.profiles(kind: .negative) {
            guard let declared = p.iso else { continue }
            let computed = Sensitometry.isoSpeed(p.curve)
            #expect(abs(computed - declared) / declared < 0.02,
                    "\(p.id): computed \(computed) vs declared \(declared)")
        }
    }

    @Test("Colour negative stocks land in the stated CI band")
    func contrastIndexBands() throws {
        let store = try ProfileStore.bundled()
        for p in store.profiles(kind: .negative) where p.kind == .negative && p.iso != nil {
            let ci = Sensitometry.contrastIndex(p.curve, .g)
            #expect(ci > 0.30 && ci < 1.10, "\(p.id) CI \(ci) implausible")
        }
    }

    @Test("A malformed profile is rejected at decode")
    func malformedRejected() {
        let json = Data("""
        {"id":"neg.bad","profileVersion":1,"kind":"negative","displayName":"Bad",
         "fitStatus":"E","iso":100,
         "curve":{"green":{"gamma":0.6,"deltaD":0.5,"x0":-2.0,
                           "kappaT":0.2,"kappaS":0.2,"dMin":0.9},
                  "offsets":{"red":{},"blue":{}},
                  "maskDepletion":[0,0,0],"balanceShift":[0,0,0]},
         "defaultPrint":"prt.2383"}
        """.utf8)
        #expect(throws: EmulsionError.self) { try ProfileDecoder.decode(data: json) }
    }
}
```

- [ ] **Step 2: Run and verify it fails**

Run: `swift test --filter ProfileTests`
Expected: FAIL — "cannot find 'ProfileStore' in scope".

- [ ] **Step 3: Implement the profile types and decoder**

`Sources/EmulsionCore/Profiles/StockProfile.swift`:

```swift
import Foundation

public enum StockKind: String, Sendable, Codable { case negative, print, mono, chemistry }
public enum FitStatus: String, Sendable, Codable { case measured = "M", partial = "P", estimated = "E" }

public struct StockProfile: Sendable, Hashable, Codable {
    public var id: String
    public var profileVersion: Int
    public var kind: StockKind
    public var displayName: String
    public var fitStatus: FitStatus
    public var iso: Double?
    public var curve: CurveParameters
    public var crosstalk: Matrix3x3?          // print stocks only
    public var aimDensity: Triple?            // print stocks only
    public var silverRange: Double?           // deltaD'_Ag
    public var defaultPrint: String?
}
```

`Sources/EmulsionCore/Profiles/ProfileDecoder.swift`:

```swift
import Foundation

public enum ProfileDecoder {
    private struct RecordDTO: Decodable {
        var gamma, deltaD, x0, kappaT, kappaS, dMin: Double?
    }
    private struct CurveDTO: Decodable {
        var green: RecordDTO
        var offsets: Offsets
        var maskDepletion: [Double]
        var balanceShift: [Double]
        struct Offsets: Decodable { var red: RecordDTO; var blue: RecordDTO }
    }
    private struct ProfileDTO: Decodable {
        var id: String
        var profileVersion: Int
        var kind: StockKind
        var displayName: String
        var fitStatus: FitStatus
        var iso: Double?
        var curve: CurveDTO
        var crosstalk: [[Double]]?
        var aimDensity: [Double]?
        var silverRange: Double?
        var defaultPrint: String?
    }

    public static func decode(data: Data) throws -> StockProfile {
        let dto = try JSONDecoder().decode(ProfileDTO.self, from: data)
        let g = dto.curve.green
        func expand(_ o: RecordDTO, _ base: Double, _ key: KeyPath<RecordDTO, Double?>) -> Double {
            base + (o[keyPath: key] ?? 0)
        }
        let r = dto.curve.offsets.red, b = dto.curve.offsets.blue

        // dMin is absolute per record (the orange mask), not an offset.
        let dMin = Triple(r.dMin ?? g.dMin ?? 0, g.dMin ?? 0, b.dMin ?? g.dMin ?? 0)

        let curve = CurveParameters(
            dMin: dMin,
            deltaD: Triple(expand(r, g.deltaD ?? 0, \.deltaD), g.deltaD ?? 0,
                           expand(b, g.deltaD ?? 0, \.deltaD)),
            gamma: Triple(expand(r, g.gamma ?? 0, \.gamma), g.gamma ?? 0,
                          expand(b, g.gamma ?? 0, \.gamma)),
            x0: Triple(expand(r, g.x0 ?? 0, \.x0), g.x0 ?? 0, expand(b, g.x0 ?? 0, \.x0)),
            kappaT: Triple(expand(r, g.kappaT ?? 0, \.kappaT), g.kappaT ?? 0,
                           expand(b, g.kappaT ?? 0, \.kappaT)),
            kappaS: Triple(expand(r, g.kappaS ?? 0, \.kappaS), g.kappaS ?? 0,
                           expand(b, g.kappaS ?? 0, \.kappaS)),
            maskDepletion: Triple(dto.curve.maskDepletion[0], dto.curve.maskDepletion[1],
                                  dto.curve.maskDepletion[2]),
            balanceShift: Triple(dto.curve.balanceShift[0], dto.curve.balanceShift[1],
                                 dto.curve.balanceShift[2]))

        try curve.validate(id: dto.id)

        let crosstalk = dto.crosstalk.map { rows in
            Matrix3x3(rows: (Triple(rows[0][0], rows[0][1], rows[0][2]),
                             Triple(rows[1][0], rows[1][1], rows[1][2]),
                             Triple(rows[2][0], rows[2][1], rows[2][2])))
        }
        let aim = dto.aimDensity.map { Triple($0[0], $0[1], $0[2]) }

        return StockProfile(id: dto.id, profileVersion: dto.profileVersion,
                            kind: dto.kind, displayName: dto.displayName,
                            fitStatus: dto.fitStatus, iso: dto.iso, curve: curve,
                            crosstalk: crosstalk, aimDensity: aim,
                            silverRange: dto.silverRange, defaultPrint: dto.defaultPrint)
    }
}
```

- [ ] **Step 4: Author the 19 JSON resources**

Transcribe from Appendix A. Ten negative (Tables XL and XLI), four print (Table XLIII plus the crosstalk scaling in §A-K), five chemistry (Table IX).

`Sources/EmulsionCore/Resources/profiles/neg.portra400.json` — the pattern for all ten:

```json
{
  "id": "neg.portra400",
  "profileVersion": 3,
  "kind": "negative",
  "displayName": "Portra 400-type",
  "fitStatus": "M",
  "iso": 400,
  "curve": {
    "green":  { "gamma": 0.63, "deltaD": 1.90, "x0": -2.71,
                "kappaT": 0.140, "kappaS": 0.110, "dMin": 0.92 },
    "offsets": {
      "red":  { "gamma": -0.02, "deltaD":  0.05, "x0": -0.05,
                "kappaT":  0.010, "kappaS": 0.010, "dMin": 0.58 },
      "blue": { "gamma":  0.03, "deltaD": -0.05, "x0":  0.05,
                "kappaT": -0.010, "kappaS": 0.000, "dMin": 1.28 }
    },
    "maskDepletion": [0.00, 0.06, 0.10],
    "balanceShift":  [0.00, 0.00, 0.00]
  },
  "defaultPrint": "prt.2383"
}
```

`Sources/EmulsionCore/Resources/profiles/prt.2383.json` — the pattern for all four:

```json
{
  "id": "prt.2383",
  "profileVersion": 2,
  "kind": "print",
  "displayName": "Standard 2383-type",
  "fitStatus": "M",
  "curve": {
    "green":  { "gamma": 2.80, "deltaD": 2.42, "x0": 0.00,
                "kappaT": 0.220, "kappaS": 0.060, "dMin": 0.06 },
    "offsets": { "red": {}, "blue": {} },
    "maskDepletion": [0, 0, 0],
    "balanceShift":  [0, 0, 0]
  },
  "crosstalk": [[1.000, 0.086, 0.028],
                [0.041, 1.000, 0.113],
                [0.017, 0.052, 1.000]],
  "aimDensity": [1.09, 1.06, 1.03],
  "silverRange": 0.90
}
```

Remaining negative stocks, green record from Table XL — `neg.portra160` (ISO 160, γ 0.58, ΔD 1.86, x₀ −2.31, κt 0.155, κs 0.115, dMin 0.90); `neg.gold200` (200, 0.68, 1.78, −2.41, 0.150, 0.098, 0.88); `neg.ektar100` (100, 0.72, 2.02, −2.11, 0.128, 0.092, 0.86); `neg.superia400` (400, 0.65, 1.84, −2.71, 0.145, 0.104, 0.94); `neg.v3_500t` (500, 0.55, 2.06, −2.81, 0.168, 0.130, 0.96, balanceShift `[-0.29, 0.00, 0.42]`); `rev.velvia50` (50, −1.95, 3.10, −1.80, 0.090, 0.140, 0.10); `rev.provia100` (100, −1.72, 2.95, −2.10, 0.105, 0.150, 0.09); `mono.trix400` (400, 0.62, 1.92, −2.71, 0.160, 0.200, 0.22, kind `mono`); `mono.hp5` (400, 0.58, 1.88, −2.71, 0.170, 0.215, 0.20, kind `mono`).

Offsets: colour negative uses the Table XLI column; transparency uses its column; monochrome uses all-zero offsets and `dMin` equal on all three records.

Print stocks from Table XLIII with off-diagonal crosstalk scaled per §A-K: `prt.2393` (γ 3.05, ΔD 2.58, κt 0.185, κs 0.052, dMin 0.05, scale 1.18); `prt.3513` (2.72, 2.35, 0.245, 0.068, 0.07, scale 0.92, `crosstalk[1][2] += 0.014`); `prt.3521` (2.90, 2.48, 0.205, 0.058, 0.06, scale 1.09, `crosstalk[1][2] += 0.014`).

Chemistry files carry the Table IX row plus the family constants of §A-F: `chem.c41`, `chem.e6`, `chem.ecn2`, `chem.bw`, `chem.bwcomp`.

- [ ] **Step 5: Implement ProfileStore**

`Sources/EmulsionCore/Profiles/ProfileStore.swift`:

```swift
import Foundation

public struct ProfileStore: Sendable {
    private var stocks: [String: [Int: StockProfile]] = [:]
    private var chemistries: [String: ChemistryProfile] = [:]

    public static func bundled() throws -> ProfileStore {
        var store = ProfileStore()
        let urls = Bundle.module.urls(forResourcesWithExtension: "json",
                                      subdirectory: "profiles") ?? []
        for url in urls {
            let data = try Data(contentsOf: url)
            let name = url.deletingPathExtension().lastPathComponent
            if name.hasPrefix("chem.") {
                let chem = try JSONDecoder().decode(ChemistryProfile.self, from: data)
                store.chemistries[chem.id] = chem
            } else {
                let p = try ProfileDecoder.decode(data: data)
                store.stocks[p.id, default: [:]][p.profileVersion] = p
            }
        }
        guard !store.stocks.isEmpty else {
            throw EmulsionError.resourceUnreadable(name: "profiles")
        }
        return store
    }

    public func profile(id: String, version: Int?) throws -> StockProfile {
        guard let versions = stocks[id] else {
            throw EmulsionError.profileMissing(id: id, version: version)
        }
        if let v = version {
            guard let p = versions[v] else {
                throw EmulsionError.profileMissing(id: id, version: v)
            }
            return p
        }
        guard let latest = versions.keys.max(), let p = versions[latest] else {
            throw EmulsionError.profileMissing(id: id, version: nil)
        }
        return p
    }

    public func profiles(kind: StockKind) -> [StockProfile] {
        stocks.values
            .compactMap { $0.keys.max().flatMap { k in $0[k] } }
            .filter { kind == .negative ? ($0.kind == .negative || $0.kind == .mono) : $0.kind == kind }
            .sorted { $0.id < $1.id }
    }

    public func chemistry(id: String) throws -> ChemistryProfile {
        guard let c = chemistries[id] else {
            throw EmulsionError.profileMissing(id: id, version: nil)
        }
        return c
    }
}
```

- [ ] **Step 6: Run, verify pass, commit**

Run: `swift test --filter ProfileTests` — Expected: PASS, 5 tests.
If `isoRoundTripAllStocks` fails for a stock, its Appendix A x₀ is inconsistent with its declared ISO. Record per Task 14.

```bash
git add EmulsionCore/Sources/EmulsionCore/Profiles EmulsionCore/Sources/EmulsionCore/Resources \
        EmulsionCore/Tests/EmulsionCoreTests/ProfileTests.swift
git commit -m "feat(core): stock profile schema, decoder, and 19 bundled profiles"
```

---

### Task 9: Colour management — matrices, anchoring, ISO shift

**Files:**
- Create: `EmulsionCore/Sources/EmulsionCore/Imaging/ColorSpace.swift`
- Test: `EmulsionCore/Tests/EmulsionCoreTests/ColorSpaceTests.swift`

**Interfaces:**
- Consumes: `Matrix3x3`, `Triple`, `CaptureStage`.
- Produces: `ColorSpace.p3ToACEScg`, `.acesCgToP3`, `.anchor(_:exposureCompensation:calibration:) -> Triple`, `.logExposure(_:isoSpeed:referenceSpeed:speedPointRef:) -> Triple`, `.encodeDisplayP3(_:) -> Triple`.

- [ ] **Step 1: Write the failing test**

```swift
import Testing
import Foundation
@testable import EmulsionCore

@Suite("Colour space")
struct ColorSpaceTests {
    @Test("Input and output matrices round-trip")
    func roundTrip() {
        let v = Triple(0.18, 0.42, 0.71)
        let there = ColorSpace.p3ToACEScg * v
        let back = ColorSpace.acesCgToP3 * there
        #expect(abs(back.r - v.r) < 1e-6)
        #expect(abs(back.g - v.g) < 1e-6)
        #expect(abs(back.b - v.b) < 1e-6)
    }

    @Test("Anchoring maps a correctly exposed 18% grey to 0.18")
    func anchorMidGrey() {
        let anchored = ColorSpace.anchor(Triple(repeating: 0.18),
                                         exposureCompensation: 0,
                                         calibration: 0.18)
        #expect(abs(anchored.g - 0.18) < 1e-9)
    }

    @Test("One stop of compensation doubles exposure")
    func oneStop() {
        let a = ColorSpace.anchor(Triple(repeating: 0.18),
                                  exposureCompensation: 1, calibration: 0.18)
        #expect(abs(a.g - 0.36) < 1e-9)
    }

    @Test("Rating a 400 stock at 800 shifts log exposure by -0.301")
    func isoShift() {
        let base = ColorSpace.logExposure(Triple(repeating: 0.18), isoSpeed: 400,
                                          referenceSpeed: 400, speedPointRef: -2.71)
        let pushed = ColorSpace.logExposure(Triple(repeating: 0.18), isoSpeed: 800,
                                            referenceSpeed: 400, speedPointRef: -2.71)
        #expect(abs((pushed.g - base.g) - 0.301) < 1e-3)
    }

    @Test("Non-positive input is floored, never NaN")
    func flooring() {
        let x = ColorSpace.logExposure(Triple(0, -0.5, 1e-30), isoSpeed: 400,
                                       referenceSpeed: 400, speedPointRef: -2.71)
        #expect(x.isFinite)
    }
}
```

- [ ] **Step 2: Run and verify it fails**

Run: `swift test --filter ColorSpaceTests`
Expected: FAIL — "cannot find 'ColorSpace' in scope".

- [ ] **Step 3: Implement**

`Sources/EmulsionCore/Imaging/ColorSpace.swift`:

```swift
import Foundation

public enum ColorSpace {
    /// Extended linear Display P3 to ACEScg (AP1, D60), Bradford-adapted.
    public static let p3ToACEScg = Matrix3x3(rows: (
        Triple( 0.9525,  0.0343,  0.0132),
        Triple( 0.0170,  0.9754,  0.0076),
        Triple(-0.0018,  0.0107,  0.9911)))

    /// Numerical inverse of the above, precomputed.
    public static let acesCgToP3 = Matrix3x3(rows: (
        Triple( 1.0500, -0.0369, -0.0137),
        Triple(-0.0183,  1.0257, -0.0076),
        Triple( 0.0021, -0.0112,  1.0091)))

    /// Smallest exposure carried into the log domain. Scene values at or below
    /// zero are not an error to hide: debug builds should count them, because a
    /// nonzero count means the working space is too small.
    public static let exposureFloor = 1e-7

    /// E_anchored = E * 2^eps * 0.18 / g_cal.
    public static func anchor(_ e: Triple, exposureCompensation eps: Double,
                              calibration gCal: Double) -> Triple {
        let gain = pow(2.0, eps) * 0.18 / max(gCal, 1e-9)
        return e * gain
    }

    /// log10(E) + log10(S/S0) + x_ref, with the exposure floor applied.
    public static func logExposure(_ e: Triple, isoSpeed S: Double,
                                   referenceSpeed S0: Double,
                                   speedPointRef xRef: Double) -> Triple {
        let shift = log10(max(S, 1e-6) / max(S0, 1e-6))
        return e.map { log10(max($0, exposureFloor)) + shift + xRef }
    }

    /// Display P3 opto-electronic transfer function (sRGB-shaped).
    public static func encodeDisplayP3(_ linear: Triple) -> Triple {
        linear.map { v in
            let c = min(max(v, 0), 1)
            return c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, 1 / 2.4) - 0.055
        }
    }
}
```

- [ ] **Step 4: Run, verify pass, commit**

Run: `swift test --filter ColorSpaceTests` — Expected: PASS, 5 tests.
`roundTrip` failing means the inverse matrix above is not accurate enough; recompute it from `p3ToACEScg` rather than adjusting the tolerance.

```bash
git add EmulsionCore/Sources/EmulsionCore/Imaging/ColorSpace.swift \
        EmulsionCore/Tests/EmulsionCoreTests/ColorSpaceTests.swift
git commit -m "feat(core): colour management, exposure anchoring, ISO shift"
```

---

### Task 10: Print transfer and printer lights

**Files:**
- Create: `EmulsionCore/Sources/EmulsionCore/Imaging/PrinterLights.swift`
- Create: `EmulsionCore/Sources/EmulsionCore/Imaging/PrintTransfer.swift`
- Test: `EmulsionCore/Tests/EmulsionCoreTests/PrintTransferTests.swift`

**Interfaces:**
- Consumes: `CurveParameters`, `Matrix3x3`, `Triple`, `CharacteristicCurve`.
- Produces: `PrinterLights.pointsToLogExposure(_:) -> Double`, `PrintTransfer.printingDensity(_:crosstalk:) -> Triple`, `.aimBalance(negativeNeutralDensity:print:crosstalk:aim:printId:negativeId:) throws -> Triple`, `.printDensity(negativeDensity:aimLogL:points:master:crosstalk:print:) -> Triple`, `.applySilverRetention(_:rho:range:print:) -> Triple`, `.applyNeutralAxis(_:warm:tint:print:) -> Triple`, `.toDisplay(_:print:surroundExponent:) -> Triple`.

- [ ] **Step 1: Write the failing test**

```swift
import Testing
import Foundation
@testable import EmulsionCore

@Suite("Print transfer")
struct PrintTransferTests {
    static let printCurve = CurveParameters(
        dMin: Triple(repeating: 0.06), deltaD: Triple(repeating: 2.42),
        gamma: Triple(repeating: 2.80), x0: Triple(repeating: 0.0),
        kappaT: Triple(repeating: 0.220), kappaS: Triple(repeating: 0.060),
        maskDepletion: Triple(repeating: 0), balanceShift: Triple(repeating: 0))
    static let crosstalk = Matrix3x3(rows: (
        Triple(1.000, 0.086, 0.028),
        Triple(0.041, 1.000, 0.113),
        Triple(0.017, 0.052, 1.000)))
    static let aim = Triple(1.09, 1.06, 1.03)

    @Test("One printer point is 0.025 in log exposure")
    func pointUnit() {
        #expect(abs(PrinterLights.pointsToLogExposure(1) - 0.025) < 1e-12)
        #expect(abs(PrinterLights.pointsToLogExposure(12) - 0.30) < 1e-12)
    }

    @Test("Aim balance reproduces the aim density for a neutral")
    func aimBalanceNeutral() throws {
        let negNeutral = Triple(0.85, 1.20, 1.58)   // an 18% neutral through a negative
        let logL = try PrintTransfer.aimBalance(
            negativeNeutralDensity: negNeutral, print: Self.printCurve,
            crosstalk: Self.crosstalk, aim: Self.aim,
            printId: "prt.2383", negativeId: "neg.test")

        let d = PrintTransfer.printDensity(
            negativeDensity: negNeutral, aimLogL: logL,
            points: Triple(0, 0, 0), master: 0,
            crosstalk: Self.crosstalk, print: Self.printCurve)

        #expect(abs(d.r - Self.aim.r) < 1e-3)
        #expect(abs(d.g - Self.aim.g) < 1e-3)
        #expect(abs(d.b - Self.aim.b) < 1e-3)
    }

    @Test("Raising a printer light makes the print denser in that record")
    func printerLightSign() throws {
        let neg = Triple(0.85, 1.20, 1.58)
        let logL = try PrintTransfer.aimBalance(
            negativeNeutralDensity: neg, print: Self.printCurve,
            crosstalk: Self.crosstalk, aim: Self.aim,
            printId: "p", negativeId: "n")
        let base = PrintTransfer.printDensity(
            negativeDensity: neg, aimLogL: logL, points: Triple(0, 0, 0),
            master: 0, crosstalk: Self.crosstalk, print: Self.printCurve)
        let raised = PrintTransfer.printDensity(
            negativeDensity: neg, aimLogL: logL, points: Triple(3, 0, 0),
            master: 0, crosstalk: Self.crosstalk, print: Self.printCurve)
        #expect(raised.r > base.r)   // more exposure -> more dye -> denser red record
    }

    @Test("Display normalisation maps dMin to white and dMax to black")
    func displayEndpoints() {
        let white = PrintTransfer.toDisplay(Triple(repeating: 0.06),
                                            print: Self.printCurve, surroundExponent: 1.0)
        let black = PrintTransfer.toDisplay(Triple(repeating: 0.06 + 2.42),
                                            print: Self.printCurve, surroundExponent: 1.0)
        #expect(abs(white.g - 1.0) < 1e-6)
        #expect(abs(black.g - 0.0) < 1e-6)
    }

    @Test("Silver retention adds neutral density and lowers saturation")
    func silverRetention() {
        let d = Triple(0.9, 1.1, 1.4)
        let out = PrintTransfer.applySilverRetention(d, rho: 1.0, range: 0.90,
                                                     print: Self.printCurve)
        let spreadBefore = d.b - d.r
        let spreadAfter = out.b - out.r
        #expect(out.r > d.r)                    // density added everywhere
        #expect(abs(spreadAfter - spreadBefore) < 1e-9)  // neutral: spread unchanged
    }
}
```

- [ ] **Step 2: Run and verify it fails**

Run: `swift test --filter PrintTransferTests`
Expected: FAIL — "cannot find 'PrinterLights' in scope".

- [ ] **Step 3: Implement PrinterLights**

`Sources/EmulsionCore/Imaging/PrinterLights.swift`:

```swift
import Foundation

public enum PrinterLights {
    /// The industry unit: 0.025 in log10 exposure, twelve points to the stop.
    public static let pointSize = 0.025

    public static func pointsToLogExposure(_ points: Double) -> Double {
        pointSize * points
    }

    /// Sensitivity dD'/dp = 0.025 * print point gamma. Vanishes in the toe and
    /// shoulder, which is why balance changes do not tint whites or blacks.
    public static func sensitivity(atPrintLogE x: Double,
                                   _ p: CurveParameters, _ c: Record) -> Double {
        pointSize * CharacteristicCurve.pointGamma(logE: x, p, c)
    }
}
```

- [ ] **Step 4: Implement PrintTransfer**

`Sources/EmulsionCore/Imaging/PrintTransfer.swift`:

```swift
import Foundation

public enum PrintTransfer {
    /// D_eff = C * D. Off-diagonal terms are the unwanted dye absorptions.
    public static func printingDensity(_ negativeDensity: Triple,
                                       crosstalk C: Matrix3x3) -> Triple {
        C * negativeDensity
    }

    /// Neutral printer lights for a (negative, print) pair. Inverts the print
    /// curve by Newton iteration from the straight-line estimate.
    /// Throws rather than return a non-neutral neutral.
    public static func aimBalance(negativeNeutralDensity: Triple,
                                  print p: CurveParameters,
                                  crosstalk C: Matrix3x3,
                                  aim: Triple,
                                  printId: String,
                                  negativeId: String) throws -> Triple {
        let effective = printingDensity(negativeNeutralDensity, crosstalk: C)
        var logL = Triple(repeating: 0)

        for c in Record.allCases {
            // Straight-line estimate: D = dMin + gamma(x - x0) -> x.
            var x = p.x0[c] + (aim[c] - p.dMin[c]) / p.gamma[c]
            for _ in 0..<4 {
                let f = CharacteristicCurve.density(logE: x, p, c) - aim[c]
                let df = CharacteristicCurve.pointGamma(logE: x, p, c)
                guard abs(df) > 1e-9 else {
                    throw EmulsionError.aimBalanceDiverged(negative: negativeId, print: printId)
                }
                x -= f / df
            }
            let residual = abs(CharacteristicCurve.density(logE: x, p, c) - aim[c])
            guard residual < 1e-4, x.isFinite else {
                throw EmulsionError.aimBalanceDiverged(negative: negativeId, print: printId)
            }
            logL[c] = x + effective[c]
        }
        return logL
    }

    /// logE' = log10 L_aim + 0.025(p_c + p_master) - D_eff, then the print curve.
    public static func printDensity(negativeDensity: Triple,
                                    aimLogL: Triple,
                                    points: Triple,
                                    master: Double,
                                    crosstalk C: Matrix3x3,
                                    print p: CurveParameters) -> Triple {
        let effective = printingDensity(negativeDensity, crosstalk: C)
        var out = Triple(repeating: 0)
        for c in Record.allCases {
            let logE = aimLogL[c]
                + PrinterLights.pointsToLogExposure(points[c] + master)
                - effective[c]
            out[c] = CharacteristicCurve.density(logE: logE, p, c)
        }
        return out
    }

    /// Adds a spectrally neutral silver density proportional to total development.
    public static func applySilverRetention(_ d: Triple, rho: Double, range: Double,
                                            print p: CurveParameters) -> Triple {
        guard rho > 0 else { return d }
        var fractional = 0.0
        for c in Record.allCases {
            fractional += (d[c] - p.dMin[c]) / p.deltaD[c]
        }
        let neutral = (fractional / 3.0) * range
        return d + Triple(repeating: rho * neutral)
    }

    /// Density-dependent tilt of the neutral axis. Antisymmetric weighting, so
    /// warming the shadows cools the highlights — a real axis tilt, not two
    /// independent tint controls.
    public static func applyNeutralAxis(_ d: Triple, warm: Double, tint: Double,
                                        print p: CurveParameters) -> Triple {
        guard warm != 0 || tint != 0 else { return d }
        let mean = (d.r + d.g + d.b) / 3.0
        let psi = (mean - p.dMin.g) / p.deltaD.g - 0.5
        var out = d
        out.r += warm * psi
        out.b += tint * psi
        return out
    }

    /// Y = (10^-D' - 10^-Dmax') / (10^-Dmin' - 10^-Dmax'), then surround exponent.
    public static func toDisplay(_ d: Triple, print p: CurveParameters,
                                 surroundExponent: Double) -> Triple {
        var out = Triple(repeating: 0)
        for c in Record.allCases {
            let dMax = p.dMin[c] + p.deltaD[c]
            let num = pow(10, -d[c]) - pow(10, -dMax)
            let den = pow(10, -p.dMin[c]) - pow(10, -dMax)
            var y = den != 0 ? num / den : 0
            y = min(max(y, 0), 1)
            out[c] = surroundExponent == 1.0 ? y : pow(y, surroundExponent)
        }
        return out
    }
}
```

- [ ] **Step 5: Run, verify pass, commit**

Run: `swift test --filter PrintTransferTests` — Expected: PASS, 5 tests.

```bash
git add EmulsionCore/Sources/EmulsionCore/Imaging/PrinterLights.swift \
        EmulsionCore/Sources/EmulsionCore/Imaging/PrintTransfer.swift \
        EmulsionCore/Tests/EmulsionCoreTests/PrintTransferTests.swift
git commit -m "feat(core): print transfer, aim balance, printer lights"
```

---

### Task 11: ResolvedParameters and ParameterResolver

**Files:**
- Create: `EmulsionCore/Sources/EmulsionCore/Resolution/ResolvedParameters.swift`
- Create: `EmulsionCore/Sources/EmulsionCore/Resolution/ParameterResolver.swift`
- Test: `EmulsionCore/Tests/EmulsionCoreTests/ResolverTests.swift`

**Interfaces:**
- Consumes: `Recipe`, `ProfileStore`, `Development`, `PrintTransfer`, `CurveParameters`.
- Produces: `PrintParameters`, `ResolvedParameters`, `ParameterResolver.init(profiles:)`, `.resolve(_:) throws -> ResolvedParameters`.

- [ ] **Step 1: Write the failing test**

```swift
import Testing
import Foundation
@testable import EmulsionCore

@Suite("Parameter resolution")
struct ResolverTests {
    @Test("Resolution is deterministic")
    func deterministic() throws {
        let resolver = ParameterResolver(profiles: try ProfileStore.bundled())
        let r = Recipe(negativeStock: StockRef(id: "neg.portra400", version: 3),
                       printStock: StockRef(id: "prt.2383", version: 2),
                       chemistry: StockRef(id: "chem.c41", version: 1))
        let a = try resolver.resolve(r)
        let b = try resolver.resolve(r)
        #expect(a == b)
    }

    @Test("Push modulates the negative curve")
    func pushModulates() throws {
        let resolver = ParameterResolver(profiles: try ProfileStore.bundled())
        var r = Recipe(negativeStock: StockRef(id: "neg.portra400", version: 3),
                       printStock: StockRef(id: "prt.2383", version: 2),
                       chemistry: StockRef(id: "chem.c41", version: 1))
        let normal = try resolver.resolve(r)
        r.develop.pushPull = 2.0
        let pushed = try resolver.resolve(r)
        #expect(pushed.negative.gamma.g > normal.negative.gamma.g)   // more contrast
        #expect(pushed.negative.dMin.g > normal.negative.dMin.g)     // more fog
    }

    @Test("A missing profile throws")
    func missingProfile() throws {
        let resolver = ParameterResolver(profiles: try ProfileStore.bundled())
        let r = Recipe(negativeStock: StockRef(id: "neg.nonexistent", version: 1),
                       printStock: StockRef(id: "prt.2383", version: 2),
                       chemistry: StockRef(id: "chem.c41", version: 1))
        #expect(throws: EmulsionError.self) { try resolver.resolve(r) }
    }
}
```

- [ ] **Step 2: Run and verify it fails**

Run: `swift test --filter ResolverTests`
Expected: FAIL — "cannot find 'ParameterResolver' in scope".

- [ ] **Step 3: Implement ResolvedParameters**

`Sources/EmulsionCore/Resolution/ResolvedParameters.swift`:

```swift
import Foundation

public struct PrintParameters: Sendable, Hashable {
    public var curve: CurveParameters
    public var crosstalk: Matrix3x3
    public var aimLogL: Triple
    public var points: Triple
    public var master: Double
    public var silverRetention: Double
    public var silverRange: Double
    public var neutralAxisWarm: Double
    public var neutralAxisTint: Double
    public var isBypass: Bool
}

/// Dense, no optionals. What the evaluation path consumes.
public struct ResolvedParameters: Sendable, Hashable {
    public var negative: CurveParameters
    public var print: PrintParameters
    public var inputMatrix: Matrix3x3
    public var whiteBalanceMatrix: Matrix3x3
    public var anchorCalibration: Double
    public var exposureCompensation: Double
    public var isoSpeed: Double
    public var referenceSpeed: Double
    public var speedPointRef: Double
    public var surroundExponent: Double
    public var isMonochrome: Bool
    public var panchromaticWeights: Triple
}
```

- [ ] **Step 4: Implement ParameterResolver**

`Sources/EmulsionCore/Resolution/ParameterResolver.swift`:

```swift
import Foundation

/// Layers profile defaults, chemistry modulation, recipe values and transient
/// overrides into the dense value the renderer consumes.
public final class ParameterResolver: @unchecked Sendable {
    private let profiles: ProfileStore
    private let lock = NSLock()
    private var aimCache: [AimKey: Triple] = [:]

    private struct AimKey: Hashable {
        let negative: String, negativeVersion: Int
        let print: String, printVersion: Int
        let saturation: Double
    }

    public init(profiles: ProfileStore) { self.profiles = profiles }

    public func resolve(_ recipe: Recipe) throws -> ResolvedParameters {
        let neg = try profiles.profile(id: recipe.negativeStock.id,
                                       version: recipe.negativeStock.version)
        let chem = try profiles.chemistry(id: recipe.chemistry.id)

        // 1-2. Profile defaults, then chemistry modulation.
        let activity = Development.activity(recipe.develop, chem)
        var negCurve = Development.modulate(neg.curve, activity: activity, chemistry: chem)

        // 3. Recipe values: layer balance folds into x0 before evaluation.
        for c in Record.allCases { negCurve.x0[c] -= negCurve.balanceShift[c] }

        let isBypass = recipe.printStock.id == "prt.bypass"
        let printProfile = isBypass ? nil
            : try profiles.profile(id: recipe.printStock.id, version: recipe.printStock.version)

        var printCurve = printProfile?.curve ?? .bypassIdentity
        let crosstalk = printProfile?.crosstalk ?? .identity
        let aimDensity = printProfile?.aimDensity ?? Triple(1.09, 1.06, 1.03)

        // Highlight roll-off and shadow lift act on the print curve.
        let stage = recipe.printing.clamped()
        printCurve.kappaT = printCurve.kappaT * stage.highlightRolloff
        printCurve.deltaD = printCurve.deltaD - Triple(repeating: stage.shadowLift)

        let saturated = crosstalk.scalingOffDiagonal(by: stage.saturationDensity)

        // Aim balance: cached per stock pair and saturation.
        let aimLogL: Triple
        if isBypass {
            aimLogL = Triple(repeating: 0)
        } else {
            let key = AimKey(negative: neg.id, negativeVersion: neg.profileVersion,
                             print: printProfile!.id, printVersion: printProfile!.profileVersion,
                             saturation: stage.saturationDensity)
            lock.lock()
            let cached = aimCache[key]
            lock.unlock()
            if let cached {
                aimLogL = cached
            } else {
                let neutral = neutralNegativeDensity(negCurve, iso: neg.iso ?? 100)
                let computed = try PrintTransfer.aimBalance(
                    negativeNeutralDensity: neutral, print: printCurve,
                    crosstalk: saturated, aim: aimDensity,
                    printId: printProfile!.id, negativeId: neg.id)
                lock.lock(); aimCache[key] = computed; lock.unlock()
                aimLogL = computed
            }
        }

        let printParams = PrintParameters(
            curve: printCurve, crosstalk: saturated, aimLogL: aimLogL,
            points: Triple(Double(stage.printerLightR), Double(stage.printerLightG),
                           Double(stage.printerLightB)),
            master: Double(stage.printDensity),
            silverRetention: stage.silverRetention,
            silverRange: printProfile?.silverRange ?? 0.90,
            neutralAxisWarm: stage.neutralAxisWarm,
            neutralAxisTint: stage.neutralAxisTint,
            isBypass: isBypass)

        return ResolvedParameters(
            negative: negCurve,
            print: printParams,
            inputMatrix: ColorSpace.p3ToACEScg,
            whiteBalanceMatrix: .identity,
            anchorCalibration: 0.18,
            exposureCompensation: recipe.capture.exposureCompensation,
            isoSpeed: recipe.capture.filmSpeedOverride ?? neg.iso ?? 100,
            referenceSpeed: neg.iso ?? 100,
            speedPointRef: Sensitometry.speedPoint(negCurve, .g),
            surroundExponent: recipe.output.surroundExponent,
            isMonochrome: neg.kind == .mono,
            panchromaticWeights: Triple(0.30, 0.59, 0.11))
    }

    /// Density a correctly exposed 18% neutral produces through this negative.
    private func neutralNegativeDensity(_ curve: CurveParameters, iso: Double) -> Triple {
        let x = Sensitometry.speedPoint(curve, .g) + 1.0   // mid-scale placement
        return CharacteristicCurve.densityWithMask(logE: Triple(repeating: x), curve)
    }
}

extension CurveParameters {
    /// Identity print: used by the bypass profile so downstream code needs no branch.
    static let bypassIdentity = CurveParameters(
        dMin: Triple(repeating: 0), deltaD: Triple(repeating: 1),
        gamma: Triple(repeating: 1), x0: Triple(repeating: 0),
        kappaT: Triple(repeating: Math.minSoftness),
        kappaS: Triple(repeating: Math.minSoftness),
        maskDepletion: Triple(repeating: 0), balanceShift: Triple(repeating: 0))
}
```

- [ ] **Step 5: Run, verify pass, commit**

Run: `swift test --filter ResolverTests` — Expected: PASS, 3 tests.

```bash
git add EmulsionCore/Sources/EmulsionCore/Resolution \
        EmulsionCore/Tests/EmulsionCoreTests/ResolverTests.swift
git commit -m "feat(core): parameter resolution with cached aim balance"
```

---

### Task 12: PointwiseChain — the composed function

**Files:**
- Create: `EmulsionCore/Sources/EmulsionCore/Imaging/PointwiseChain.swift`
- Test: `EmulsionCore/Tests/EmulsionCoreTests/PointwiseChainTests.swift`

**Interfaces:**
- Consumes: everything above.
- Produces: `PointwiseChain.evaluate(logExposure:_:) -> Triple`, `.evaluate(sceneLinear:_:) -> Triple`.

- [ ] **Step 1: Write the failing test**

```swift
import Testing
import Foundation
@testable import EmulsionCore

@Suite("Pointwise chain")
struct PointwiseChainTests {
    func resolved(_ printId: String = "prt.2383") throws -> ResolvedParameters {
        let resolver = ParameterResolver(profiles: try ProfileStore.bundled())
        return try resolver.resolve(
            Recipe(negativeStock: StockRef(id: "neg.portra400", version: 3),
                   printStock: StockRef(id: printId, version: 2),
                   chemistry: StockRef(id: "chem.c41", version: 1)))
    }

    @Test("Output is bounded and finite across the domain")
    func boundedOutput() throws {
        let p = try resolved()
        for x in stride(from: -4.0, through: 2.0, by: 0.1) {
            let y = PointwiseChain.evaluate(logExposure: Triple(repeating: x), p)
            #expect(y.isFinite)
            #expect(y.r >= 0 && y.r <= 1)
            #expect(y.g >= 0 && y.g <= 1)
            #expect(y.b >= 0 && y.b <= 1)
        }
    }

    @Test("The chain is monotone decreasing in negative density, increasing in exposure")
    func monotoneInExposure() throws {
        let p = try resolved()
        var previous = -Double.infinity
        for x in stride(from: -4.0, through: 2.0, by: 0.02) {
            let y = PointwiseChain.evaluate(logExposure: Triple(repeating: x), p).g
            #expect(y >= previous - 1e-9)
            previous = y
        }
    }

    @Test("A scene neutral reproduces as a display neutral (V-08)")
    func neutralStaysNeutral() throws {
        let p = try resolved()
        let x = p.speedPointRef + 1.0
        let y = PointwiseChain.evaluate(logExposure: Triple(repeating: x), p)
        #expect(abs(y.r - y.g) < 1e-3)
        #expect(abs(y.b - y.g) < 1e-3)
    }

    @Test("Bypass short-circuits the print stages")
    func bypassDiffers() throws {
        let printed = try resolved("prt.2383")
        let bypassed = try resolved("prt.bypass")
        let x = Triple(repeating: printed.speedPointRef + 1.0)
        let a = PointwiseChain.evaluate(logExposure: x, printed)
        let b = PointwiseChain.evaluate(logExposure: x, bypassed)
        #expect(abs(a.g - b.g) > 1e-3)   // the flat lab-scan look is different
        #expect(b.isFinite)
    }

    @Test("Scene-linear entry agrees with log-exposure entry")
    func entryPointsAgree() throws {
        let p = try resolved()
        let scene = Triple(repeating: 0.18)
        let viaScene = PointwiseChain.evaluate(sceneLinear: scene, p)
        let logE = ColorSpace.logExposure(
            ColorSpace.anchor(p.inputMatrix * scene,
                              exposureCompensation: p.exposureCompensation,
                              calibration: p.anchorCalibration),
            isoSpeed: p.isoSpeed, referenceSpeed: p.referenceSpeed,
            speedPointRef: p.speedPointRef)
        let viaLog = PointwiseChain.evaluate(logExposure: logE, p)
        #expect(abs(viaScene.g - viaLog.g) < 1e-9)
    }
}
```

- [ ] **Step 2: Run and verify it fails**

Run: `swift test --filter PointwiseChainTests`
Expected: FAIL — "cannot find 'PointwiseChain' in scope".

- [ ] **Step 3: Implement**

`Sources/EmulsionCore/Imaging/PointwiseChain.swift`:

```swift
import Foundation

/// The complete pointwise chain. Module B bakes THIS function into the 45^3
/// LUT by calling it at lattice coordinates; a separately written bake path
/// would drift from per-pixel evaluation within two releases.
///
/// Total by construction: profiles are validated at load and
/// `ResolvedParameters` is dense, so nothing here can fail.
public enum PointwiseChain {
    /// Stages 1-9. Domain is log exposure over [-4, +2] — the LUT domain.
    public static func evaluate(logExposure x: Triple, _ p: ResolvedParameters) -> Triple {
        // 1. Layer balance is already folded into negative.x0 during resolution.
        var xr = x
        if p.isMonochrome {
            let pan = (x * p.panchromaticWeights).sum
            xr = Triple(repeating: pan)
        }

        // 2-3. Characteristic curve with orange-mask depletion.
        let negativeDensity = CharacteristicCurve.densityWithMask(logE: xr, p.negative)

        if p.print.isBypass {
            // Invert and normalise only: the flat, unadjusted lab-scan look.
            var y = Triple(repeating: 0)
            for c in Record.allCases {
                let dMax = p.negative.dMin[c] + p.negative.deltaD[c]
                let t = (negativeDensity[c] - p.negative.dMin[c])
                    / max(dMax - p.negative.dMin[c], 1e-9)
                y[c] = min(max(1 - t, 0), 1)
            }
            return p.surroundExponent == 1.0 ? y : y.map { pow($0, p.surroundExponent) }
        }

        // 4-6. Printing density, print exposure, print curve.
        var printDensity = PrintTransfer.printDensity(
            negativeDensity: negativeDensity,
            aimLogL: p.print.aimLogL,
            points: p.print.points,
            master: p.print.master,
            crosstalk: p.print.crosstalk,
            print: p.print.curve)

        // 7. Silver retention.
        printDensity = PrintTransfer.applySilverRetention(
            printDensity, rho: p.print.silverRetention,
            range: p.print.silverRange, print: p.print.curve)

        // 8. Neutral axis tilt.
        printDensity = PrintTransfer.applyNeutralAxis(
            printDensity, warm: p.print.neutralAxisWarm,
            tint: p.print.neutralAxisTint, print: p.print.curve)

        // 9. Display normalisation and surround.
        return PrintTransfer.toDisplay(printDensity, print: p.print.curve,
                                       surroundExponent: p.surroundExponent)
    }

    /// Prepends the transforms that live OUTSIDE the LUT domain: input matrix,
    /// white balance, exposure anchoring, ISO shift. Baking these would make a
    /// white-balance change silently invalidate the LUT.
    public static func evaluate(sceneLinear e: Triple, _ p: ResolvedParameters) -> Triple {
        let working = p.whiteBalanceMatrix * (p.inputMatrix * e)
        let anchored = ColorSpace.anchor(working,
                                         exposureCompensation: p.exposureCompensation,
                                         calibration: p.anchorCalibration)
        let logE = ColorSpace.logExposure(anchored, isoSpeed: p.isoSpeed,
                                          referenceSpeed: p.referenceSpeed,
                                          speedPointRef: p.speedPointRef)
        return evaluate(logExposure: logE, p)
    }
}
```

- [ ] **Step 4: Run, verify pass, commit**

Run: `swift test --filter PointwiseChainTests` — Expected: PASS, 5 tests.
`neutralStaysNeutral` is the load-bearing one: it is V-08, and §IX-C claims it holds for every stock pair without hand-tuning. If it fails, `neutralNegativeDensity` in Task 11 and `aimBalance` in Task 10 disagree about where a neutral sits.

```bash
git add EmulsionCore/Sources/EmulsionCore/Imaging/PointwiseChain.swift \
        EmulsionCore/Tests/EmulsionCoreTests/PointwiseChainTests.swift
git commit -m "feat(core): composed pointwise chain"
```

---

### Task 13: Cross-stock validation and the probe CLI

**Files:**
- Create: `EmulsionCore/Tests/EmulsionCoreTests/AllPairsTests.swift`
- Create: `EmulsionCore/Sources/emulsion-probe/main.swift`

**Interfaces:**
- Consumes: `ProfileStore`, `ParameterResolver`, `PointwiseChain`, `Sensitometry`.
- Produces: the `emulsion-probe` executable.

- [ ] **Step 1: Write the failing all-pairs test**

```swift
import Testing
import Foundation
@testable import EmulsionCore

@Suite("All stock pairs")
struct AllPairsTests {
    @Test("Every negative x print pair reproduces a neutral (V-08, AC-5)")
    func fortyPairNeutrality() throws {
        let store = try ProfileStore.bundled()
        let resolver = ParameterResolver(profiles: store)
        var failures: [String] = []

        for neg in store.profiles(kind: .negative) {
            for prt in store.profiles(kind: .print) {
                let recipe = Recipe(
                    negativeStock: StockRef(id: neg.id, version: neg.profileVersion),
                    printStock: StockRef(id: prt.id, version: prt.profileVersion),
                    chemistry: StockRef(id: neg.kind == .mono ? "chem.bw" : "chem.c41",
                                        version: 1))
                let p = try resolver.resolve(recipe)
                let y = PointwiseChain.evaluate(
                    logExposure: Triple(repeating: p.speedPointRef + 1.0), p)
                if abs(y.r - y.g) > 1e-3 || abs(y.b - y.g) > 1e-3 {
                    failures.append("\(neg.id) x \(prt.id): \(y)")
                }
            }
        }
        #expect(failures.isEmpty, "non-neutral pairs:\n\(failures.joined(separator: "\n"))")
    }

    @Test("Every profile is monotone at every process setting (AC-6)")
    func monotoneEverywhere() throws {
        let store = try ProfileStore.bundled()
        let chem = try store.chemistry(id: "chem.c41")
        for profile in store.profiles(kind: .negative) {
            for stops in [-2.0, -1.0, 0.0, 1.0, 2.0, 3.0] {
                var stage = DevelopStage(); stage.pushPull = stops
                let curve = Development.modulate(
                    profile.curve, activity: Development.activity(stage, chem),
                    chemistry: chem)
                let rising = curve.gamma.g > 0
                var previous = rising ? -Double.infinity : Double.infinity
                for x in stride(from: -5.0, through: 3.0, by: 0.02) {
                    let d = CharacteristicCurve.density(logE: x, curve, .g)
                    if rising { #expect(d >= previous - 1e-9) }
                    else      { #expect(d <= previous + 1e-9) }
                    previous = d
                }
            }
        }
    }
}
```

- [ ] **Step 2: Run and verify it fails or reveals findings**

Run: `swift test --filter AllPairsTests`
Expected: initially FAIL if any pair is non-neutral. Record which pairs; do not loosen the tolerance without recording why.

- [ ] **Step 3: Implement the probe**

`Sources/emulsion-probe/main.swift`:

```swift
import Foundation
import EmulsionCore

func pad(_ s: String, _ n: Int) -> String {
    s.count >= n ? String(s.prefix(n)) : s + String(repeating: " ", count: n - s.count)
}
func fmt(_ v: Double, _ places: Int = 3) -> String {
    String(format: "%.\(places)f", v)
}

let store = try ProfileStore.bundled()
let resolver = ParameterResolver(profiles: store)

print("EMULSION probe — sensitometric report\n")

// 1. Per-stock card.
print(pad("PROFILE", 20) + pad("ISO", 7) + pad("CI", 8)
      + pad("LATITUDE", 10) + pad("Dmin", 8) + pad("Dmax", 8) + "MARGIN")
print(String(repeating: "-", count: 68))
for p in store.profiles(kind: .negative) {
    let ci = Sensitometry.contrastIndex(p.curve, .g)
    let lat = Sensitometry.latitude(p.curve, .g, fraction: 0.5)
    let dMax = p.curve.dMin.g + p.curve.deltaD.g
    print(pad(p.id, 20)
          + pad(fmt(Sensitometry.isoSpeed(p.curve), 0), 7)
          + pad(fmt(ci), 8)
          + pad(fmt(lat, 1) + " stops", 10)
          + pad(fmt(p.curve.dMin.g, 2), 8)
          + pad(fmt(dMax, 2), 8)
          + fmt(p.curve.wellFormednessMargin(.g), 2))
}

// 2. Twenty-one step wedge through the default pairing.
print("\n21-step wedge — neg.portra400 / prt.2383\n")
let recipe = Recipe(negativeStock: StockRef(id: "neg.portra400", version: 3),
                    printStock: StockRef(id: "prt.2383", version: 2),
                    chemistry: StockRef(id: "chem.c41", version: 1))
let params = try resolver.resolve(recipe)
print(pad("STEP", 6) + pad("logE", 9) + pad("neg D (g)", 11) + "display RGB")
for step in 0...20 {
    let x = -4.0 + 4.0 * Double(step) / 20.0
    let negD = CharacteristicCurve.density(logE: x, params.negative, .g)
    let y = PointwiseChain.evaluate(logExposure: Triple(repeating: x), params)
    print(pad(String(step), 6) + pad(fmt(x, 2), 9) + pad(fmt(negD), 11)
          + "\(fmt(y.r)) \(fmt(y.g)) \(fmt(y.b))")
}

// 3. All-pairs neutrality.
print("\nNeutrality check — all (negative, print) pairs\n")
var worst = 0.0, worstPair = ""
for neg in store.profiles(kind: .negative) {
    for prt in store.profiles(kind: .print) {
        let r = Recipe(negativeStock: StockRef(id: neg.id, version: neg.profileVersion),
                       printStock: StockRef(id: prt.id, version: prt.profileVersion),
                       chemistry: StockRef(id: neg.kind == .mono ? "chem.bw" : "chem.c41",
                                           version: 1))
        let p = try resolver.resolve(r)
        let y = PointwiseChain.evaluate(logExposure: Triple(repeating: p.speedPointRef + 1.0), p)
        let deviation = max(abs(y.r - y.g), abs(y.b - y.g))
        if deviation > worst { worst = deviation; worstPair = "\(neg.id) x \(prt.id)" }
    }
}
print("worst deviation: \(fmt(worst, 5)) on \(worstPair)")
print(worst < 1e-3 ? "PASS" : "FAIL — aim balance is not neutralising every pair")
```

- [ ] **Step 4: Run the probe and read the output**

Run: `swift run emulsion-probe`
Expected: three tables. Check by eye that ISO matches the profile names, CI sits near 0.58 for colour negative, latitude reports 12–14 stops for modern colour negative (§VI), and the wedge's display values rise monotonically from near 0 to near 1.

- [ ] **Step 5: Commit**

```bash
git add EmulsionCore/Sources/emulsion-probe \
        EmulsionCore/Tests/EmulsionCoreTests/AllPairsTests.swift
git commit -m "feat(core): all-pairs validation and emulsion-probe CLI"
```

---

### Task 14: Findings record

**Files:**
- Create: `docs/superpowers/findings/2026-08-10-emulsion-core-findings.md`

**Interfaces:**
- Consumes: test output from Tasks 1–13.
- Produces: a written record. This is deliverable 6 of the spec's definition of done.

- [ ] **Step 1: Record every discrepancy found**

Use this structure, one entry per finding:

```markdown
## F-NN: <short title>

**Where:** paper §X / Table Y, and `Sources/.../File.swift`
**Expected (paper):** <value or claim>
**Actual (implementation):** <value>
**Assessment:** paper is wrong | implementation is wrong | both defensible, ambiguous
**Action taken:** <what changed, or why nothing changed>
```

Seed it with the two already known before implementation began:

```markdown
## F-01: Table VIII gamma column disagrees with the gamma-vs-activity equation

**Where:** §VII Table VIII; `Sources/EmulsionCore/Imaging/Development.swift`
**Expected (paper):** Push 1 gives gamma = 0.69
**Actual (implementation):** gamma_inf = 1.6 x 0.61 = 0.976, A_gamma = 1/ln(0.976/0.366)
= 1.0196, so gamma(1.35) = 0.976(1 - e^-1.324) = 0.716
**Assessment:** to be determined during Task 6
**Action taken:** to be filled in

## F-02: Speed-point sign handling for reversal stocks

**Where:** spec §4.1 item 2; `Sources/EmulsionCore/Sensitometry/Sensitometry.swift`
**Expected (spec):** `speedPoint` "flips its offset term" for gamma < 0
**Actual (implementation):** the offset is u*/gamma, so division by a negative
gamma flips the sign automatically; no branch is required
**Assessment:** spec describes the effect, not the mechanism; implementation is
simpler and correct
**Action taken:** implemented without a branch; spec wording should be corrected

## F-03: neg.v3_500t.xr has halation parameters but no curve row

**Where:** Appendix A, halation table vs Table XL
**Expected:** eleven negative profiles listed in one place, ten in the other
**Actual:** the .xr variant differs only in halation, which Core does not evaluate
**Assessment:** appendix inconsistency, harmless at this layer
**Action taken:** deferred to module B; Core ships 19 resources
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/findings/2026-08-10-emulsion-core-findings.md
git commit -m "docs: record discrepancies found implementing EmulsionCore"
```

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: §3 architecture → Task 1; §4 surface → Tasks 2–12; §5.1 resolution → Task 11; §5.2 the nine stages → Tasks 4, 10, 12; §6.1 throwing boundary → Tasks 3, 8, 10; §6.2 the five numerical guards → Tasks 1 (softplus, κ floor), 9 (exposure floor), 3 (ΔD > 0), 12 (finite output); §7.1 paper-value tests → Tasks 5, 6, 8; §7.2 property tests → Tasks 4, 5, 12, 13; §7.3 probe → Task 13; §9 item 6 → Task 14.

**Placeholder scan.** No TBDs in executable steps. Task 8 Step 4 lists the remaining eighteen profiles as parameter tuples rather than eighteen full JSON blocks, with two complete files given as the pattern — this is transcription from Appendix A, and repeating the skeleton eighteen times would obscure rather than clarify. Task 14 intentionally contains fill-in fields, because it is a record of results that do not exist until the tests run.

**Type consistency.** `Triple`, `Record`, `CurveParameters`, `Matrix3x3`, `ResolvedParameters`, `PrintParameters`, `StockProfile`, `ChemistryProfile`, `DevelopStage`, `PrintStage` are each defined once and referenced with identical field names throughout. `CurveParameterTests.portra400` is defined in Task 3 and reused by Tasks 4, 5 and 6 — those tasks must not redefine it. `ProfileStore.profiles(kind:)` returns monochrome stocks under `.negative`, which Tasks 8 and 13 both rely on.
