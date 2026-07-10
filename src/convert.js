const RAD_TO_DEG = 180 / Math.PI;

/**
 * IEC 61966-2-1 sRGB / Display-P3 linearization (EOTF inverse).
 * Both color spaces use the same transfer function.
 *
 * @param {number} c - Normalized non-linear channel in [0, 1]
 * @returns {number} Linear-light value in [0, 1]
 * @internal
 */
export const linearize = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/**
 * Converts standard sRGB (0-255 byte channels) into a flat OKLCH buffer.
 *
 * Defends against negative floating-point cube roots (numerical noise from the
 * matrix multiply) and hard-clamps output lightness to [0, 1]. Hue is
 * canonicalized to [0, 360).
 *
 * Algorithm: Bjorn Ottosson's OKLab (2020) - sRGB -> linear sRGB -> LMS ->
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

    // 2. Linear sRGB -> linear LMS (combined matrix from OKLab reference).
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

// -----------------------------------------------------------------------------
// Display P3 support (Session 2)
// High-precision matrices sourced from CSS Color Module Level 4 + OKLab reference
// implementation by Bjorn Ottosson. Combined for minimal code size and speed.
// -----------------------------------------------------------------------------

/**
 * High-precision linear Display P3 (D65) -> XYZ (D65)
 */
const P3_TO_XYZ = [
    [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
    [0.2289745640697488, 0.6917385218365062,  0.079286914093745],
    [0.0000000000000000, 0.0451133816152514,  1.043944368900976]
];

/**
 * High-precision XYZ (D65) -> LMS (OKLab cone fundamentals)
 */
const XYZ_TO_LMS = [
    [ 0.8190224379967030, 0.3619062600528904, -0.1288737815209879],
    [ 0.0329836671980271, 0.9292868615863434,  0.0361446681699989],
    [ 0.0481772077560169, 0.2642395317527308,  0.6335478284694309]
];

/**
 * Converts Display P3 (0-255 byte channels) into a flat OKLCH buffer.
 *
 * Uses the same OKLab pipeline as sRGB but with Display P3 primaries.
 * This allows correct representation of colors outside the sRGB gamut
 * (higher possible chroma values).
 *
 * Defends against negative cube roots and clamps lightness to [0, 1].
 *
 * @param {number} r - Red channel in Display P3 [0, 255]
 * @param {number} g - Green channel in Display P3 [0, 255]
 * @param {number} b - Blue channel in Display P3 [0, 255]
 * @param {Float32Array} outBuf - Destination buffer
 * @param {number} outOffset - Start index for the L, C, H triplet
 * @returns {void}
 */
export const displayP3ToOklchBuffer = (r, g, b, outBuf, outOffset) => {
    // 1. Normalize and linearize (same EOTF as sRGB)
    const r_lin = linearize(r / 255);
    const g_lin = linearize(g / 255);
    const b_lin = linearize(b / 255);

    // 2. Linear Display P3 -> XYZ
    const x = P3_TO_XYZ[0][0] * r_lin + P3_TO_XYZ[0][1] * g_lin + P3_TO_XYZ[0][2] * b_lin;
    const y = P3_TO_XYZ[1][0] * r_lin + P3_TO_XYZ[1][1] * g_lin + P3_TO_XYZ[1][2] * b_lin;
    const z = P3_TO_XYZ[2][0] * r_lin + P3_TO_XYZ[2][1] * g_lin + P3_TO_XYZ[2][2] * b_lin;

    // 3. XYZ -> linear LMS (OKLab)
    const lms_l = XYZ_TO_LMS[0][0] * x + XYZ_TO_LMS[0][1] * y + XYZ_TO_LMS[0][2] * z;
    const lms_m = XYZ_TO_LMS[1][0] * x + XYZ_TO_LMS[1][1] * y + XYZ_TO_LMS[1][2] * z;
    const lms_s = XYZ_TO_LMS[2][0] * x + XYZ_TO_LMS[2][1] * y + XYZ_TO_LMS[2][2] * z;

    // 4. Non-linear LMS (cube root) - same defense as sRGB path
    const l_ = Math.cbrt(lms_l < 0 ? 0 : lms_l);
    const m_ = Math.cbrt(lms_m < 0 ? 0 : lms_m);
    const s_ = Math.cbrt(lms_s < 0 ? 0 : lms_s);

    // 5. Non-linear LMS -> OKLab (identical coefficients to sRGB path)
    const lab_l = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
    const lab_a = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
    const lab_b = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;

    // 6. OKLab -> OKLCH (polar) - identical to sRGB path
    const chroma = Math.sqrt(lab_a * lab_a + lab_b * lab_b);
    let hue = Math.atan2(lab_b, lab_a) * RAD_TO_DEG;
    if (hue < 0) hue += 360;

    // 7. Write with lightness clamp
    outBuf[outOffset] = lab_l < 0 ? 0 : (lab_l > 1 ? 1 : lab_l);
    outBuf[outOffset + 1] = chroma;
    outBuf[outOffset + 2] = hue;
};

/**
 * Converts an OKLCH triplet to linear-light Display P3 RGB.
 * Writes [r, g, b] linear values (can be outside [0,1] for out-of-gamut colors)
 * into the provided `out` Float32Array (length >= 3).
 *
 * This is the inverse of the forward path above. Used by the P3 packers and
 * available for custom P3 gamut-mapping. Output channels may fall outside
 * [0, 1] for colors beyond the P3 gamut; clamp or map before encoding.
 *
 * @param {number} L - Lightness [0, 1]
 * @param {number} C - Chroma [0, +inf)
 * @param {number} H - Hue [0, 360)
 * @param {Float32Array} out - Destination (length >= 3); receives linear [r, g, b]
 * @returns {void}
 */
export const oklchToLinearP3 = (L, C, H, out) => {
    const hRad = (H * Math.PI) / 180;
    const a = C * Math.cos(hRad);
    const b = C * Math.sin(hRad);

    // OKLab -> non-linear LMS (inverse of the OKLab matrix)
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

    // Non-linear LMS -> linear LMS (cube)
    const lms_l = l_ * l_ * l_;
    const lms_m = m_ * m_ * m_;
    const lms_s = s_ * s_ * s_;

    // Linear LMS -> XYZ (inverse of XYZ_TO_LMS)
    // Using the analytical inverse for precision
    const x =  1.2268798758459243 * lms_l - 0.5578149944602171 * lms_m + 0.2813910456659647 * lms_s;
    const y = -0.0405757452148008 * lms_l + 1.1122868032803170 * lms_m - 0.0717110580655164 * lms_s;
    const z = -0.0763729366746601 * lms_l - 0.4214933324022432 * lms_m + 1.5869240198367816 * lms_s;

    // XYZ -> linear Display P3 (inverse of P3_TO_XYZ)
    // Using the analytical inverse matrix
    out[0] =  2.4934969119414263 * x - 0.9313836179191239 * y - 0.4027107844507168 * z;
    out[1] = -0.8294889695615749 * x + 1.7626640603183463 * y + 0.0236246858419436 * z;
    out[2] =  0.0358458302437845 * x - 0.0761723892680418 * y + 0.9568845240076702 * z;
};
