import { lerpOklchBuffer, packOklchBufferToUint32 } from './runtime.js';

/**
 * Bakes a multi-stop OKLCH gradient into a ready-to-render `Uint32Array`.
 *
 * The output is in little-endian RGBA byte order — drop it directly into a
 * `Uint32Array` view of `Canvas ImageData`, or `texImage2D` with `RGBA / UNSIGNED_BYTE`.
 *
 * Stops are evenly spaced across the gradient (stop _i_ is at `i / (numStops - 1)`).
 * The optional `easeFn` warps the parametric position **before** stop selection,
 * letting you bias which stop dominates which range of the LUT. Easing outputs
 * outside `[0, 1]` are clamped (the LUT is fixed-resolution and cannot
 * represent overshoot).
 *
 * @param {Float32Array} keyframesBuf - Contiguous buffer of `[L0, C0, H0, L1, C1, H1, ...]`
 * @param {number} numStops - Count of color stops in the buffer (must be >= 2)
 * @param {number} [resolution=256] - Number of LUT entries to bake (must be >= 2)
 * @param {(t: number) => number} [easeFn] - Optional easing applied to `t` before stop selection
 * @param {(buf: Float32Array, offset: number, alpha?: number) => number} [packer]
 *        Optional packer override. Defaults to the accurate `packOklchBufferToUint32`.
 *        Pass `packOklchBufferToUint32Fast` for ~2x throughput at the cost of round-trip accuracy.
 * @returns {Uint32Array} LUT of 32-bit packed colors
 * @throws If `numStops < 2` or `resolution < 2`
 */
export const bakeGradientToUint32 = (
    keyframesBuf,
    numStops,
    resolution = 256,
    easeFn,
    packer = packOklchBufferToUint32
) => {
    if (numStops < 2) {
        throw new Error('lite-color-engine: bakeGradientToUint32 requires numStops >= 2');
    }
    if (resolution < 2) {
        throw new Error('lite-color-engine: bakeGradientToUint32 requires resolution >= 2');
    }

    const outLUT = new Uint32Array(resolution);
    const tempOklch = new Float32Array(3);

    const step = 1 / (resolution - 1);
    const last = numStops - 1;
    const hasEase = typeof easeFn === 'function';

    for (let i = 0; i < resolution; i++) {
        const rawT = i * step;
        let t = hasEase ? easeFn(rawT) : rawT;

        // LUTs are fixed-resolution; overshoot/undershoot is undefined and
        // would either NaN-poison the buffer or extrapolate silently.
        if (t < 0) t = 0;
        else if (t > 1) t = 1;

        const scaledT = t * last;
        let index = scaledT | 0; // bitwise fast-floor for positive values
        if (index >= last) index = last - 1;

        const localT = scaledT - index;
        const offsetA = index * 3;
        const offsetB = offsetA + 3;

        lerpOklchBuffer(keyframesBuf, offsetA, keyframesBuf, offsetB, localT, tempOklch, 0);
        outLUT[i] = packer(tempOklch, 0, 1.0);
    }

    return outLUT;
};
