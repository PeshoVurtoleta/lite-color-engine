# Changelog

## [1.5.0] - 2026-07-13

### Added

- **Blue-noise dither kernels** — shared kernel for the whole ecosystem
  (studio, hueforge, gradient consumers) so there is exactly one
  implementation to reason about:
  - `getBlueNoise64()` — returns a shared, read-only `Uint8Array(4096)`
    holding a 64x64 void-and-cluster blue-noise tile. Lazily decoded from
    an inlined base64 blob on first call (sub-millisecond); subsequent
    calls return the same reference. Histogram is exactly uniform (each
    byte 0..255 appears 16 times). Index via
    `tile[((y & 63) << 6) | (x & 63)]`; the tile is torus-tileable.
    Generator committed as `tools/generate-bluenoise.mjs` with a fixed
    seed. The tile is gated on its *spectral* properties, not just its
    fingerprint — see `test/bluenoise-spectral.test.js`.
  - `packOklchBufferToUint32Dithered(buf, off, alpha = 1.0, noise01 = 0.5)`
    — scalar dithered packer. Threshold offset applied in gamma-encoded space, with
    the same `noise01` shared across R, G, B (luminance-patterned dither,
    no chroma speckle). Alpha is undithered. Parity guarantee:
    `noise01 === 0.5` reproduces the byte output of
    `packOklchBufferToUint32` bit-for-bit.
  - `packOklchBufferToUint32IntoNDithered(src, offSrc, dst, offDst, n,
    alpha, noiseTile, x0, y0, rowWidth)` — batch variant that walks the
    tile in row-major order over an arbitrary destination rectangle. Zero
    allocations; no modulo/division in the hot loop.

  **Honest note on `useLut`:** the batch dithered packer does *not* accept
  the 4k transfer LUT flag. `SRGB_LUT` stores rounded bytes, which
  discards the sub-integer information the dither threshold shift needs;
  enabling it would silently collapse dither to plain rounding. A
  companion `Float32Array` LUT of encoded floats (~16 KB, lazy) is a
  v1.6 candidate that would restore this axis.

- **Batch P3 packer:** `packOklchBufferToUint32P3IntoN(src, offSrc, dst,
  offDst, n, alpha?, useLut?)` — P3 sibling of the v1.3 sRGB batch. The
  P3 transfer function is identical to sRGB (IEC 61966-2-1), so the same
  `SRGB_LUT` is reused when `useLut=true` — no separate 4 KB table is
  allocated. Same accuracy story as the sRGB LUT path (within 1 LSB of
  exact) and same fast-packer throughput class.

- **Batch MINDE:** `gamutMapToSrgbBufferN(inBuf, off, outBuf, offOut, n)`
  (on the `./gamut` subpath) — batch sibling of the scalar MINDE mapper.
  Bit-for-bit identical to `n` scalar calls; the batch amortizes call
  overhead for authoring / LUT-building large color runs (hueforge P3
  exporters, studio bake paths) that today loop the scalar. Setup-time /
  bake-time convenience — MINDE stays out of the per-frame hot path.

- **Cyclic LUT bake:** `bakeGradientToUint32` gained a trailing `opts`
  parameter with `{ closed: true }`. In closed mode, stops are treated
  cyclically (last stop wraps back to first), sample positions become
  `i / resolution` (period spacing, no duplicated endpoint), and
  `easeFn` outputs are period-wrapped via `t - floor(t)` instead of
  clamped. Pairs with `sampleColorLUTWrapped` on the consumer side. The
  seam continuity is asserted: `|lut[res-1] - lut[0]|` per channel is
  bounded by the maximum adjacent-cell interior delta.

- **Preflight gate (stale-base cure):** `npm run preflight` fetches the
  latest published tarball via `npm pack` and hash-compares every file
  in `files[]` against the working tree. Hard-fails on code drift
  (`index.js`, `index.d.ts`, `src/**`, `package.json`); warns for doc
  drift (`README.md`, `CHANGELOG.md`, `LICENSE.md`, `llms.txt`). This is
  the structural cure for the v1.3/v1.4 regressions that started from an
  unrebased working tree. Session protocol: run preflight before feature
  work.

### Fixed (pre-release, against the 1.5.0 release candidate)

- **Blue-noise tile: Phase 3 of the void-and-cluster generator was
  inverted.** The RC selected the 0-cell with the *highest* filtered
  ones-field — the cell most surrounded by 1s, which is an **isolated**
  zero (the largest void of the complement), not its tightest cluster.
  The correct selector is the *minimum*: because the filter is toroidal
  and constant-sum, `zerosField = sum(K) - onesField`, so
  `argmax(zerosField) === argmin(onesField)` and Phase 3 reduces to the
  same `findLargestVoid()` call as Phase 2.

  Effect: ranks below 2048 were unaffected, so every threshold pattern at
  or below mid-gray was correct — and every threshold pattern **above**
  it was 5–7x over-clustered. Dithering was sound in the shadows and
  broken in the highlights, which is exactly where a dither earns its
  keep. Radial power at `r=1` was 2.05 against a white-noise floor of
  0.083: at the tile period the RC tile was *worse than random*.

  The tile fingerprint therefore rotates:
  `78926ec1…` → `8867ddb65e16379ad42244fa24b82dcbd813c684ce14944f86a9e3e8f6b72968`.
  Same seed (`0xc0ffee1e`), same generator, one comparator.

- **The RC gates could not see any of it.** All 17 tests in
  `dither.test.js` passed the defective tile. A uniform histogram is
  invariant under *any* permutation of ranks (a linear ramp satisfies
  it); the SHA-256 assertion pins the artifact rather than validating it,
  and was cementing the defect into the contract; and "dithered
  run-length halved vs undithered" is satisfied by white noise too — it
  tests *that* there is noise, not that the noise is blue. The
  generator's own self-check measured field variance at `T=128` **only**,
  which is precisely the one threshold an inverted Phase 3 cannot affect,
  and it reported an identical healthy 0.5133 for the broken and the
  fixed tile.

  New `test/bluenoise-spectral.test.js` gates the property the feature is
  named after: minority-phase clumpiness under 0.70 across `T=16..240`,
  that curve symmetric about `T=128` (the assertion that fails the RC
  first), radial power for `r<=4` below the white-noise floor, high-band
  power above it, and wrap-edge decorrelation within 82% of interior. The
  generator now runs the same sweep as a hard gate and refuses to emit a
  tile that fails it.

- `packOklchBufferToUint32Dithered` had no parameter defaults while every
  sibling packer defaults `alpha = 1.0`. Calling it with the plain
  packer's arity returned `0x00000000` — silent transparent black. It now
  defaults `alpha = 1.0, noise01 = 0.5`, so a 2-argument call is exactly
  `packOklchBufferToUint32`.

- **The sRGB transfer function had 8 copies in `src/runtime.js`** — 6 of them
  added by the F1 dither work, which inlined the encode per channel in both
  dithered packers. They now derive from a single `srgbEncode(c)` helper, which
  `SRGB_LUT` and `linearToSrgbByte` also route through: one definition of the
  IEC 61966-2-1 constants in the module. The dither packers genuinely cannot use
  `linearToSrgbByte` (it rounds) or `SRGB_LUT` (it stores rounded bytes) — they
  need the sub-integer encoded value — but that argued for extracting the shared
  step, not for copying it six times. The real exposure was the
  `noise01 === 0.5` parity guarantee: it holds only while the dither path and
  the plain path agree on the encode, and nothing structural was keeping them in
  step. Now they are the same function, and the parity test guards it.

  Measured, since "the duplication forces V8 to monomorphize the loop" is a
  testable claim: interleaved A/B, 40 rounds, 12 primer passes, N=100k. The
  helper form came in at 0.9978x / 0.9981x / 0.9967x / 0.9983x of the inlined
  form on the dithered batch, and within +/-0.3% on the scalar. V8 inlines it
  outright. The duplication bought nothing.

  `src/Gamut.js` and `src/Remap.js` keep their own single copies **on purpose**.
  Both modules currently have zero imports, and `Gamut.js` is a subpath export
  (`./gamut`); making it import from `runtime.js` would drag the module-level
  `SRGB_LUT` build and the 5.4 KB blue-noise blob into the gamut consumer's
  graph. One duplicated line each is the cheaper trade. A shared `src/transfer.js`
  would collapse the last two without that cost, if it is ever worth a file.

- `getBlueNoise64()` read `Buffer` as a free identifier. Webpack 4 and
  browserify pattern-match that token and inject the ~20 KB buffer
  polyfill into browser bundles — for a package whose pitch is a
  single zero-dependency file. Now reads `globalThis.Buffer`, which is
  not matched; browser builds stay on the `atob` path.

### Demo

- `demo/index.html` particle cull guard rewritten from `(out of range)` to
  `!(in range)`. Identical for every finite value and the same four compares —
  but NaN makes every comparison false, so the old form let a NaN coordinate
  through to `(pY[i] | 0) * w + (pX[i] | 0)`, where `NaN | 0` is `0` and the
  particle silently paints pixel (0,0) forever. Not reachable today (the `+ 1`
  in `d2` rules out the divide-by-zero and `F_DAMP` bounds the integration);
  this is a free guard against a future edit to the force math.

### Known / deferred

- **Dither DC bias.** `noise01 = byte / 256` has mean `127.5/256 =
  0.498046875`, not `0.5`, so `floor(v + noise)` darkens by a constant
  `-1/512` LSB on every pixel. It is deterministic, not noise, and
  invisible (0.2% of one code value) — but it is a bias, and the JSDoc
  leans on "the mean and variance of a uniform distribution" as if that
  mean were 0.5. The fix, `(byte + 0.5) / 256`, would centre it exactly —
  at the cost of the `noise01 === 0.5` parity guarantee, since no byte
  maps to 127.5. Kept as-is for v1.5; the parity property is worth more
  than 1/512 of a code value. Revisit alongside the v1.6 float-LUT.

### Notes

- No breaking changes. All v1.4 exports (batch kernels, 4k LUT, Display
  P3, CSS formatters, `sampleColorLUT`) are retained with identical
  byte-level output.
- Existing open-mode `bakeGradientToUint32` calls are byte-identical to
  v1.4 (verified by regression tests) — closed mode is opt-in via the
  new trailing `opts` argument.
- Zero-GC audit: every new hot-path function is allocation-free after
  the one-time lazy noise decode.

---

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
