# Print-film LUT provenance

The `.cube` files in this directory are measured film-print emulations, used by
the LUT print engine as an alternative to the calculated print model. They are
indexed on Cineon log (a scanned negative) and output Rec.709 gamma 2.4, per
their own headers. Film-stock names are used descriptively to identify the
photographic response being modelled; all trademarks are the property of their
respective owners and no affiliation or endorsement is implied.

| File | Stock | Size | Source |
|---|---|---|---|
| `kodak-2383-d55.cube` | Kodak Vision 2383, D55 | 33³ | "Rec709 Kodak 2383 D55" — Film Look LUT as below. |
| `kodak-2383-d60.cube` | Kodak Vision 2383, D60 | 33³ | "Rec709 Kodak 2383 D60" — Film Look LUT as below. |
| `kodak-2383-d65.cube` | Kodak Vision 2383, D65 | 33³ | "Rec709 Kodak 2383 D65" — the Film Look LUT distributed with DaVinci Resolve, originally published by Kodak. Mirrored at `github.com/imnz730/LUTs` (Film Looks). |
| `kodak-2393-d65.cube` | Kodak Premier 2393 | 13³ | Autodesk Film Print Emulation (FPE) series, `kodak_2393_constlclip` variant, via the G'MIC film-LUT collection (`github.com/YahiaAngelo/Film-Luts`, `luts/print`). The FPE cube ships at 13³ in a single white point; its interpolation error is measured, not assumed — see the engine tests. |
| `fuji-3513-d55.cube` | Fujifilm 3513DI, D55 | 33³ | "Rec709 Fujifilm 3513DI D55" — Film Look LUT as below. |
| `fuji-3513-d60.cube` | Fujifilm 3513DI, D60 | 33³ | "Rec709 Fujifilm 3513DI D60" — Film Look LUT as below. |
| `fuji-3513-d65.cube` | Fujifilm 3513DI, D65 | 33³ | "Rec709 Fujifilm 3513DI D65" — Film Look LUT as above. |

Fujifilm 3521 has no measured LUT under a licence that permits
redistribution, so that stock renders through the calculated model only.

Each file is validated at load: header contract (Cineon log in, 0–1 domain),
declared cube size against the actual point count, and finite values inside
the output range. A file that fails validation falls back to the calculated
model rather than rendering through something unverified.
