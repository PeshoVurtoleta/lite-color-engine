import { lerp, lerpAngle } from '@zakkster/lite-lerp';
import { oklchToLinearP3 } from './convert.js';

const DEG_TO_RAD = Math.PI / 180;

/**
 * Zero-GC, cache-friendly OKLCH buffer interpolation.
 *
 * Hue is canonicalized to [0, 360) via `lerpAngle` (shortest-path) so gradients
 * never wrap the long way around the color wheel. Lightness is hard-clamped
 * to [0, 1] and chroma to [0, +inf).
 *
 * Source and destination may be the same buffer at different offsets.
 *
 * @param {Float32Array} bufA - Source buffer A (must contain L, C, H at offsetA)
 * @param {number} offsetA - Start index of color A in bufA
 * @param {Float32Array} bufB - Source buffer B (must contain L, C, H at offsetB)
 * @param {number} offsetB - Start index of color B in bufB
 * @param {number} t - Interpolation factor; values outside [0, 1] extrapolate then clamp
 * @param {Float32Array} outBuf - Destination buffer
 * @param {number} outOffset - Start index of output L, C, H
 * @returns {void}
 */
export const lerpOklchBuffer = (bufA, offsetA, bufB, offsetB, t, outBuf, outOffset) => {
    // Lightness [0, 1]
    const l = lerp(bufA[offsetA], bufB[offsetB], t);
    outBuf[outOffset] = l < 0 ? 0 : (l > 1 ? 1 : l);

    // Chroma (clamp >= 0)
    const c = lerp(bufA[offsetA + 1], bufB[offsetB + 1], t);
    outBuf[outOffset + 1] = c < 0 ? 0 : c;

    // Hue (shortest path, canonicalized)
    let h = lerpAngle(bufA[offsetA + 2], bufB[offsetB + 2], t);
    h = h % 360;
    outBuf[outOffset + 2] = h < 0 ? h + 360 : h;
};

/**
 * Internal: shared OKLCH -> linear sRGB kernel.
 * Inlined into both pack variants for V8 to monomorphize.
 *
 * Returns a 3-tuple via `outRgb` (length 3). Strictly clamped to [0, 1].
 * @internal
 */
const oklchToLinearSrgbClamped = (l, c, h, outRgb) => {
    const hRad = h * DEG_TO_RAD;
    const a_lab = c * Math.cos(hRad);
    const b_lab = c * Math.sin(hRad);

    const l_ = l + 0.3963377774 * a_lab + 0.2158037573 * b_lab;
    const m_ = l - 0.1055613458 * a_lab - 0.0638541728 * b_lab;
    const s_ = l - 0.0894841775 * a_lab - 1.2914855480 * b_lab;

    const lms_l = l_ * l_ * l_;
    const lms_m = m_ * m_ * m_;
    const lms_s = s_ * s_ * s_;

    const r =  4.0767416621 * lms_l - 3.3077115913 * lms_m + 0.2309699292 * lms_s;
    const g = -1.2684380046 * lms_l + 2.6097574011 * lms_m - 0.3413193965 * lms_s;
    const b = -0.0041960863 * lms_l - 0.7034186147 * lms_m + 1.7076147010 * lms_s;

    // Hard gamut clamp (fast path; replaces the expensive MINDE algorithm).
    outRgb[0] = r < 0 ? 0 : (r > 1 ? 1 : r);
    outRgb[1] = g < 0 ? 0 : (g > 1 ? 1 : g);
    outRgb[2] = b < 0 ? 0 : (b > 1 ? 1 : b);
};

// Module-level scratch (zero-GC: single allocation at module load).
const _scratchRgb = new Float32Array(3);
const _scratchRgbP3 = new Float32Array(3);

/**
 * Encodes a linear-light channel (already clamped to [0, 1]) to an sRGB
 * 8-bit byte using the proper IEC 61966-2-1 transfer function. Round-tripping
 * sRGB(255-bytes) -> OKLCH -> here recovers the original byte exactly.
 *
 * This is also the correct transfer function for Display P3.
 * @internal
 */
const linearToSrgbByte = (c) => {
    if (c <= 0) return 0;
    if (c >= 1) return 255;
    const enc = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return (enc * 255 + 0.5) | 0;
};

/**
 * Converts an OKLCH buffer triplet to a 32-bit unsigned integer in
 * little-endian RGBA byte order - the format consumed directly by a
 * `Uint32Array` view of `Canvas ImageData`.
 *
 * Uses the proper sRGB transfer function (`pow(c, 1/2.4)` branch). For a
 * `Math.sqrt`-approximated 2x-faster variant (with a ~10/255 mid-tone
 * round-trip error) see {@link packOklchBufferToUint32Fast}.
 *
 * @param {Float32Array} buf - Buffer containing the OKLCH triplet
 * @param {number} offset - Start index in the buffer
 * @param {number} [alpha=1.0] - Alpha [0, 1]; values outside the range are clamped
 * @returns {number} 32-bit unsigned integer (`>>> 0` so the high bit is non-negative)
 */
export const packOklchBufferToUint32 = (buf, offset, alpha = 1.0) => {
    oklchToLinearSrgbClamped(buf[offset], buf[offset + 1], buf[offset + 2], _scratchRgb);
    const r8 = linearToSrgbByte(_scratchRgb[0]);
    const g8 = linearToSrgbByte(_scratchRgb[1]);
    const b8 = linearToSrgbByte(_scratchRgb[2]);
    const a8 = alpha <= 0 ? 0 : (alpha >= 1 ? 255 : (alpha * 255 + 0.5) | 0);
    // Little-endian byte order in memory: [R, G, B, A].
    return ((a8 << 24) | (b8 << 16) | (g8 << 8) | r8) >>> 0;
};

/**
 * Faster, less accurate sibling of {@link packOklchBufferToUint32}.
 *
 * Substitutes `Math.sqrt(c)` for the proper sRGB transfer `pow(c, 1/2.4)`.
 * Roughly 2x throughput on V8 in tight loops. The visual cost is non-trivial:
 * a pure mid-gray (#808080) round-trips to about #767676 (a ~10/255 darkening),
 * and warm midtones (browns, golds) shift toward black.
 *
 * Use this when you are baking thousands of particle colors per frame and the
 * end pixel will be alpha-blended on top of arbitrary content. **Avoid** when
 * you need the OKLCH input to round-trip back to its source sRGB.
 *
 * @param {Float32Array} buf - Buffer containing the OKLCH triplet
 * @param {number} offset - Start index in the buffer
 * @param {number} [alpha=1.0] - Alpha [0, 1]; values outside the range are clamped
 * @returns {number} 32-bit unsigned integer (little-endian RGBA byte order)
 */
export const packOklchBufferToUint32Fast = (buf, offset, alpha = 1.0) => {
    oklchToLinearSrgbClamped(buf[offset], buf[offset + 1], buf[offset + 2], _scratchRgb);
    const r8 = (Math.sqrt(_scratchRgb[0]) * 255) | 0;
    const g8 = (Math.sqrt(_scratchRgb[1]) * 255) | 0;
    const b8 = (Math.sqrt(_scratchRgb[2]) * 255) | 0;
    const a8 = alpha <= 0 ? 0 : (alpha >= 1 ? 255 : (alpha * 255) | 0);
    return ((a8 << 24) | (b8 << 16) | (g8 << 8) | r8) >>> 0;
};

/**
 * Internal helper: OKLCH -> linear Display P3 with hard clamp to [0,1].
 * Mirrors the structure of oklchToLinearSrgbClamped but targets the wider P3 gamut.
 * @internal
 */
const oklchToLinearP3Clamped = (l, c, h, outRgb) => {
    oklchToLinearP3(l, c, h, outRgb);
    outRgb[0] = outRgb[0] < 0 ? 0 : (outRgb[0] > 1 ? 1 : outRgb[0]);
    outRgb[1] = outRgb[1] < 0 ? 0 : (outRgb[1] > 1 ? 1 : outRgb[1]);
    outRgb[2] = outRgb[2] < 0 ? 0 : (outRgb[2] > 1 ? 1 : outRgb[2]);
};

/**
 * Converts an OKLCH buffer triplet to a 32-bit unsigned integer in
 * little-endian RGBA byte order, encoded for **Display P3** color space.
 *
 * Use this when your canvas context was created with `{ colorSpace: 'display-p3' }`.
 * Colors that are out of sRGB but inside P3 will be preserved with higher
 * saturation than the regular sRGB packers.
 *
 * The transfer function is identical to sRGB (IEC 61966-2-1).
 *
 * @param {Float32Array} buf - Buffer containing the OKLCH triplet
 * @param {number} offset - Start index in the buffer
 * @param {number} [alpha=1.0] - Alpha [0, 1]; values outside the range are clamped
 * @returns {number} 32-bit unsigned integer (little-endian RGBA byte order)
 */
export const packOklchBufferToUint32P3 = (buf, offset, alpha = 1.0) => {
    oklchToLinearP3Clamped(buf[offset], buf[offset + 1], buf[offset + 2], _scratchRgbP3);
    const r8 = linearToSrgbByte(_scratchRgbP3[0]);
    const g8 = linearToSrgbByte(_scratchRgbP3[1]);
    const b8 = linearToSrgbByte(_scratchRgbP3[2]);
    const a8 = alpha <= 0 ? 0 : (alpha >= 1 ? 255 : (alpha * 255 + 0.5) | 0);
    return ((a8 << 24) | (b8 << 16) | (g8 << 8) | r8) >>> 0;
};

/**
 * Faster, less accurate sibling of {@link packOklchBufferToUint32P3}.
 *
 * Uses `Math.sqrt` approximation for the transfer function (same trade-off as
 * the sRGB fast path). Useful for high-volume particle systems or when
 * baking many P3 gradients where absolute round-trip precision is not critical.
 *
 * @param {Float32Array} buf - Buffer containing the OKLCH triplet
 * @param {number} offset - Start index in the buffer
 * @param {number} [alpha=1.0] - Alpha [0, 1]; values outside the range are clamped
 * @returns {number} 32-bit unsigned integer (little-endian RGBA byte order)
 */
export const packOklchBufferToUint32P3Fast = (buf, offset, alpha = 1.0) => {
    oklchToLinearP3Clamped(buf[offset], buf[offset + 1], buf[offset + 2], _scratchRgbP3);
    const r8 = (Math.sqrt(_scratchRgbP3[0]) * 255) | 0;
    const g8 = (Math.sqrt(_scratchRgbP3[1]) * 255) | 0;
    const b8 = (Math.sqrt(_scratchRgbP3[2]) * 255) | 0;
    const a8 = alpha <= 0 ? 0 : (alpha >= 1 ? 255 : (alpha * 255) | 0);
    return ((a8 << 24) | (b8 << 16) | (g8 << 8) | r8) >>> 0;
};

/**
 * Zero-GC LUT sampler. Looks up a baked gradient color by `t` in [0, 1].
 *
 * Performs an inline clamp + bitwise-truncated index - no allocations, no
 * function calls, no bounds checks beyond the single comparison pair. Use
 * inside particle systems, shader-style canvas loops, etc.
 *
 * @param {Uint32Array} lut - LUT produced by {@link bakeGradientToUint32}
 * @param {number} t - Sample position in [0, 1]; values outside are clamped
 * @returns {number} 32-bit packed color (little-endian RGBA)
 */
export const sampleColorLUT = (lut, t) => {
    const tc = t < 0 ? 0 : (t > 1 ? 1 : t);
    return lut[(tc * (lut.length - 1)) | 0];
};
