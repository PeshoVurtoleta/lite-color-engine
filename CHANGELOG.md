# Changelog

All notable changes to `@zakkster/lite-color-engine` are documented in this file.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/).


## [1.1.0] — Unreleased

### Added — MINDE gamut mapping, ΔE-OK, and SoA remap kernels

Two new sub-exports (`/gamut`, `/remap`) plus one core function. All follow the buffer-and-offset API and the zero-allocation-on-hot-path convention from v1.0.

#### Core

- **`deltaEOK(bufA, oA, bufB, oB): number`** — ΔE-OK color difference (Euclidean distance in OKLab) between two buffered OKLCH colors. Ten-line pure function, zero allocations. Consumed internally by the `/gamut` and `/remap` sub-exports and available for downstream packages.

#### `/gamut` sub-export

```js
import {
    gamutMapToSrgbBuffer,
    packOklchBufferToUint32MINDE,
} from '@zakkster/lite-color-engine/gamut';
```

- **`gamutMapToSrgbBuffer(inBuf, inOffset, outBuf, outOffset)`** — CSS Color 4 MINDE chroma reduction. Reduces chroma at fixed L and H until the color is in-gamut, using bisection with a JND (0.02) threshold. Source and destination may alias. All scratch is module-level; zero allocation on the hot path.
- **`packOklchBufferToUint32MINDE(buf, offset, alpha?)`** — accurate sibling of the v1.0 packer. Eliminates the hue-shift artifacts of the hard channel clamp near the gamut boundary. Returns unsigned RGBA-LE Uint32 (matches v1.0 convention). Signature-compatible with the core packer, so it can be passed directly as the `packer` argument to `bakeGradientToUint32`.

#### `/remap` sub-export

```js
import {
    sRgba8ToOklabBuffer,
    oklchToOklabBuffer,
    oklabToOklchBuffer,
    nearestPaletteIndexBuffer,
    remapPixelsToPalette,
} from '@zakkster/lite-color-engine/remap';
```

- **`sRgba8ToOklabBuffer(inU8, outLab, pixelCount)`** — batch RGBA8 → OKLab. Alpha discarded.
- **`oklchToOklabBuffer` / `oklabToOklchBuffer`** — batch polar/cartesian conversions between OKLCH and OKLab. Hue canonicalized to `[0, 360)`.
- **`nearestPaletteIndexBuffer(pixelsLab, paletteLab, indicesOut, pixelCount, paletteCount, opts?)`** — core search kernel. For each pixel, writes the index of the nearest palette color by squared Euclidean distance in OKLab. Tie-break: lowest index wins. Accepts any typed-array index output (`Uint32Array`, `Uint16Array`, `Uint8Array`). Option `preserveLightness`: distance uses `(a, b)` only.
- **`remapPixelsToPalette(inU8, paletteLch, outU32, pixelCount, paletteCount, opts?)`** — one-shot end-to-end: RGBA8 → nearest palette color → RGBA-LE Uint32. Alpha byte passes through unchanged. Palette OKLCH → OKLab conversion happens internally on module-level scratch (grows monotonically, never shrinks). Option `preserveLightness`: synthesizes output per pixel as `(pixel.L, palette.a, palette.b)` — retains shading structure under recolor. ~40% slower than the fast path.

### Alignment with `V1.1-PLAN.md`

- **P0/#1** (MINDE gamut mapping) — shipped as `/gamut`.
- **P1/#5** (ΔE-OK) — shipped in core.
- **P0/#2** (alpha-aware LUT baker), **P0/#3** (ARGB byte-order variant), **P0/#4** (hue interpolation modes), **P1/#6** (gamma LUT packer), **P1/#7** (CSS Color 5 relative-color syntax) — not in this release, tracked for follow-up.

### New in this release, not in the plan

- **`/remap` sub-export** — added as the engine underlayment for `lite-hueforge v1.3` `remapImageToPalette`. Standalone value: palette quantization for retro / palette-cycling render effects, dithering targets, and demoscene-style palette animations.

### Design notes

- **Sub-exports are self-contained.** `Gamut.js` and `Remap.js` each carry their own local converters (`_oklchToLinearRgb`, `_linearRgbToOklch`, `_srgbGammaEncode`, `_linearizeSrgbByte`) rather than importing from core. Costs a small amount of duplicated math across the two files, buys loadability in isolation and independence from any future refactor of the internal converters.
- **Search in OKLab, not OKLCH.** Distance in OKLab is Euclidean; distance in OKLCH would need cos/sin per comparison. Palette is authored in OKLCH (human-natural), converted once at call entry.
- **Grow-only scratch.** `remapPixelsToPalette` grows its internal palette scratch when a larger palette is passed; it never shrinks. This matches the ecosystem's zero-GC contract — allocation happens at edge cases, not per frame.
- **Alpha semantics.** In `remapPixelsToPalette`, the palette is pre-packed opaque; input alpha is OR-composited into the output. This lets the palette live alongside a per-pixel alpha channel without double-clamping.

### Performance

Measured on Node 22 in a conservative sandbox (no JIT warm-up budget); V8 in browsers is typically 2–3× faster. 5-color palette, noise input:

| Resolution | Fast path | preserveLightness |
| ---------- | --------- | ----------------- |
| 256 × 256  | 60+ fps   | 40 fps            |
| 512 × 512  | 16 fps    | 10 fps            |
| 1024 × 1024| 4 fps     | 2.5 fps           |

Interpretation: the fast path is real-time up to ~512² in browser conditions; `preserveLightness` is real-time up to ~256². For larger canvases (2048² live recolor), a WebGL shader path is the intended next-generation kernel — flagged as a v1.2 candidate. WASM SIMD is another option worth benching.

For the near-term demo, downscale the preview canvas to 512² and upscale for final render — a standard pattern in image-editing tools.

### Tests

50 new deterministic tests across three files. All 43 existing tests continue to pass; no behavioural changes to v1.0 exports.

| File | Tests | Coverage |
| ---- | ----- | -------- |
| `gamut.test.js` | 19 | MINDE identity on in-gamut / chroma reduction on out-of-gamut / L endpoint collapse / C=0 achromatic / aliasing safety / arbitrary offsets / determinism / hue sweep in-gamut invariant; packMINDE unsigned uint32 return / default-alpha behaviour / alpha clamping / endpoint byte encoding / no hue-shift on out-of-gamut / bit-for-bit parity with core packer on in-gamut input / drop-in usable with `bakeGradientToUint32` / hot-path smoothness |
| `remap.test.js` | 21 | OKLCH↔OKLab round-trip within 1e-5 / hue canonicalization; sRgba8ToOklab endpoint correctness / batch stride / plain `Uint8Array` acceptance; nearestPaletteIndex exact match / lowest-index tie-break / preserveLightness path separation / explicit `false` matches default / batch correctness / typed-array flexibility (`Uint32Array`, `Uint16Array`, `Uint8Array`); remapPixels solid-fill correctness / primary-color mapping / preserveLightness output darkness / alpha passthrough (both paths) / determinism / scratch-grow safety |
| `delta.test.js` | 10 | Identity / symmetry / non-negativity / large ΔE between visually distant colors / small ΔE between near-identical colors / offset correctness / hue wraparound (1° vs 359°) / monotonic growth with diverging chroma / determinism |

### Non-breaking

Additive only. No existing API surface changed. v1.0 consumers continue to work identically at `1.1.0`.

### Packaging

- Added sub-export entries for `./gamut` and `./remap` in `package.json` `exports`, with `types`/`node`/`import`/`default` conditions.
- Added `CHANGELOG.md` to the `files` list.
- Fixed a pre-existing typo: `files` listed `LICENSE.txt` where the actual file is `LICENSE.md`.

### Downstream migrations enabled

- `@zakkster/lite-hueforge` can replace its local gamut mapper (if present) with an import from `@zakkster/lite-color-engine/gamut`.
- `@zakkster/lite-gradient-studio` same.
- `@zakkster/lite-color-lerp` can finally fulfil the README's "gamut-mapped variants … a future addition" promise via the engine.
- `@zakkster/lite-hueforge v1.3` `remapImageToPalette` sits directly on top of `remapPixelsToPalette`.


## [1.0.4] — Prior

Baseline v1.0 surface: authoring (`parseCSSColor` and format-specific parsers), runtime (`lerpOklchBuffer`, `packOklchBufferToUint32`, `packOklchBufferToUint32Fast`, `sampleColorLUT`), LUT (`bakeGradientToUint32`), convert (`sRgbToOklchBuffer`).

---

MIT © Zahary Shinikchiev.
