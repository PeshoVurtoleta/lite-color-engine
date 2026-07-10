# Changelog

## [1.4.0] - 2026-07-10

### Added
- **CSS formatters (round-trip emit):**
  - `formatOklchCss(buf, off, alpha?)` - emits `oklch(L% C H)` (or `.../ alpha` when
    alpha is supplied and < 1). Round-trips through `parseCSSColor`.
  - `formatHex(buf, off)` - emits `#rrggbb` via the accurate sRGB pack path.
    Round-trips with `parseHexToBuffer` to within 1 LSB per channel.
  - Both are authoring-time helpers (they allocate a string) and are not for
    per-frame hot paths.

### Fixed
- Named-color table: `darkslateggrey` -> `darkslategrey` and `navajawhite` ->
  `navajowhite` (previously unreachable typo keys), and `lightsteelblue` now
  returns its correct value `#b0c4de` instead of powderblue's `#b0e0e6`.

### Notes
- No breaking changes; all v1.3 exports (batch kernels, 4k LUT, Display P3,
  `sampleColorLUT`) are retained.

---

## [1.3.0] - 2026-07-10

### Added
- **Batch kernels for large particle systems (100k+):**
  - `lerpOklchBufferN(a, offA, b, offB, t, out, offOut, n)` - interpolate `n` OKLCH
    triplets (stride 3) with a shared `t`. Bit-for-bit identical to `n` scalar
    `lerpOklchBuffer` calls; supports in-place and offset addressing.
  - `packOklchBufferToUint32IntoN(src, offSrc, dst, offDst, n, alpha?, useLut?)` -
    pack `n` OKLCH triplets straight into a `Uint32Array` (dst stride 1), the exact
    shape a SoA particle system blits into `ImageData`.
- **Opt-in 4096-entry sRGB transfer LUT** (`useLut: true` on the batch packer):
  removes `pow()` from the hot path for **~2.7x** packing throughput at **within
  1 LSB** of the exact encoder. Single one-time table allocation.

### Performance (measured, Node 22 / V8, 100k in-gamut triplets, median of 80)
- Packing: accurate ~3.2M colors/s (~32 ms/frame); LUT ~14M colors/s (~7 ms/frame) - **~4.4x**.
  The LUT runs at Fast-packer speed (`sqrt`) while staying within 1 LSB of exact.
- 100k lerp+pack fits a 60fps frame only with the LUT (~10 ms vs ~35 ms accurate).
- Honest caveat: the speedup is the **LUT**, not the batching. Accurate batch
  packing runs at the same speed as a scalar loop (pow-bound), and batch lerp is
  not measurably faster than a scalar loop in V8. The batch APIs are primarily
  about ergonomics (whole-buffer ops) and unlocking the LUT path. Reproduce with
  `node bench/benchmark.mjs`.

### Notes
- All hot paths remain zero-GC and allocation-free per frame.
- No breaking changes; all v1.2 exports (including Display P3 and `sampleColorLUT`)
  are retained.

---

## [1.2.0] - 2026-07-10

### Added
- **Wide Gamut Support (Display P3)**
  - `parseCSSColor('color(display-p3 r g b / alpha)')` now supported in the universal parser
  - New `displayP3ToOklchBuffer()` conversion function with accurate P3 -> XYZ -> OKLab pipeline
  - `packOklchBufferToUint32P3()` - accurate packer for `display-p3` canvas contexts
  - `packOklchBufferToUint32P3Fast()` - high-speed sqrt approximation for P3 output
  - `oklchToLinearP3()` inverse conversion helper

- **Accuracy Tiers** (now clearly documented)
  - Fast (`packOklchBufferToUint32Fast`)
  - Accurate-Clamp (default `packOklchBufferToUint32`)
  - Gamut-Mapped (`packOklchBufferToUint32MINDE`, on the `/gamut` subpath)

- `bakeGradientToUint32()` already supported custom packers - now officially documented for P3 usage.

### Changed
- Improved documentation around color gamut handling and when to use each packer.
- Minor internal cleanup for better tree-shaking of P3 code paths.

### Notes
- P3 remains strictly opt-in. Default paths and bundle size are unchanged.
- All hot paths remain zero-GC and allocation-free.

---

## [1.1.0] - Previous

- Core zero-GC OKLCH engine: parsing, buffer lerp, packers, delta-E, gradient LUT baking,
  gamut mapping (`/gamut`) and palette remap (`/remap`) subpaths.
