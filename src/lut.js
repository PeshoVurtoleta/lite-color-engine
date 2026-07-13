import { lerpOklchBuffer, packOklchBufferToUint32 } from './runtime.js';

/**
 * Bakes a multi-stop OKLCH gradient into a ready-to-render `Uint32Array`.
 *
 * The output is in little-endian RGBA byte order — drop it directly into a
 * `Uint32Array` view of `Canvas ImageData`, or `texImage2D` with `RGBA / UNSIGNED_BYTE`.
 *
 * **Open mode (default):** stop _i_ is at `i / (numStops - 1)`; LUT sample _j_
 * is at `j / (resolution - 1)`. Sample 0 lands on stop 0, sample `resolution-1`
 * lands on the last stop. Overshoot from `easeFn` is clamped to `[0, 1]`.
 *
 * **Closed mode** (`opts.closed = true`, new in v1.5): stops are treated
 * cyclically — the wrap segment runs from `stops[numStops-1]` back to
 * `stops[0]`. Sample _j_ is at `j / resolution` (period spacing, no duplicated
 * endpoint), so `sample[resolution-1]` sits just before wrapping back to
 * sample 0. This is the LUT baked by hue-wheel gradients / cyclic colorways —
 * pair it with `sampleColorLUTWrapped` on the consumer side. `easeFn` outputs
 * in closed mode are wrapped via `t - floor(t)` (period) instead of clamped.
 *
 * @param {Float32Array} keyframesBuf - Contiguous buffer of `[L0, C0, H0, L1, C1, H1, ...]`
 * @param {number} numStops - Count of color stops in the buffer (must be >= 2)
 * @param {number} [resolution=256] - Number of LUT entries to bake (must be >= 2)
 * @param {(t: number) => number} [easeFn] - Optional easing applied to `t` before stop selection
 * @param {(buf: Float32Array, offset: number, alpha?: number) => number} [packer]
 *        Optional packer override. Defaults to the accurate `packOklchBufferToUint32`.
 *        Pass `packOklchBufferToUint32Fast` for ~2x throughput at the cost of round-trip accuracy.
 * @param {{ closed?: boolean }} [opts]
 *        Optional bake options. `closed: true` bakes a cyclic LUT (see above).
 * @returns {Uint32Array} LUT of 32-bit packed colors
 * @throws If `numStops < 2` or `resolution < 2`
 */
export const bakeGradientToUint32 = (
    keyframesBuf,
    numStops,
    resolution = 256,
    easeFn,
    packer = packOklchBufferToUint32,
    opts
) => {
    if (numStops < 2) {
        throw new Error('lite-color-engine: bakeGradientToUint32 requires numStops >= 2');
    }
    if (resolution < 2) {
        throw new Error('lite-color-engine: bakeGradientToUint32 requires resolution >= 2');
    }

    const closed = opts != null && opts.closed === true;
    const outLUT = new Uint32Array(resolution);
    const tempOklch = new Float32Array(3);

    // Open: N-1 segments, samples at i/(res-1), t clamped to [0,1].
    // Closed: N segments (last wraps last->first), samples at i/res, t period-wrapped.
    const step = closed ? 1 / resolution : 1 / (resolution - 1);
    const scale = closed ? numStops : (numStops - 1);
    const maxIndex = closed ? (numStops - 1) : (numStops - 2);
    const wrapIndex = numStops - 1; // only meaningful in closed mode
    const hasEase = typeof easeFn === 'function';

    for (let i = 0; i < resolution; i++) {
        const rawT = i * step;
        let t = hasEase ? easeFn(rawT) : rawT;

        if (closed) {
            // Period wrap: `t - floor(t)` maps R to [0, 1). Handles ease overshoot
            // and negative outputs uniformly; the cyclic contract has no clamp.
            t = t - Math.floor(t);
        } else {
            // LUTs are fixed-resolution; overshoot/undershoot is undefined and
            // would either NaN-poison the buffer or extrapolate silently.
            if (t < 0) t = 0;
            else if (t > 1) t = 1;
        }

        const scaledT = t * scale;
        let index = scaledT | 0; // bitwise fast-floor for non-negative values
        if (index > maxIndex) index = maxIndex;

        const localT = scaledT - index;
        const offsetA = index * 3;
        // Closed mode: the wrap segment (last -> first) reads keyframe 0 as B.
        const offsetB = (closed && index === wrapIndex) ? 0 : offsetA + 3;

        lerpOklchBuffer(keyframesBuf, offsetA, keyframesBuf, offsetB, localT, tempOklch, 0);
        outLUT[i] = packer(tempOklch, 0, 1.0);
    }

    return outLUT;
};
