/**
 * @zakkster/lite-color-engine/remap
 *
 * SoA remap kernels: nearest-palette-index search in OKLab, plus a one-shot
 * pixel-remap function for image recoloring. The engine layer that
 * `lite-hueforge v1.3 remapImageToPalette` sits on top of.
 *
 * Search happens in OKLab (Euclidean distance). Palette is authored in OKLCH
 * and converted to OKLab once at call entry.
 */

/**
 * Batch RGBA8 → OKLab. Reads 4 bytes per pixel, writes 3 floats per pixel.
 * Alpha is discarded; carry it separately if needed.
 */
export function sRgba8ToOklabBuffer(
    inU8: Uint8Array | Uint8ClampedArray,
    outLab: Float32Array,
    pixelCount: number
): void;

/** Batch OKLCH → OKLab. Both buffers stride 3. */
export function oklchToOklabBuffer(
    inLch: Float32Array,
    outLab: Float32Array,
    pixelCount: number
): void;

/** Batch OKLab → OKLCH. Hue canonicalized to `[0, 360)`. Both buffers stride 3. */
export function oklabToOklchBuffer(
    inLab: Float32Array,
    outLch: Float32Array,
    pixelCount: number
): void;

export interface NearestPaletteOptions {
    /**
     * If true, distance uses (a, b) only — matches by chroma coords and
     * ignores lightness. Enables the shading-preserve remap trick.
     * Default: false.
     */
    preserveLightness?: boolean;
}

/**
 * For each pixel in `pixelsLab`, write the index of the nearest palette
 * color in `paletteLab` (squared Euclidean distance in OKLab) into
 * `indicesOut`. Tie-break: lowest index wins. Deterministic.
 */
export function nearestPaletteIndexBuffer(
    pixelsLab: Float32Array,
    paletteLab: Float32Array,
    indicesOut: Uint32Array | Uint16Array | Uint8Array,
    pixelCount: number,
    paletteCount: number,
    opts?: NearestPaletteOptions
): void;

export interface RemapPixelsOptions {
    /**
     * If true, search by (a, b) only and synthesize output per pixel using
     * the pixel's original L and the palette color's (a, b). Preserves
     * shading structure under recolor — the AI-motif recolor look.
     * ~40% slower than the fast path. Default: false.
     */
    preserveLightness?: boolean;
}

/**
 * One-shot end-to-end: read RGBA8 pixels, find nearest palette color per
 * pixel by ΔE-OK in OKLab, write RGBA-LE Uint32 result. Handles palette
 * OKLCH→OKLab conversion internally. Alpha byte passes through unchanged.
 *
 * Fast path (`preserveLightness=false`): pre-packs palette to Uint32 once,
 * per-pixel is convert-search-gather.
 *
 * Preserve path (`preserveLightness=true`): synthesizes each output pixel
 * from `(pixel.L, palette.a, palette.b)` — shading is retained.
 */
export function remapPixelsToPalette(
    inU8: Uint8Array | Uint8ClampedArray,
    paletteLch: Float32Array,
    outU32: Uint32Array,
    pixelCount: number,
    paletteCount: number,
    opts?: RemapPixelsOptions
): void;
