// -----------------------------------------------------------------------------
// @zakkster/lite-color-engine/gamut
//
// CSS Color 4 MINDE gamut mapping (chroma reduction in OKLab).
//
// Reference: https://www.w3.org/TR/css-color-4/#binsearch-gamut-mapping
// V1.1-PLAN P0/#1.
//
// Self-contained module: local internal converters, no cross-file imports.
// This costs ~40 lines of duplicated math but keeps the sub-export loadable
// in isolation and independent of any future refactor of src/converters.js.
// Fits the ecosystem's "duplicate small math, share only what earns it" rule.
//
// Trust model matches v1.0: buffers assumed well-shaped; L, C, H bounds
// enforced at write time (canonical hue in [0, 360), L clamped to [0, 1]).
// -----------------------------------------------------------------------------

const _RAD = Math.PI / 180;
const _DEG = 180 / Math.PI;

// Module-level scratch. Never allocated during a call.
const _rgb = new Float32Array(3);
const _clipLch = new Float32Array(3);

// CSS Color 4 constants.
const JND = 0.02;
const EPSILON = 0.0001;
const MAX_ITER = 8;

// OKLCH → linear sRGB, writes 3 floats to `out`.
function _oklchToLinearRgb(L, C, H, out) {
    const hRad = H * _RAD;
    const a = C * Math.cos(hRad);
    const b = C * Math.sin(hRad);
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;
    out[0] =  4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    out[1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    out[2] = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
}

// Linear sRGB → OKLCH, writes 3 floats [L, C, H] with H in [0, 360).
function _linearRgbToOklch(r, g, b, out, off) {
    const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
    const l_ = Math.cbrt(l);
    const m_ = Math.cbrt(m);
    const s_ = Math.cbrt(s);
    const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
    const A = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
    const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
    const C = Math.sqrt(A * A + B * B);
    let H = Math.atan2(B, A) * _DEG;
    if (H < 0) H += 360;
    out[off]     = L;
    out[off + 1] = C;
    out[off + 2] = H;
}

// sRGB gamma encode a linear channel to gamma-encoded [0, 1].
function _srgbGammaEncode(v) {
    if (v <= 0) return 0;
    if (v >= 1) return 1;
    return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

// Pre-declared bindings for tight ΔE-OK loops.
function _deltaOKFromLchLinearRgb(L, C, H, cR, cG, cB) {
    // Original OKLab (a, b) from OKLCH
    const hRad = H * _RAD;
    const oA = C * Math.cos(hRad);
    const oB = C * Math.sin(hRad);
    // Clipped in-gamut linear RGB → OKLab
    const l = 0.4122214708 * cR + 0.5363325363 * cG + 0.0514459929 * cB;
    const m = 0.2119034982 * cR + 0.6806995451 * cG + 0.1073969566 * cB;
    const s = 0.0883024619 * cR + 0.2817188376 * cG + 0.6299787005 * cB;
    const l_ = Math.cbrt(l);
    const m_ = Math.cbrt(m);
    const s_ = Math.cbrt(s);
    const cL = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
    const cA = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
    const cBB = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
    const dL = L - cL;
    const dA = oA - cA;
    const dB = oB - cBB;
    return Math.sqrt(dL * dL + dA * dA + dB * dB);
}


// -----------------------------------------------------------------------------
// gamutMapToSrgbBuffer
// -----------------------------------------------------------------------------

/**
 * CSS Color 4 chroma-reduction gamut mapping. Reduces chroma at fixed L and H
 * until the color is inside the sRGB gamut, using bisection with a JND
 * threshold. Zero allocations on the hot path.
 *
 * Writes gamut-mapped [L, C', H] at `outBuf[outOffset..outOffset+2]`.
 * Source and destination may alias.
 *
 * @param {Float32Array} inBuf
 * @param {number} inOffset
 * @param {Float32Array} outBuf
 * @param {number} outOffset
 */
export function gamutMapToSrgbBuffer(inBuf, inOffset, outBuf, outOffset) {
    const L = inBuf[inOffset];
    const C = inBuf[inOffset + 1];
    const H = inBuf[inOffset + 2];

    // Endpoints: L outside [0, 1] collapses to black or white in destination.
    if (L >= 1) {
        outBuf[outOffset] = 1;
        outBuf[outOffset + 1] = 0;
        outBuf[outOffset + 2] = H;
        return;
    }
    if (L <= 0) {
        outBuf[outOffset] = 0;
        outBuf[outOffset + 1] = 0;
        outBuf[outOffset + 2] = H;
        return;
    }
    if (C <= 0) {
        outBuf[outOffset] = L;
        outBuf[outOffset + 1] = 0;
        outBuf[outOffset + 2] = H;
        return;
    }

    // In-gamut? Emit unchanged.
    _oklchToLinearRgb(L, C, H, _rgb);
    if (
        _rgb[0] >= -EPSILON && _rgb[0] <= 1 + EPSILON &&
        _rgb[1] >= -EPSILON && _rgb[1] <= 1 + EPSILON &&
        _rgb[2] >= -EPSILON && _rgb[2] <= 1 + EPSILON
    ) {
        outBuf[outOffset]     = L;
        outBuf[outOffset + 1] = C;
        outBuf[outOffset + 2] = H;
        return;
    }

    // Full-chroma clip. If ΔE < JND, we're done — return the OKLCH of the clip.
    let cR = _rgb[0] < 0 ? 0 : _rgb[0] > 1 ? 1 : _rgb[0];
    let cG = _rgb[1] < 0 ? 0 : _rgb[1] > 1 ? 1 : _rgb[1];
    let cB = _rgb[2] < 0 ? 0 : _rgb[2] > 1 ? 1 : _rgb[2];
    if (_deltaOKFromLchLinearRgb(L, C, H, cR, cG, cB) < JND) {
        _linearRgbToOklch(cR, cG, cB, outBuf, outOffset);
        return;
    }

    // Bisection on chroma at fixed L, H.
    let low = 0;
    let high = C;
    for (let iter = 0; iter < MAX_ITER; iter++) {
        if (high - low < EPSILON) break;
        const mid = (low + high) * 0.5;
        _oklchToLinearRgb(L, mid, H, _rgb);
        const inGamut = (
            _rgb[0] >= -EPSILON && _rgb[0] <= 1 + EPSILON &&
            _rgb[1] >= -EPSILON && _rgb[1] <= 1 + EPSILON &&
            _rgb[2] >= -EPSILON && _rgb[2] <= 1 + EPSILON
        );
        if (inGamut) {
            low = mid;
        } else {
            cR = _rgb[0] < 0 ? 0 : _rgb[0] > 1 ? 1 : _rgb[0];
            cG = _rgb[1] < 0 ? 0 : _rgb[1] > 1 ? 1 : _rgb[1];
            cB = _rgb[2] < 0 ? 0 : _rgb[2] > 1 ? 1 : _rgb[2];
            if (_deltaOKFromLchLinearRgb(L, mid, H, cR, cG, cB) < JND) {
                _linearRgbToOklch(cR, cG, cB, outBuf, outOffset);
                return;
            }
            high = mid;
        }
    }

    // Converged: `low` is the largest in-gamut chroma at this (L, H).
    outBuf[outOffset]     = L;
    outBuf[outOffset + 1] = low;
    outBuf[outOffset + 2] = H;
}


// -----------------------------------------------------------------------------
// gamutMapToSrgbBufferN
// -----------------------------------------------------------------------------

/**
 * Batch sibling of {@link gamutMapToSrgbBuffer}. Maps `n` OKLCH triplets
 * (stride 3) from `inBuf` into `outBuf` at the equivalent stride, using the
 * same CSS Color 4 MINDE bisection as the scalar path. Bit-for-bit identical
 * to calling {@link gamutMapToSrgbBuffer} `n` times; the batch exists to
 * amortize call overhead when authoring / LUT-building large color runs
 * (hueforge P3 exporters, studio bake paths) that today loop the scalar.
 *
 * MINDE is ~30x slower than the core packer and stays out of the per-frame
 * hot path — this batch is a setup-time / bake-time convenience. Zero
 * allocations (reuses the module-level scratch). In-place is safe when
 * `inBuf === outBuf` at aligned offsets: each iteration reads its three
 * source lanes into `_rgb`/`_clipLch` scratch before writing back.
 *
 * @param {Float32Array} inBuf - Source OKLCH buffer (stride 3)
 * @param {number} inOffset - Base offset of the first triplet in inBuf
 * @param {Float32Array} outBuf - Destination OKLCH buffer (stride 3)
 * @param {number} outOffset - Base offset of the first triplet in outBuf
 * @param {number} n - Number of triplets to map (n <= 0 is a no-op)
 * @returns {void}
 */
export function gamutMapToSrgbBufferN(inBuf, inOffset, outBuf, outOffset, n) {
    if (n <= 0) return;
    for (let i = 0; i < n; i++) {
        gamutMapToSrgbBuffer(inBuf, inOffset + i * 3, outBuf, outOffset + i * 3);
    }
}


// -----------------------------------------------------------------------------
// packOklchBufferToUint32MINDE
// -----------------------------------------------------------------------------

/**
 * Drop-in accurate sibling of `packOklchBufferToUint32`. Runs MINDE gamut
 * mapping before packing, eliminating the visible hue shifts that the
 * hard channel-clamp produces near the sRGB gamut boundary.
 *
 * ~30x slower than the core packer — belongs at LUT build time or authoring
 * time, not in per-frame interpolation. Zero allocations.
 *
 * @param {Float32Array} buf
 * @param {number} offset
 * @param {number} [alpha=1] alpha in [0, 1]; packed into the high byte
 * @returns {number} RGBA-LE Uint32
 */
export function packOklchBufferToUint32MINDE(buf, offset, alpha) {
    gamutMapToSrgbBuffer(buf, offset, _clipLch, 0);
    const L = _clipLch[0];
    const C = _clipLch[1];
    const H = _clipLch[2];
    _oklchToLinearRgb(L, C, H, _rgb);
    // Guard-clamp: post-MINDE the values should be in [0, 1] modulo epsilon,
    // but the raw matrix output can still be a hair outside due to rounding.
    let r = _srgbGammaEncode(_rgb[0]);
    let g = _srgbGammaEncode(_rgb[1]);
    let b = _srgbGammaEncode(_rgb[2]);
    const R = (r * 255 + 0.5) | 0;
    const G = (g * 255 + 0.5) | 0;
    const B = (b * 255 + 0.5) | 0;
    const a = alpha == null ? 1 : (alpha < 0 ? 0 : alpha > 1 ? 1 : alpha);
    const A = (a * 255 + 0.5) | 0;
    // RGBA-LE: byte order R, G, B, A. `>>> 0` normalizes to unsigned uint32
    // so the value is comparable and matches v1.0 packer conventions.
    return (((A & 0xFF) << 24) | ((B & 0xFF) << 16) | ((G & 0xFF) << 8) | (R & 0xFF)) >>> 0;
}
