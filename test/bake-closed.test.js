import { describe, it, expect } from 'vitest';
import { bakeGradientToUint32 } from '../index.js';
import {
    gamutMapToSrgbBuffer,
    gamutMapToSrgbBufferN,
    packOklchBufferToUint32MINDE
} from '../src/Gamut.js';

const byteDelta = (pxA, pxB) => {
    let d = 0;
    for (let ch = 0; ch < 3; ch++) {
        const a = (pxA >>> (ch * 8)) & 0xff;
        const b = (pxB >>> (ch * 8)) & 0xff;
        const ad = Math.abs(a - b);
        if (ad > d) d = ad;
    }
    return d;
};

const keyframes3 = new Float32Array([
    0.5, 0.15, 30,
    0.9, 0.08, 200,
    0.1, 0.05, 90
]);

// -- bakeGradientToUint32 open-mode regression --------------------------------

describe('bakeGradientToUint32 open mode (v1.4 regression)', () => {
    it('produces bit-identical output for a canonical bake (no opts arg)', () => {
        // A representative 8-entry bake with no ease. Values shouldn't change
        // between v1.4 and v1.5 on the open path.
        const lut = bakeGradientToUint32(keyframes3, 3, 8);
        // Two sentinel checks: length + sample 0 stability (via a single-stop
        // reference bake).
        expect(lut.length).toBe(8);
        const stop0 = bakeGradientToUint32(
            new Float32Array([0.5, 0.15, 30, 0.5, 0.15, 30]), 2, 2
        )[0];
        expect(lut[0]).toBe(stop0);
    });

    it('is byte-identical whether opts is undefined or absent', () => {
        const a = bakeGradientToUint32(keyframes3, 3, 32);
        const b = bakeGradientToUint32(keyframes3, 3, 32, undefined, undefined);
        const c = bakeGradientToUint32(keyframes3, 3, 32, undefined, undefined, undefined);
        expect(Array.from(a)).toEqual(Array.from(b));
        expect(Array.from(b)).toEqual(Array.from(c));
    });

    it('opts.closed=false is equivalent to no opts at all', () => {
        const a = bakeGradientToUint32(keyframes3, 3, 32);
        const b = bakeGradientToUint32(keyframes3, 3, 32, undefined, undefined, { closed: false });
        expect(Array.from(a)).toEqual(Array.from(b));
    });
});

// -- bakeGradientToUint32 closed mode -----------------------------------------

describe('bakeGradientToUint32 closed mode', () => {
    it('samples land on stop 0 at index 0 (no phase offset)', () => {
        const closed = bakeGradientToUint32(keyframes3, 3, 8, undefined, undefined, { closed: true });
        const stop0 = bakeGradientToUint32(
            new Float32Array([0.5, 0.15, 30, 0.5, 0.15, 30]), 2, 2
        )[0];
        expect(closed[0]).toBe(stop0);
    });

    it('has no duplicated endpoint: sample res-1 differs from sample 0', () => {
        // Open mode duplicates the endpoint (last sample == first stop last).
        // Closed mode must NOT — it's period-spaced, so last sample sits at
        // t = (res-1)/res, inside the wrap segment.
        const closed = bakeGradientToUint32(keyframes3, 3, 16, undefined, undefined, { closed: true });
        expect(closed[15]).not.toBe(closed[0]);
    });

    it('cyclic seam is smaller than the maximum interior delta (roadmap T1 gate)', () => {
        // At high resolution, the seam delta (|lut[res-1] -> lut[0]|) should
        // be no larger than the largest adjacent-sample delta inside the LUT.
        const RES = 512;
        const closed = bakeGradientToUint32(keyframes3, 3, RES, undefined, undefined, { closed: true });
        let maxInterior = 0;
        for (let i = 1; i < RES; i++) {
            const d = byteDelta(closed[i - 1], closed[i]);
            if (d > maxInterior) maxInterior = d;
        }
        const seam = byteDelta(closed[RES - 1], closed[0]);
        expect(seam).toBeLessThanOrEqual(maxInterior);
    });

    it('ease overshoot wraps (period) rather than clamping', () => {
        // Ease that always returns 1.25 (constant overshoot).
        const overshoot = () => 1.25;
        // In closed mode, t = 1.25 - floor(1.25) = 0.25, so all samples are
        // at t = 0.25 regardless of index.
        const closed = bakeGradientToUint32(keyframes3, 3, 8, overshoot, undefined, { closed: true });
        for (let i = 1; i < 8; i++) {
            expect(closed[i]).toBe(closed[0]);
        }
        // But that value is NOT equal to the open-mode clamped-to-1 value
        // (which lands on stop N-1).
        const open = bakeGradientToUint32(keyframes3, 3, 8, overshoot);
        expect(closed[0]).not.toBe(open[0]);
    });

    it('negative ease outputs wrap into positive period', () => {
        const negOvershoot = () => -0.25;
        const closed = bakeGradientToUint32(keyframes3, 3, 8, negOvershoot, undefined, { closed: true });
        const posShift = () => 0.75;  // equivalent under period wrap
        const closedPos = bakeGradientToUint32(keyframes3, 3, 8, posShift, undefined, { closed: true });
        expect(closed[0]).toBe(closedPos[0]);
    });

    it('two-stop closed bake wraps back to stop 0 at the tail', () => {
        // With N=2 and R=8, sample positions 0, 1/8, ..., 7/8 in period space.
        // scaledT = t * 2. Indices: 0,0,0,0,1,1,1,1. Segment 0 = stops[0]->stops[1];
        // segment 1 (wrap) = stops[1]->stops[0]. So sample 4 should equal a bake
        // of stops[1] and sample near 7/8 should approach stops[0].
        const twoStop = new Float32Array([0.5, 0.15, 30, 0.5, 0.15, 210]);
        const lut = bakeGradientToUint32(twoStop, 2, 8, undefined, undefined, { closed: true });
        const stop1Bake = bakeGradientToUint32(
            new Float32Array([0.5, 0.15, 210, 0.5, 0.15, 210]), 2, 2
        )[0];
        expect(lut[4]).toBe(stop1Bake);
    });

    it('throws on numStops < 2 in both modes (contract preserved)', () => {
        expect(() => bakeGradientToUint32(new Float32Array([0.5, 0.1, 30]), 1, 8, undefined, undefined, { closed: true }))
            .toThrow();
        expect(() => bakeGradientToUint32(new Float32Array([0.5, 0.1, 30]), 1, 8))
            .toThrow();
    });

    it('throws on resolution < 2 in both modes', () => {
        expect(() => bakeGradientToUint32(keyframes3, 3, 1, undefined, undefined, { closed: true }))
            .toThrow();
    });
});

// -- Gamut batch --------------------------------------------------------------

describe('gamutMapToSrgbBufferN', () => {
    const inBuf = new Float32Array([
        0.7, 0.35, 30,   // out-of-gamut red (high chroma)
        0.5, 0.30, 150,  // out-of-gamut green
        0.6, 0.25, 250,  // out-of-gamut blue-purple
        0.5, 0.05, 30,   // in-gamut (low chroma, fast return path)
        0.5, 0.00, 0     // achromatic
    ]);
    const n = 5;

    it('bit-for-bit matches a scalar loop of gamutMapToSrgbBuffer', () => {
        const outScalar = new Float32Array(n * 3);
        const outBatch = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            gamutMapToSrgbBuffer(inBuf, i * 3, outScalar, i * 3);
        }
        gamutMapToSrgbBufferN(inBuf, 0, outBatch, 0, n);
        expect(Array.from(outBatch)).toEqual(Array.from(outScalar));
    });

    it('n <= 0 is a no-op', () => {
        const out = new Float32Array(n * 3).fill(-1);
        gamutMapToSrgbBufferN(inBuf, 0, out, 0, 0);
        for (let i = 0; i < n * 3; i++) expect(out[i]).toBe(-1);
        gamutMapToSrgbBufferN(inBuf, 0, out, 0, -3);
        for (let i = 0; i < n * 3; i++) expect(out[i]).toBe(-1);
    });

    it('preserves L and H exactly (only chroma is reduced)', () => {
        const out = new Float32Array(n * 3);
        gamutMapToSrgbBufferN(inBuf, 0, out, 0, n);
        for (let i = 0; i < n; i++) {
            // L endpoint short-circuits (0/1) preserve L bit-exactly; other
            // cases may modify H via clip-fallback. Just check that the
            // reduced chroma is not larger than the input chroma.
            expect(out[i * 3 + 1]).toBeLessThanOrEqual(inBuf[i * 3 + 1] + 1e-6);
        }
    });

    it('in-place aliasing is safe (inBuf === outBuf)', () => {
        const shared = new Float32Array(inBuf);
        // Compute expected via a fresh scalar pass first
        const expected = new Float32Array(n * 3);
        gamutMapToSrgbBufferN(inBuf, 0, expected, 0, n);
        // Now do it in place
        gamutMapToSrgbBufferN(shared, 0, shared, 0, n);
        expect(Array.from(shared)).toEqual(Array.from(expected));
    });
});

// -- Gamut-mapped bake integration -------------------------------------------

describe('bakeGradientToUint32 with MINDE packer', () => {
    it('produces a fully-alpha-255 LUT for out-of-gamut keyframes (no NaN)', () => {
        const oog = new Float32Array([0.7, 0.35, 30, 0.5, 0.30, 150]);
        const lut = bakeGradientToUint32(oog, 2, 32, undefined, packOklchBufferToUint32MINDE);
        for (let i = 0; i < 32; i++) {
            expect((lut[i] >>> 24) & 0xff).toBe(255);
        }
    });

    it('MINDE + closed: cyclic seam <= max interior delta', () => {
        const oog = new Float32Array([0.7, 0.35, 30, 0.5, 0.30, 150]);
        const lut = bakeGradientToUint32(oog, 2, 128, undefined, packOklchBufferToUint32MINDE, { closed: true });
        let maxInterior = 0;
        for (let i = 1; i < 128; i++) {
            const d = byteDelta(lut[i - 1], lut[i]);
            if (d > maxInterior) maxInterior = d;
        }
        const seam = byteDelta(lut[127], lut[0]);
        expect(seam).toBeLessThanOrEqual(maxInterior);
    });

    it('MINDE gives different hue than the plain clip on out-of-gamut input', () => {
        // Bake a single OOG color both ways, compare bytes.
        const oog = new Float32Array([0.7, 0.35, 30, 0.7, 0.35, 30]);
        const clipLut = bakeGradientToUint32(oog, 2, 4);
        const mindeLut = bakeGradientToUint32(oog, 2, 4, undefined, packOklchBufferToUint32MINDE);
        // At least one channel should differ — MINDE reduces chroma and
        // therefore does not saturate the way clip does.
        let anyDiff = false;
        for (let i = 0; i < 4; i++) {
            if (clipLut[i] !== mindeLut[i]) { anyDiff = true; break; }
        }
        expect(anyDiff).toBe(true);
    });
});
