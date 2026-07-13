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
 * Batch sibling of {@link lerpOklchBuffer}. Interpolates `n` consecutive OKLCH
 * triplets (stride 3) with a single shared `t`, amortizing per-call overhead
 * across large particle systems (100k+ entities).
 *
 * For each i in [0, n): lerps a[offA + i*3 ..] with b[offB + i*3 ..] into
 * out[offOut + i*3 ..]. Per-triplet math is identical to the scalar version,
 * so results are bit-for-bit equal to calling it n times.
 *
 * In-place is safe (a === out, offA === offOut): each iteration reads its three
 * source lanes before writing them. Zero allocations; monomorphic hot loop.
 *
 * @param {Float32Array} a - Source buffer A
 * @param {number} offA - Base offset of the first color in A
 * @param {Float32Array} b - Source buffer B
 * @param {number} offB - Base offset of the first color in B
 * @param {number} t - Interpolation factor [0, 1] (extrapolates then clamps)
 * @param {Float32Array} out - Destination buffer
 * @param {number} offOut - Base offset of the first output color
 * @param {number} n - Number of triplets to process (n <= 0 is a no-op)
 * @returns {void}
 */
export const lerpOklchBufferN = (a, offA, b, offB, t, out, offOut, n) => {
    if (n <= 0) return;
    for (let i = 0; i < n; i++) {
        const ia = offA + i * 3;
        const ib = offB + i * 3;
        const io = offOut + i * 3;

        const l = lerp(a[ia], b[ib], t);
        out[io] = l < 0 ? 0 : (l > 1 ? 1 : l);

        const c = lerp(a[ia + 1], b[ib + 1], t);
        out[io + 1] = c < 0 ? 0 : c;

        let h = lerpAngle(a[ia + 2], b[ib + 2], t);
        h = h % 360;
        out[io + 2] = h < 0 ? h + 360 : h;
    }
};

/**
 * Internal: shared OKLCH -> linear sRGB kernel.
 * Inlined into every sRGB pack variant so V8 monomorphizes it.
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

    // Hard gamut clamp (fast path; MINDE chroma reduction lives on the /gamut subpath).
    outRgb[0] = r < 0 ? 0 : (r > 1 ? 1 : r);
    outRgb[1] = g < 0 ? 0 : (g > 1 ? 1 : g);
    outRgb[2] = b < 0 ? 0 : (b > 1 ? 1 : b);
};

// Module-level scratch (zero-GC: single allocation at module load).
const _scratchRgb = new Float32Array(3);
const _scratchRgbP3 = new Float32Array(3);

/**
 * Precomputed 4096-entry LUT for the sRGB transfer (linear -> encoded byte).
 * Entry i corresponds to linear value i/4095, so the table spans [0, 1] exactly.
 * The linear branch (slope 12.92) is the steepest region; at 4096 samples its
 * per-step delta is < 1 byte, so nearest-index lookups stay within ~1 LSB of
 * the exact pow() encoding. One-time module-load cost, then O(1) lookup.
 * @internal
 */
/**
 * The sRGB / Display P3 transfer function (IEC 61966-2-1), returning the
 * gamma-encoded value in [0, 1] rather than a rounded byte. This is the single
 * definition of the EOTF constants for every encoded-domain caller; the dither
 * packers need the sub-integer value, so they cannot go through
 * linearToSrgbByte (which rounds) or SRGB_LUT (which stores rounded bytes).
 *
 * @param {number} c - Linear-light channel, already clamped to [0, 1]
 * @returns {number} Gamma-encoded channel in [0, 1]
 */
const srgbEncode = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

const SRGB_LUT = new Uint8ClampedArray(4096);
{
    for (let i = 0; i < 4096; i++) {
        const c = i / 4095;
        const enc = srgbEncode(c);
        SRGB_LUT[i] = (enc * 255 + 0.5) | 0;
    }
}

/**
 * LUT-based linear-to-sRGB byte using nearest-index lookup. Near-exact (~1 LSB)
 * versus {@link linearToSrgbByte} but branch-free and pow-free on the hot path.
 * @internal
 */
const linearToSrgbByteLut = (c) => {
    if (c <= 0) return 0;
    if (c >= 1) return 255;
    return SRGB_LUT[(c * 4095 + 0.5) | 0];
};

// -- Blue-noise tile (void-and-cluster, 64x64) -------------------------------
// Generator: tools/generate-bluenoise.mjs v1.1.0, seed 0xc0ffee1e.
// SHA-256 of decoded tile: 8867ddb65e16379ad42244fa24b82dcbd813c684ce14944f86a9e3e8f6b72968
// Histogram: each byte 0..255 appears exactly 16 times (4096/256).
// Spectral: gated by test/bluenoise-spectral.test.js -- minority-phase clumpiness
// stays under 0.70 across T=16..240 and is symmetric about T=128, and radial power
// for r<=4 sits below 0.02 (the white-noise floor is 0.083). The fingerprint above
// pins a tile that PASSES those gates; it is not a substitute for them.
// The base64 form is 5464 chars; decoded lazily on first access into a shared,
// read-only Uint8Array(4096). Do not mutate the returned reference.
const BLUE_NOISE_64_B64 =
    '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';

let _blueNoise64 = null;
/**
 * Returns the shared 64x64 blue-noise tile as a `Uint8Array(4096)`, decoded
 * once on first call from an inlined base64 blob and reused thereafter.
 *
 * Index a pixel via `tile[(y & 63) << 6 | (x & 63)]`. The tile is torus-tileable:
 * repeating it end-to-end on either axis is spectrally seamless. Each byte value
 * 0..255 appears exactly 16 times (uniform histogram, 4096/256), so
 * `noise01 = byte / 256` gives a low-discrepancy sample in `[0, 1)` that has
 * exactly the mean and variance of a uniform distribution over 256 buckets.
 *
 * The tile is generated by `tools/generate-bluenoise.mjs` (void-and-cluster,
 * Ulichney 1993) and committed as a base64 blob; decode is sub-millisecond.
 * The returned reference is shared and must not be mutated; callers that need
 * to modify the values should copy first.
 *
 * @returns {Uint8Array} 4096-entry blue-noise tile (row-major, 64 wide)
 */
export const getBlueNoise64 = () => {
    if (_blueNoise64 !== null) return _blueNoise64;
    // Node has Buffer; browsers/DOM have atob. Prefer Buffer when available
    // (faster and does not throw on stray whitespace) and fall back to atob.
    const b64 = BLUE_NOISE_64_B64;
    // Read Buffer off globalThis rather than as a free identifier: webpack 4 and
    // browserify pattern-match the bare `Buffer` token and inject the ~20 KB buffer
    // polyfill into browser bundles. `globalThis.Buffer` is not matched, so a
    // browser build stays on the atob path and the package stays zero-cost.
    const NodeBuffer = globalThis.Buffer;
    let bytes;
    if (NodeBuffer !== undefined && typeof NodeBuffer.from === 'function') {
        const buf = NodeBuffer.from(b64, 'base64');
        bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } else {
        // atob path (browsers / non-Node runtimes)
        const bin = atob(b64);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    }
    // Copy into a stable, standalone Uint8Array (avoids sharing with Buffer's pool)
    _blueNoise64 = new Uint8Array(bytes);
    return _blueNoise64;
};

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
    const enc = srgbEncode(c);
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
 * Dithered sibling of {@link packOklchBufferToUint32}. Applies a threshold-
 * offset dither in gamma-encoded space using a caller-supplied `noise01` value.
 *
 * The same `noise01` is applied to all three color channels (R, G, B) so the
 * dither is a **luminance pattern** — no chroma speckle. Alpha is undithered.
 *
 * Parity guarantee: when `noise01 === 0.5`, this returns the exact same 32-bit
 * value as {@link packOklchBufferToUint32} for the same inputs (the round-half
 * behavior collapses into the identical `floor(enc*255 + 0.5)` expression).
 * This is asserted by the test suite.
 *
 * The `noise01` argument is expected to be in `[0, 1)`; values >= 1 will be
 * folded to 255 by the byte clamp. When indexing the shared blue-noise tile,
 * derive it as `noiseTile[(y & 63) << 6 | (x & 63)] / 256` — this yields
 * values in `[0, 255/256]` and never overflows a byte.
 *
 * Both trailing arguments default so that a call with the plain packer's arity
 * behaves like the plain packer instead of silently producing transparent black:
 * `packOklchBufferToUint32Dithered(buf, off)` === `packOklchBufferToUint32(buf, off)`.
 *
 * @param {Float32Array} buf - Buffer containing the OKLCH triplet
 * @param {number} offset - Start index in the buffer
 * @param {number} [alpha=1.0] - Alpha [0, 1]; values outside the range are clamped
 * @param {number} [noise01=0.5] - Dither threshold offset in `[0, 1)`; 0.5 = no dither
 * @returns {number} 32-bit unsigned integer (little-endian RGBA byte order)
 */
export const packOklchBufferToUint32Dithered = (buf, offset, alpha = 1.0, noise01 = 0.5) => {
    oklchToLinearSrgbClamped(buf[offset], buf[offset + 1], buf[offset + 2], _scratchRgb);
    const cr = _scratchRgb[0], cg = _scratchRgb[1], cb = _scratchRgb[2];
    // Gamma-encode (mirrors linearToSrgbByte but without the final *255-round step)
    const encR = srgbEncode(cr);
    const encG = srgbEncode(cg);
    const encB = srgbEncode(cb);
    // Shared noise offset per pixel; floor via `| 0` (safe for non-negative values).
    let r8 = (encR * 255 + noise01) | 0; if (r8 > 255) r8 = 255;
    let g8 = (encG * 255 + noise01) | 0; if (g8 > 255) g8 = 255;
    let b8 = (encB * 255 + noise01) | 0; if (b8 > 255) b8 = 255;
    const a8 = alpha <= 0 ? 0 : (alpha >= 1 ? 255 : (alpha * 255 + 0.5) | 0);
    return ((a8 << 24) | (b8 << 16) | (g8 << 8) | r8) >>> 0;
};

/**
 * Batch sibling of {@link packOklchBufferToUint32}. Packs `n` OKLCH triplets
 * (stride 3, from `src`) into `n` consecutive Uint32 pixels (stride 1, into
 * `dst`) - the shape a SoA particle system feeds straight into `ImageData`.
 *
 * With `useLut=false` the output is bit-for-bit identical to calling
 * {@link packOklchBufferToUint32} n times. With `useLut=true` it uses the 4k
 * transfer LUT: near-exact (~1 LSB) at close to fast-packer throughput, with a
 * single one-time table allocation and no per-color pow(). The branch is hoisted
 * out of the loop so each variant stays monomorphic.
 *
 * @param {Float32Array} src - Source OKLCH buffer (stride 3)
 * @param {number} offSrc - Base offset of the first triplet in src
 * @param {Uint32Array} dst - Destination packed-color buffer (stride 1)
 * @param {number} offDst - Base offset of the first packed color in dst
 * @param {number} n - Number of colors to pack (n <= 0 is a no-op)
 * @param {number} [alpha=1.0] - Shared alpha for all n colors
 * @param {boolean} [useLut=false] - Opt in to the 4k LUT transfer (near-exact, faster)
 * @returns {void}
 */
export const packOklchBufferToUint32IntoN = (src, offSrc, dst, offDst, n, alpha = 1.0, useLut = false) => {
    if (n <= 0) return;
    const a8 = alpha <= 0 ? 0 : (alpha >= 1 ? 255 : (alpha * 255 + 0.5) | 0);
    const aHi = a8 << 24;

    if (useLut) {
        for (let i = 0; i < n; i++) {
            const io = offSrc + i * 3;
            oklchToLinearSrgbClamped(src[io], src[io + 1], src[io + 2], _scratchRgb);
            const r8 = linearToSrgbByteLut(_scratchRgb[0]);
            const g8 = linearToSrgbByteLut(_scratchRgb[1]);
            const b8 = linearToSrgbByteLut(_scratchRgb[2]);
            dst[offDst + i] = (aHi | (b8 << 16) | (g8 << 8) | r8) >>> 0;
        }
    } else {
        for (let i = 0; i < n; i++) {
            const io = offSrc + i * 3;
            oklchToLinearSrgbClamped(src[io], src[io + 1], src[io + 2], _scratchRgb);
            const r8 = linearToSrgbByte(_scratchRgb[0]);
            const g8 = linearToSrgbByte(_scratchRgb[1]);
            const b8 = linearToSrgbByte(_scratchRgb[2]);
            dst[offDst + i] = (aHi | (b8 << 16) | (g8 << 8) | r8) >>> 0;
        }
    }
};

/**
 * Batch dithered sibling of {@link packOklchBufferToUint32IntoN}. Packs `n`
 * OKLCH triplets into `n` Uint32 pixels while walking a 64x64 blue-noise tile
 * in row-major order, applying a per-pixel luminance-patterned threshold
 * dither (same noise value across R/G/B; alpha undithered).
 *
 * Pixel `i` in the batch is treated as destination position `(x0 + col, y0 + row)`,
 * where `col = i % rowWidth` and `row = (i / rowWidth) | 0`. The tile is indexed
 * torus-style: `tile[((y & 63) << 6) | (x & 63)]`, so any `x0`/`y0`/`rowWidth`
 * combination is safe — the tile just wraps.
 *
 * The dither is applied in gamma-encoded space so it perturbs perceptual (not
 * linear) intensity — visually correct on 8-bit sRGB displays.
 *
 * **On useLut:** the non-dithered batch (`packOklchBufferToUint32IntoN`) has a
 * `useLut` flag that swaps the exact `pow()` transfer for the 4k LUT. That LUT
 * stores *rounded bytes*, which discards the sub-integer information the
 * dither threshold needs. Enabling it here would silently degrade dither to
 * plain rounding. A future v1.6 candidate is a companion `Float32Array` LUT
 * of encoded floats (~16 KB) that would restore this axis; deferred to keep
 * v1.5 surface tight. This function therefore uses the exact encoder only.
 *
 * Zero allocations; the tile-walk state is a pair of integer locals, no modulo
 * or division in the hot loop.
 *
 * @param {Float32Array} src - Source OKLCH buffer (stride 3)
 * @param {number} offSrc - Base offset of the first triplet in src
 * @param {Uint32Array} dst - Destination packed-color buffer (stride 1)
 * @param {number} offDst - Base offset of the first packed color in dst
 * @param {number} n - Number of colors to pack (n <= 0 is a no-op)
 * @param {number} alpha - Shared alpha [0, 1] for all n colors
 * @param {Uint8Array} noiseTile - 64x64 blue-noise tile (from {@link getBlueNoise64})
 * @param {number} x0 - Starting destination column
 * @param {number} y0 - Starting destination row
 * @param {number} rowWidth - Pixels per destination row (wrap point for column)
 * @returns {void}
 */
export const packOklchBufferToUint32IntoNDithered = (
    src, offSrc, dst, offDst, n, alpha, noiseTile, x0, y0, rowWidth
) => {
    if (n <= 0) return;
    const a8 = alpha <= 0 ? 0 : (alpha >= 1 ? 255 : (alpha * 255 + 0.5) | 0);
    const aHi = a8 << 24;
    const NOISE_SCALE = 1 / 256;
    const startCol = x0 | 0;
    const wrapAt = startCol + (rowWidth | 0);
    let px = startCol, py = y0 | 0;

    for (let i = 0; i < n; i++) {
        const io = offSrc + i * 3;
        oklchToLinearSrgbClamped(src[io], src[io + 1], src[io + 2], _scratchRgb);
        // Blue-noise sample, torus-indexed
        const noise01 = noiseTile[((py & 63) << 6) | (px & 63)] * NOISE_SCALE;
        // Exact gamma encode; shared noise offset across R/G/B (luminance dither)
        const cr = _scratchRgb[0], cg = _scratchRgb[1], cb = _scratchRgb[2];
        const encR = srgbEncode(cr);
        const encG = srgbEncode(cg);
        const encB = srgbEncode(cb);
        let r8 = (encR * 255 + noise01) | 0; if (r8 > 255) r8 = 255;
        let g8 = (encG * 255 + noise01) | 0; if (g8 > 255) g8 = 255;
        let b8 = (encB * 255 + noise01) | 0; if (b8 > 255) b8 = 255;
        dst[offDst + i] = (aHi | (b8 << 16) | (g8 << 8) | r8) >>> 0;
        // Advance pixel position; wrap column at row edge
        px++;
        if (px === wrapAt) { px = startCol; py++; }
    }
};

/**
 * Internal helper: OKLCH -> linear Display P3 with hard clamp to [0, 1].
 * Mirrors oklchToLinearSrgbClamped but targets the wider P3 gamut.
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
 * Batch sibling of {@link packOklchBufferToUint32P3}. Packs `n` OKLCH triplets
 * (stride 3) into `n` consecutive Uint32 pixels encoded for **Display P3**.
 *
 * With `useLut=false` the output is bit-for-bit identical to calling
 * {@link packOklchBufferToUint32P3} n times. With `useLut=true` it uses the
 * shared 4k transfer LUT (the P3 transfer function is identical to sRGB per
 * IEC 61966-2-1, so no separate table is allocated). Near-exact within ~1 LSB
 * at close to fast-packer throughput; the branch is hoisted out of the loop
 * so each variant stays monomorphic.
 *
 * @param {Float32Array} src - Source OKLCH buffer (stride 3)
 * @param {number} offSrc - Base offset of the first triplet in src
 * @param {Uint32Array} dst - Destination packed-color buffer (stride 1)
 * @param {number} offDst - Base offset of the first packed color in dst
 * @param {number} n - Number of colors to pack (n <= 0 is a no-op)
 * @param {number} [alpha=1.0] - Shared alpha for all n colors
 * @param {boolean} [useLut=false] - Opt in to the 4k transfer LUT (near-exact, faster)
 * @returns {void}
 */
export const packOklchBufferToUint32P3IntoN = (src, offSrc, dst, offDst, n, alpha = 1.0, useLut = false) => {
    if (n <= 0) return;
    const a8 = alpha <= 0 ? 0 : (alpha >= 1 ? 255 : (alpha * 255 + 0.5) | 0);
    const aHi = a8 << 24;

    if (useLut) {
        for (let i = 0; i < n; i++) {
            const io = offSrc + i * 3;
            oklchToLinearP3Clamped(src[io], src[io + 1], src[io + 2], _scratchRgbP3);
            const r8 = linearToSrgbByteLut(_scratchRgbP3[0]);
            const g8 = linearToSrgbByteLut(_scratchRgbP3[1]);
            const b8 = linearToSrgbByteLut(_scratchRgbP3[2]);
            dst[offDst + i] = (aHi | (b8 << 16) | (g8 << 8) | r8) >>> 0;
        }
    } else {
        for (let i = 0; i < n; i++) {
            const io = offSrc + i * 3;
            oklchToLinearP3Clamped(src[io], src[io + 1], src[io + 2], _scratchRgbP3);
            const r8 = linearToSrgbByte(_scratchRgbP3[0]);
            const g8 = linearToSrgbByte(_scratchRgbP3[1]);
            const b8 = linearToSrgbByte(_scratchRgbP3[2]);
            dst[offDst + i] = (aHi | (b8 << 16) | (g8 << 8) | r8) >>> 0;
        }
    }
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
