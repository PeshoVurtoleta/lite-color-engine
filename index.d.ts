/**
 * @zakkster/lite-color-engine
 *
 * Zero-GC, data-oriented OKLCH color engine for WebGL/Canvas pipelines.
 *
 * Buffer layout: every color is 3 contiguous Float32 entries `[L, C, H]`.
 *  - L (Lightness): [0, 1]
 *  - C (Chroma):    [0, ~0.4] in practice, unbounded mathematically
 *  - H (Hue):       [0, 360) degrees
 *
 * Pack output is a 32-bit unsigned integer in **little-endian RGBA** byte
 * order — drop straight into `new Uint32Array(imageData.data.buffer)`.
 */

// ============================================================================
// Authoring (CSS Parsing → OKLCH Buffer)
// ============================================================================

/**
 * Parses CSS hex (`#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA`) into the OKLCH
 * triplet at `outBuf[offset..offset+2]`.
 * @returns Parsed alpha in `[0, 1]`; defaults to `1.0` when omitted.
 * @throws If the string is not a valid hex literal.
 */
export function parseHexToBuffer(str: string, outBuf: Float32Array, offset: number): number;

/**
 * Parses a CSS `oklch(...)` string directly into the buffer (no color-space
 * conversion). Hue accepts `deg` (default), `rad`, and `turn` units.
 * @returns Parsed alpha in `[0, 1]`; defaults to `1.0` when omitted.
 * @throws If the string is not a valid `oklch(...)` literal.
 */
export function parseOklchToBuffer(str: string, outBuf: Float32Array, offset: number): number;

/**
 * Parses a CSS `oklab(...)` string and converts (a, b) → polar (C, H) before
 * writing the OKLCH triplet.
 * @returns Parsed alpha in `[0, 1]`; defaults to `1.0` when omitted.
 * @throws If the string is not a valid `oklab(...)` literal.
 */
export function parseOklabToBuffer(str: string, outBuf: Float32Array, offset: number): number;

/**
 * Parses a CSS `rgb(...)` / `rgba(...)` string and converts to OKLCH via the
 * proper sRGB linearization. Accepts comma-separated and slash-alpha forms,
 * `0-255` or `%` channels.
 * @returns Parsed alpha in `[0, 1]`; defaults to `1.0` when omitted.
 * @throws If the string is not a valid `rgb(...)` / `rgba(...)` literal.
 */
export function parseRgbToBuffer(str: string, outBuf: Float32Array, offset: number): number;

/**
 * Parses a CSS `hsl(...)` / `hsla(...)` string and converts to OKLCH via sRGB.
 * @returns Parsed alpha in `[0, 1]`; defaults to `1.0` when omitted.
 * @throws If the string is not a valid `hsl(...)` / `hsla(...)` literal.
 */
export function parseHslToBuffer(str: string, outBuf: Float32Array, offset: number): number;

/**
 * Universal CSS color parser. Dispatches by string prefix to the appropriate
 * format-specific parser.
 *
 * Supports: 148 named colors, `#RGB[A]`, `#RRGGBB[AA]`, `rgb()`, `rgba()`,
 * `hsl()`, `hsla()`, `oklch()`, `oklab()`.
 *
 * Intended for the **authoring/init phase** of a render pipeline. After
 * compilation, work with the resulting `Float32Array` buffers directly via
 * {@link lerpOklchBuffer} and {@link packOklchBufferToUint32}.
 *
 * @returns Parsed alpha in `[0, 1]`.
 * @throws If the string is not a recognized format.
 */
export function parseCSSColor(str: string, outBuf: Float32Array, offset: number): number;

// ============================================================================
// Convert (Raw Math)
// ============================================================================

/**
 * Converts standard sRGB (0-255 byte channels) into a flat OKLCH buffer at
 * `outBuf[outOffset..outOffset+2]`.
 *
 * Implements Björn Ottosson's OKLab (2020) algorithm with defenses against
 * NaN-propagating negative cube-root inputs and a strict lightness clamp.
 */
export function sRgbToOklchBuffer(
    r: number,
    g: number,
    b: number,
    outBuf: Float32Array,
    outOffset: number
): void;

// ============================================================================
// Runtime (Zero-GC Hot Path)
// ============================================================================

/**
 * Zero-GC, cache-friendly OKLCH buffer interpolation.
 *
 * Hue uses **shortest-path** interpolation (`lerpAngle`) so gradients never
 * wrap the long way around the wheel. Lightness is hard-clamped to `[0, 1]`
 * and chroma to `[0, +∞)`. Hue is canonicalized to `[0, 360)`.
 *
 * Source and destination buffers may alias (same buffer, different offsets).
 *
 * @param t Interpolation factor; values outside `[0, 1]` extrapolate then clamp.
 */
export function lerpOklchBuffer(
    bufA: Float32Array,
    offsetA: number,
    bufB: Float32Array,
    offsetB: number,
    t: number,
    outBuf: Float32Array,
    outOffset: number
): void;

/**
 * Encodes an OKLCH triplet to a 32-bit unsigned integer in **little-endian
 * RGBA** byte order — the format consumed directly by `Canvas ImageData` via
 * a `Uint32Array` view.
 *
 * Uses the proper sRGB transfer function (`pow(c, 1/2.4)` branch).
 * Round-tripping `sRGB → OKLCH → here` recovers the original byte exactly
 * (within rounding).
 *
 * For a faster `Math.sqrt`-approximated sibling (~2x throughput, ~10/255
 * mid-tone error), see {@link packOklchBufferToUint32Fast}.
 *
 * @param alpha Alpha in `[0, 1]`. Values outside the range are clamped. Default `1.0`.
 * @returns 32-bit unsigned integer (high bit always positive thanks to `>>> 0`).
 */
export function packOklchBufferToUint32(
    buf: Float32Array,
    offset: number,
    alpha?: number
): number;

/**
 * Faster, less accurate variant of {@link packOklchBufferToUint32}.
 *
 * Substitutes `Math.sqrt(c)` for the proper sRGB transfer. ~2x throughput on
 * V8 in tight loops at the cost of:
 *  - mid-gray (`#808080`) round-trips to about `#767676` (~10/255 darker)
 *  - warm midtones (browns, golds) shift toward black
 *
 * Use for ephemeral pixels (particle trails, alpha-blended sprite tints)
 * where the round-trip identity isn't observable.
 *
 * @param alpha Alpha in `[0, 1]`. Default `1.0`.
 * @returns 32-bit unsigned integer in little-endian RGBA byte order.
 */
export function packOklchBufferToUint32Fast(
    buf: Float32Array,
    offset: number,
    alpha?: number
): number;

/**
 * Zero-GC sampler for a baked LUT. Inline `t`-clamp + bitwise-truncated index.
 *
 * @param lut LUT produced by {@link bakeGradientToUint32}.
 * @param t Sample position; values outside `[0, 1]` are clamped.
 * @returns 32-bit packed color in little-endian RGBA byte order.
 */
export function sampleColorLUT(lut: Uint32Array, t: number): number;

// ============================================================================
// LUT (Gradient Baking)
// ============================================================================

/** Signature of a packer compatible with {@link bakeGradientToUint32}. */
export type OklchPackerFn = (buf: Float32Array, offset: number, alpha?: number) => number;

/**
 * Bakes a multi-stop OKLCH gradient into a ready-to-render `Uint32Array`.
 *
 * Output bytes are little-endian RGBA — drop into a `Uint32Array` view of
 * `Canvas ImageData`, or upload as `RGBA / UNSIGNED_BYTE` via `texImage2D`.
 *
 * Stops are evenly distributed: stop _i_ is at `i / (numStops - 1)`. The
 * optional `easeFn` warps the parametric position **before** stop selection.
 * Easing outputs outside `[0, 1]` are clamped (the LUT is fixed-resolution
 * and cannot represent overshoot).
 *
 * @param keyframesBuf Contiguous buffer of `[L0, C0, H0, L1, C1, H1, ...]`.
 * @param numStops Stop count; must be `>= 2`.
 * @param resolution LUT entry count. Defaults to `256`. Must be `>= 2`.
 * @param easeFn Optional easing applied to `t` before stop selection.
 * @param packer Optional packer override. Defaults to the accurate
 *               {@link packOklchBufferToUint32}. Pass
 *               {@link packOklchBufferToUint32Fast} for ~2x bake throughput.
 * @throws If `numStops < 2` or `resolution < 2`.
 */
export function bakeGradientToUint32(
    keyframesBuf: Float32Array,
    numStops: number,
    resolution?: number,
    easeFn?: (t: number) => number,
    packer?: OklchPackerFn
): Uint32Array;

// ============================================================================
// Difference (ΔE-OK)
// ============================================================================

/**
 * ΔE-OK color difference: Euclidean distance in OKLab between two buffered
 * OKLCH colors. Zero-allocation.
 *
 * Typical scale: `0.02` indistinguishable, `0.05` subtle, `0.15+` unambiguous.
 *
 * Use for palette dedupe, nearest-color lookup, contrast checks, and the
 * CVD-audit workflow in `lite-hueforge/colorways`.
 */
export function deltaEOK(
    bufA: Float32Array,
    offsetA: number,
    bufB: Float32Array,
    offsetB: number
): number;
