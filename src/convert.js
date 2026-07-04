const RAD_TO_DEG = 180 / Math.PI;

/**
 * IEC 61966-2-1 sRGB linearization.
 * @param {number} c - Normalized non-linear sRGB channel in [0, 1]
 * @returns {number} Linear-light value in [0, 1]
 * @internal
 */
const linearize = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/**
 * Converts standard sRGB (0-255 byte channels) into a flat OKLCH buffer.
 *
 * Defends against negative floating-point cube roots (numerical noise from the
 * matrix multiply) and hard-clamps output lightness to [0, 1]. Hue is
 * canonicalized to [0, 360).
 *
 * Algorithm: Björn Ottosson's OKLab (2020) — sRGB -> linear sRGB -> LMS ->
 * non-linear LMS (cube root) -> OKLab -> polar OKLCH.
 *
 * @param {number} r - Red channel [0, 255]
 * @param {number} g - Green channel [0, 255]
 * @param {number} b - Blue channel [0, 255]
 * @param {Float32Array} outBuf - Destination buffer
 * @param {number} outOffset - Start index for the L, C, H triplet
 * @returns {void}
 */
export const sRgbToOklchBuffer = (r, g, b, outBuf, outOffset) => {
    // 1. Normalize and linearize.
    const r_lin = linearize(r / 255);
    const g_lin = linearize(g / 255);
    const b_lin = linearize(b / 255);

    // 2. Linear sRGB -> linear LMS.
    const lms_l = 0.4122214708 * r_lin + 0.5363325363 * g_lin + 0.0514459929 * b_lin;
    const lms_m = 0.2119034982 * r_lin + 0.6806995451 * g_lin + 0.1073969566 * b_lin;
    const lms_s = 0.0883024619 * r_lin + 0.2817188376 * g_lin + 0.6299787005 * b_lin;

    // 3. Non-linear LMS (defended against negative-NaN propagation from matrix noise).
    const l_ = Math.cbrt(lms_l < 0 ? 0 : lms_l);
    const m_ = Math.cbrt(lms_m < 0 ? 0 : lms_m);
    const s_ = Math.cbrt(lms_s < 0 ? 0 : lms_s);

    // 4. Non-linear LMS -> OKLab.
    const lab_l = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
    const lab_a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
    const lab_b = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;

    // 5. OKLab -> OKLCH (polar).
    const chroma = Math.sqrt(lab_a * lab_a + lab_b * lab_b);
    let hue = Math.atan2(lab_b, lab_a) * RAD_TO_DEG;
    if (hue < 0) hue += 360;

    // 6. Write to buffer with a strict lightness clamp.
    outBuf[outOffset] = lab_l < 0 ? 0 : (lab_l > 1 ? 1 : lab_l);
    outBuf[outOffset + 1] = chroma;
    outBuf[outOffset + 2] = hue;
};
