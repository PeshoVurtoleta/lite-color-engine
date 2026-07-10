# Changelog

## [1.2.0] - 2026-07-10

### Added
- **Wide Gamut Support (Display P3)**
  - `parseCSSColor('color(display-p3 r g b / alpha)')` now supported in the universal parser
  - New `displayP3ToOklchBuffer()` conversion function with accurate P3 → XYZ → OKLab pipeline
  - `packOklchBufferToUint32P3()` — accurate packer for `display-p3` canvas contexts
  - `packOklchBufferToUint32P3Fast()` — high-speed sqrt approximation for P3 output
  - `oklchToLinearP3()` inverse conversion helper

- **Accuracy Tiers** (now clearly documented)
  - Fast (`packOklchBufferToUint32Fast`)
  - Accurate-Clamp (default `packOklchBufferToUint32`)
  - Gamut-Mapped (`packOklchBufferToUint32MINDE` / P3 equivalent)

- `bakeGradientToUint32()` already supported custom packers — now officially documented for P3 usage.

### Changed
- Improved documentation around color gamut handling and when to use each packer.
- Minor internal cleanup for better tree-shaking of P3 code paths.

### Notes
- P3 remains strictly opt-in. Default paths and bundle size are unchanged.
- All hot paths remain zero-GC and allocation-free.

---

## [1.1.0] - Previous
- Added `deltaEOK` and MINDE gamut mapping (`/gamut` sub-export)
- Added palette remapping utilities (`/remap`)
