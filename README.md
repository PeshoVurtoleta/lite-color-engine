# @zakkster/lite-color-engine

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-color-engine.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-color-engine)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Hot%20path-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-color-engine?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-color-engine)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-color-engine?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-color-engine)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-color-engine?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-color-engine)
![Tree-Shakeable](https://img.shields.io/badge/tree--shakeable-yes-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

**Zero-GC, data-oriented OKLCH color engine** for high-performance WebGL / Canvas pipelines.

## v1.3 Highlights — Batch Kernels + 4k Transfer LUT

Built for the 100k-particle case: bulk buffer -> buffer operations plus an opt-in
transfer LUT that removes `pow()` from the hot path.

- `lerpOklchBufferN(a, offA, b, offB, t, out, offOut, n)` — interpolate `n` triplets in one call.
- `packOklchBufferToUint32IntoN(src, offSrc, dst, offDst, n, alpha?, useLut?)` — pack `n` OKLCH triplets straight into a `Uint32Array`.
- `useLut: true` opts into a precomputed 4096-entry sRGB transfer LUT — **~4.4x** the packing throughput of the accurate path, within **1 LSB** of exact. That is essentially Fast-packer speed at near-exact accuracy (the `sqrt` Fast packer drifts ~10/255). One module-load allocation; still zero-GC per frame.

**Honest note on batching.** The LUT is the real win. The batch functions themselves
mostly save ergonomics, not cycles: in V8 the accurate batch packer runs at essentially
the same speed as a scalar loop (the cost is `pow()`, not call overhead), and batch lerp
is only marginally faster. Reach for `useLut: true` when you need the speedup.

| Packing 100k OKLCH -> Uint32 / frame | Throughput | ms/frame |
|--------------------------------------|-----------|----------|
| scalar loop / batch accurate         | ~3.2M/s   | ~32 ms   |
| **batch + `useLut: true`**           | **~14M/s**| **~7 ms**|
| Fast (`sqrt`, ~10/255 error)         | ~15M/s    | ~7 ms    |

*(Node 22 / V8, 100k in-gamut triplets, median of 80 runs; browser V8 is comparable.
Reproduce with `node bench/benchmark.mjs`. Your numbers will vary.)*

## v1.2 Highlights — Wide Gamut + Accuracy Tiers

- Full `color(display-p3 r g b / alpha)` parsing support
- Dedicated high-accuracy `packOklchBufferToUint32P3()` and fast variant
- Three clear accuracy tiers for sRGB output:
  1. **Fast** — `packOklchBufferToUint32Fast`
  2. **Accurate-Clamp** — default `packOklchBufferToUint32`
  3. **Gamut-Mapped** — `packOklchBufferToUint32MINDE`

P3 output is **opt-in only** — never affects default paths or bundle size.

## Core Philosophy

Parse once at init → work with `Float32Array` OKLCH buffers → zero allocations on the hot path.

## Installation

```bash
npm install @zakkster/lite-color-engine
```

## Quick Start

```js
import { 
  parseCSSColor, 
  lerpOklchBuffer, 
  packOklchBufferToUint32,
  packOklchBufferToUint32P3 
} from '@zakkster/lite-color-engine';

const buf = new Float32Array(3);
parseCSSColor('color(display-p3 0.9 0.4 0.1)', buf, 0);

// Later in render loop (zero GC)
lerpOklchBuffer(bufA, 0, bufB, 0, t, temp, 0);
const pixel = packOklchBufferToUint32P3(temp, 0); // or packOklchBufferToUint32
```

### Batch (100k particles)

```js
import {
  lerpOklchBufferN,
  packOklchBufferToUint32IntoN
} from '@zakkster/lite-color-engine';

const N = 100000;
const from = new Float32Array(N * 3);   // OKLCH triplets
const to   = new Float32Array(N * 3);
const cur  = new Float32Array(N * 3);
const px   = new Uint32Array(N);        // -> view of ImageData

// Per frame, zero allocations:
lerpOklchBufferN(from, 0, to, 0, t, cur, 0, N);
packOklchBufferToUint32IntoN(cur, 0, px, 0, N, 1.0, /* useLut */ true);
// px now holds N packed RGBA pixels; blit via a Uint32Array view of ImageData.
```

## Accuracy Tiers

| Tier              | Function                        | Use Case                          | Trade-off          |
|-------------------|----------------------------------|-----------------------------------|--------------------|
| Fast              | `packOklchBufferToUint32Fast`   | Particles, high volume            | ~10/255 midtone error |
| Accurate-Clamp    | `packOklchBufferToUint32`       | Most UI / general use             | Hard clamp (hue shift near edge) |
| Gamut-Mapped      | `packOklchBufferToUint32MINDE`  | Critical gradients & authoring    | ~30x slower, best quality |

> `packOklchBufferToUint32MINDE` ships on the `/gamut` subpath:
> `import { packOklchBufferToUint32MINDE } from '@zakkster/lite-color-engine/gamut';`
> The `Fast`, `Accurate-Clamp`, and both `P3` packers come from the main entry.

For Display P3 output, use the `P3` variants.

## Documentation

See full API in `llms.txt` or the source `src/` files.

## License

MIT
