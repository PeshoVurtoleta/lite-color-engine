const _RAD = Math.PI / 180;

/**
 * ΔE-OK color difference: Euclidean distance in OKLab between two buffered
 * OKLCH colors. Zero-alloc, primitive math only.
 *
 * Typical scale: 0.00–0.02 indistinguishable, 0.02–0.05 subtle,
 * 0.05–0.15 clearly different, 0.15+ unambiguously different.
 *
 * Use for: palette dedupe, contrast checks, "is this close enough"
 * assertions, nearest-color lookup, and the CVD-audit workflow in
 * lite-hueforge/colorways.
 *
 * @param {Float32Array} bufA
 * @param {number} offsetA
 * @param {Float32Array} bufB
 * @param {number} offsetB
 * @returns {number}
 */
export const deltaEOK = (bufA, offsetA, bufB, offsetB) => {
    const La = bufA[offsetA];
    const Ca = bufA[offsetA + 1];
    const Ha = bufA[offsetA + 2];
    const Lb = bufB[offsetB];
    const Cb = bufB[offsetB + 1];
    const Hb = bufB[offsetB + 2];
    const hARad = Ha * _RAD;
    const hBRad = Hb * _RAD;
    const aA = Ca * Math.cos(hARad);
    const bA = Ca * Math.sin(hARad);
    const aB = Cb * Math.cos(hBRad);
    const bB = Cb * Math.sin(hBRad);
    const dL = La - Lb;
    const dA = aA - aB;
    const dB = bA - bB;
    return Math.sqrt(dL * dL + dA * dA + dB * dB);
};
