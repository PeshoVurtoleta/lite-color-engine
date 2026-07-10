# @zakkster/lite-color-engine

**Zero-GC, data-oriented OKLCH color engine** for high-performance WebGL / Canvas pipelines.

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
