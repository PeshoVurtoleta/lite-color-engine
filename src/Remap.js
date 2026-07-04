// -----------------------------------------------------------------------------
// @zakkster/lite-color-engine/remap
//
// SoA remap kernels: nearest-palette-index search in OKLab, and a one-shot
// pixel-remap function for image recoloring. The engine layer that
// `lite-hueforge v1.3 remapImageToPalette` sits on top of.
//
// Design opinions:
//   1. Search happens in OKLab, not OKLCH. Distance in OKLab is Euclidean;
//      distance in OKLCH needs a cos/sin per comparison. Palette is authored
//      in OKLCH (what humans think in), converted to OKLab once at call
//      entry, searched forever.
//   2. Palette is limited to whatever fits typical use (hundreds of colors).
//      Scratch buffers grow monotonically inside the module — never shrink.
//      Zero allocations on the hot per-pixel loop.
//   3. `preserveLightness` is the shading-preservation trick: search by (a, b)
//      only, keep the original pixel's L, and synthesize the output color
//      from (pixel.L, palette.a, palette.b). This is what makes recolored
//      AI motifs still look *shaded*, not posterized.
//   4. Alpha byte from the input passes through unchanged in the output.
//
// Trust model: hot path trusts input shapes. Buffer sizes assumed correct.
// -----------------------------------------------------------------------------

const _RAD = Math.PI / 180;
const _DEG = 180 / Math.PI;

// Grow-only module-level scratch for remapPixelsToPalette.
let _paletteLab = new Float32Array(0);
let _paletteU32 = new Uint32Array(0);


// -----------------------------------------------------------------------------
// Batch converters
// -----------------------------------------------------------------------------

function _linearizeSrgbByte(b) {
    const v = b / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function _srgbGammaEncode(v) {
    if (v <= 0) return 0;
    if (v >= 1) return 1;
    return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/**
 * Batch RGBA8 → OKLab conversion. Reads 4 bytes per pixel from `inU8`
 * (Uint8ClampedArray or Uint8Array), writes 3 floats per pixel to `outLab`.
 * Alpha is discarded; carry it separately if needed.
 */
export function sRgba8ToOklabBuffer(inU8, outLab, pixelCount) {
    for (let i = 0; i < pixelCount; i++) {
        const inOff = i * 4;
        const outOff = i * 3;
        const r = _linearizeSrgbByte(inU8[inOff]);
        const g = _linearizeSrgbByte(inU8[inOff + 1]);
        const b = _linearizeSrgbByte(inU8[inOff + 2]);
        const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
        const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
        const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
        const l_ = Math.cbrt(l);
        const m_ = Math.cbrt(m);
        const s_ = Math.cbrt(s);
        outLab[outOff]     = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
        outLab[outOff + 1] = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
        outLab[outOff + 2] = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
    }
}

/**
 * Batch OKLCH → OKLab conversion. Both buffers stride 3.
 */
export function oklchToOklabBuffer(inLch, outLab, pixelCount) {
    for (let i = 0; i < pixelCount; i++) {
        const off = i * 3;
        const L = inLch[off];
        const C = inLch[off + 1];
        const H = inLch[off + 2];
        const hRad = H * _RAD;
        outLab[off]     = L;
        outLab[off + 1] = C * Math.cos(hRad);
        outLab[off + 2] = C * Math.sin(hRad);
    }
}

/**
 * Batch OKLab → OKLCH conversion. Both buffers stride 3.
 * Hue canonicalized to [0, 360).
 */
export function oklabToOklchBuffer(inLab, outLch, pixelCount) {
    for (let i = 0; i < pixelCount; i++) {
        const off = i * 3;
        const L = inLab[off];
        const a = inLab[off + 1];
        const b = inLab[off + 2];
        const C = Math.sqrt(a * a + b * b);
        let H = Math.atan2(b, a) * _DEG;
        if (H < 0) H += 360;
        outLch[off]     = L;
        outLch[off + 1] = C;
        outLch[off + 2] = H;
    }
}


// -----------------------------------------------------------------------------
// nearestPaletteIndexBuffer
// -----------------------------------------------------------------------------

/**
 * For each pixel in `pixelsLab`, write the index of the nearest palette
 * color in `paletteLab` (by squared Euclidean distance in OKLab) into
 * `indicesOut`.
 *
 * Tie-break: lowest index wins. Deterministic across runs.
 *
 * @param {Float32Array} pixelsLab   stride 3 [L, a, b]
 * @param {Float32Array} paletteLab  stride 3 [L, a, b]
 * @param {Uint32Array|Uint16Array|Uint8Array} indicesOut  length ≥ pixelCount
 * @param {number} pixelCount
 * @param {number} paletteCount
 * @param {object} [opts]
 * @param {boolean} [opts.preserveLightness=false] if true, distance uses (a, b) only
 */
export function nearestPaletteIndexBuffer(pixelsLab, paletteLab, indicesOut, pixelCount, paletteCount, opts) {
    const preserveLightness = opts != null && opts.preserveLightness === true;
    for (let i = 0; i < pixelCount; i++) {
        const pOff = i * 3;
        const pL = pixelsLab[pOff];
        const pA = pixelsLab[pOff + 1];
        const pB = pixelsLab[pOff + 2];
        let bestIdx = 0;
        let bestD = Infinity;
        for (let k = 0; k < paletteCount; k++) {
            const kOff = k * 3;
            const dA = pA - paletteLab[kOff + 1];
            const dB = pB - paletteLab[kOff + 2];
            let d = dA * dA + dB * dB;
            if (!preserveLightness) {
                const dL = pL - paletteLab[kOff];
                d += dL * dL;
            }
            if (d < bestD) {
                bestD = d;
                bestIdx = k;
            }
        }
        indicesOut[i] = bestIdx;
    }
}


// -----------------------------------------------------------------------------
// remapPixelsToPalette — one-shot end-to-end
// -----------------------------------------------------------------------------

/**
 * One-shot: read RGBA8 pixels, find nearest palette color per pixel, write
 * RGBA-LE Uint32 result. Handles palette OKLCH→OKLab conversion internally.
 * Alpha byte is passed through unchanged from input.
 *
 * Two code paths:
 *   - preserveLightness=false: pre-packs palette to U32 once, per-pixel is
 *     convert-search-gather. Fast enough for live drag at moderate image
 *     sizes (~500x500 comfortably at 60fps on modern V8).
 *   - preserveLightness=true: per-pixel synthesizes (pixel.L, palette.a,
 *     palette.b), converts back through OKLab → linear sRGB → gamma → pack.
 *     ~3x slower but produces shading-preserved output — the AI motif
 *     recolor look.
 *
 * @param {Uint8Array|Uint8ClampedArray} inU8   RGBA8 pixel buffer
 * @param {Float32Array} paletteLch             palette OKLCH, stride 3
 * @param {Uint32Array} outU32                  output Uint32 pixels, length ≥ pixelCount
 * @param {number} pixelCount
 * @param {number} paletteCount
 * @param {object} [opts]
 * @param {boolean} [opts.preserveLightness=false]
 */
export function remapPixelsToPalette(inU8, paletteLch, outU32, pixelCount, paletteCount, opts) {
    const preserveLightness = opts != null && opts.preserveLightness === true;

    // Grow scratch if needed. Monotonic — never shrinks.
    const needLab = paletteCount * 3;
    if (_paletteLab.length < needLab) {
        _paletteLab = new Float32Array(needLab);
    }
    if (_paletteU32.length < paletteCount) {
        _paletteU32 = new Uint32Array(paletteCount);
    }

    // Palette OKLCH → OKLab + pre-pack to opaque U32 (alpha comes from input pixels).
    for (let k = 0; k < paletteCount; k++) {
        const kOff = k * 3;
        const L = paletteLch[kOff];
        const C = paletteLch[kOff + 1];
        const H = paletteLch[kOff + 2];
        const hRad = H * _RAD;
        const a = C * Math.cos(hRad);
        const b = C * Math.sin(hRad);
        _paletteLab[kOff]     = L;
        _paletteLab[kOff + 1] = a;
        _paletteLab[kOff + 2] = b;

        // Pack once (opaque; alpha comes from input pixels).
        const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
        const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
        const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
        const l3 = l_ * l_ * l_;
        const m3 = m_ * m_ * m_;
        const s3 = s_ * s_ * s_;
        const rL =  4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
        const gL = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
        const bL = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3;
        const gR = _srgbGammaEncode(rL);
        const gG = _srgbGammaEncode(gL);
        const gB = _srgbGammaEncode(bL);
        const R = (gR * 255 + 0.5) | 0;
        const G = (gG * 255 + 0.5) | 0;
        const B = (gB * 255 + 0.5) | 0;
        _paletteU32[k] = (B << 16) | (G << 8) | R;
    }

    if (!preserveLightness) {
        // Fast path: pre-packed gather.
        for (let i = 0; i < pixelCount; i++) {
            const inOff = i * 4;
            const r = _linearizeSrgbByte(inU8[inOff]);
            const g = _linearizeSrgbByte(inU8[inOff + 1]);
            const b = _linearizeSrgbByte(inU8[inOff + 2]);
            const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
            const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
            const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
            const l_ = Math.cbrt(l);
            const m_ = Math.cbrt(m);
            const s_ = Math.cbrt(s);
            const pL = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
            const pA = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
            const pB = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;

            let bestIdx = 0;
            let bestD = Infinity;
            for (let k = 0; k < paletteCount; k++) {
                const kOff = k * 3;
                const dL = pL - _paletteLab[kOff];
                const dA = pA - _paletteLab[kOff + 1];
                const dB = pB - _paletteLab[kOff + 2];
                const d = dL * dL + dA * dA + dB * dB;
                if (d < bestD) { bestD = d; bestIdx = k; }
            }
            const A = inU8[inOff + 3];
            outU32[i] = (A << 24) | _paletteU32[bestIdx];
        }
        return;
    }

    // Preserve-L path: search by (a, b), synthesize per pixel.
    for (let i = 0; i < pixelCount; i++) {
        const inOff = i * 4;
        const r = _linearizeSrgbByte(inU8[inOff]);
        const g = _linearizeSrgbByte(inU8[inOff + 1]);
        const b = _linearizeSrgbByte(inU8[inOff + 2]);
        const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
        const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
        const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
        const l_ = Math.cbrt(l);
        const m_ = Math.cbrt(m);
        const s_ = Math.cbrt(s);
        const pL = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
        const pA = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
        const pB = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;

        let bestIdx = 0;
        let bestD = Infinity;
        for (let k = 0; k < paletteCount; k++) {
            const kOff = k * 3;
            const dA = pA - _paletteLab[kOff + 1];
            const dB = pB - _paletteLab[kOff + 2];
            const d = dA * dA + dB * dB;
            if (d < bestD) { bestD = d; bestIdx = k; }
        }

        // Synthesize (pixel L, palette a, palette b) → linear sRGB → gamma → pack.
        const kOff = bestIdx * 3;
        const nA = _paletteLab[kOff + 1];
        const nB = _paletteLab[kOff + 2];
        const nl_ = pL + 0.3963377774 * nA + 0.2158037573 * nB;
        const nm_ = pL - 0.1055613458 * nA - 0.0638541728 * nB;
        const ns_ = pL - 0.0894841775 * nA - 1.2914855480 * nB;
        const nl = nl_ * nl_ * nl_;
        const nm = nm_ * nm_ * nm_;
        const ns = ns_ * ns_ * ns_;
        const nr =  4.0767416621 * nl - 3.3077115913 * nm + 0.2309699292 * ns;
        const ng = -1.2684380046 * nl + 2.6097574011 * nm - 0.3413193965 * ns;
        const nb = -0.0041960863 * nl - 0.7034186147 * nm + 1.7076147010 * ns;
        const gR = _srgbGammaEncode(nr);
        const gG = _srgbGammaEncode(ng);
        const gB = _srgbGammaEncode(nb);
        const R = (gR * 255 + 0.5) | 0;
        const G = (gG * 255 + 0.5) | 0;
        const B = (gB * 255 + 0.5) | 0;
        const A = inU8[inOff + 3];
        outU32[i] = (A << 24) | (B << 16) | (G << 8) | R;
    }
}
