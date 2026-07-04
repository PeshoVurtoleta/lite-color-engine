/**
 * @zakkster/lite-color-engine/gamut
 *
 * CSS Color 4 MINDE chroma-reduction gamut mapping, plus an accurate packer.
 * Sub-export so the bisection loop does not bloat the core bundle.
 */

/**
 * CSS Color 4 MINDE chroma reduction. Reduces chroma at fixed L and H until
 * the color is inside the sRGB gamut, using bisection with a JND threshold.
 * Zero allocations on the hot path. Source and destination may alias.
 *
 * Writes `[L, C', H]` at `outBuf[outOffset..outOffset+2]`.
 */
export function gamutMapToSrgbBuffer(
    inBuf: Float32Array,
    inOffset: number,
    outBuf: Float32Array,
    outOffset: number
): void;

/**
 * Accurate sibling of `packOklchBufferToUint32`. Runs MINDE gamut mapping
 * before packing, eliminating the hue-shift artifacts of the hard channel
 * clamp near the sRGB gamut boundary.
 *
 * ~30x slower than the core packer — use at LUT build time or authoring
 * time, not per-frame. Returns an unsigned RGBA-LE Uint32.
 *
 * Signature-compatible with `bakeGradientToUint32`'s `packer` argument, so
 * you can bake gamut-accurate LUTs by passing this as the packer.
 */
export function packOklchBufferToUint32MINDE(
    buf: Float32Array,
    offset: number,
    alpha?: number
): number;
