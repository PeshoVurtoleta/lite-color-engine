import { describe, it, expect } from 'vitest';

import {
    lerpOklchBuffer,
    lerpOklchBufferN,
    packOklchBufferToUint32,
    packOklchBufferToUint32IntoN
} from '../src/runtime.js';

const rnd = (a, b) => a + Math.random() * (b - a);

describe('lerpOklchBufferN', () => {
    it('is bit-for-bit identical to N scalar lerpOklchBuffer calls', () => {
        const N = 2000;
        const a = new Float32Array(N * 3);
        const b = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            a[i * 3] = rnd(0, 1); a[i * 3 + 1] = rnd(0, 0.4); a[i * 3 + 2] = rnd(0, 360);
            b[i * 3] = rnd(0, 1); b[i * 3 + 1] = rnd(0, 0.4); b[i * 3 + 2] = rnd(0, 360);
        }
        const t = 0.42;
        const outN = new Float32Array(N * 3);
        const outS = new Float32Array(N * 3);
        lerpOklchBufferN(a, 0, b, 0, t, outN, 0, N);
        for (let i = 0; i < N; i++) lerpOklchBuffer(a, i * 3, b, i * 3, t, outS, i * 3);
        for (let k = 0; k < N * 3; k++) expect(outN[k]).toBe(outS[k]);
    });

    it('honors offsets and treats n <= 0 as a no-op', () => {
        const buf = new Float32Array([0, 0, 0, 0.6, 0.2, 120, 0.4, 0.1, 300]);
        const out = new Float32Array(9).fill(7);
        lerpOklchBufferN(buf, 3, buf, 6, 0.5, out, 3, 2);
        const ref = new Float32Array(3);
        lerpOklchBuffer(buf, 3, buf, 6, 0.5, ref, 0);
        expect(out[3]).toBeCloseTo(ref[0], 6);
        expect(out[0]).toBe(7); // untouched

        const guard = new Float32Array(3).fill(9);
        lerpOklchBufferN(buf, 0, buf, 0, 0.5, guard, 0, 0);
        expect(guard[0]).toBe(9);
    });

    it('supports in-place interpolation without corruption', () => {
        const ip = new Float32Array([0.2, 0.1, 10, 0.8, 0.3, 350]);
        lerpOklchBufferN(ip, 0, ip, 0, 0.5, ip, 0, 2);
        expect(ip.every(Number.isFinite)).toBe(true);
    });
});

describe('packOklchBufferToUint32IntoN', () => {
    it('accurate mode is bit-for-bit identical to N scalar packs', () => {
        const N = 3000;
        const src = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            src[i * 3] = rnd(0, 1); src[i * 3 + 1] = rnd(0, 0.37); src[i * 3 + 2] = rnd(0, 360);
        }
        const dst = new Uint32Array(N);
        packOklchBufferToUint32IntoN(src, 0, dst, 0, N, 1.0, false);
        for (let i = 0; i < N; i++) {
            expect(dst[i] >>> 0).toBe(packOklchBufferToUint32(src, i * 3, 1.0) >>> 0);
        }
    });

    it('matches scalar alpha handling', () => {
        const src = new Float32Array([0.7, 0.15, 140]);
        const dst = new Uint32Array(1);
        for (const alpha of [0, 0.25, 0.5, 0.999, 1]) {
            packOklchBufferToUint32IntoN(src, 0, dst, 0, 1, alpha, false);
            expect(dst[0] >>> 0).toBe(packOklchBufferToUint32(src, 0, alpha) >>> 0);
        }
    });

    it('LUT mode stays within 1 LSB per channel of accurate mode', () => {
        const N = 8000;
        const src = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            src[i * 3] = rnd(0, 1); src[i * 3 + 1] = rnd(0, 0.4); src[i * 3 + 2] = rnd(0, 360);
        }
        const acc = new Uint32Array(N);
        const lut = new Uint32Array(N);
        packOklchBufferToUint32IntoN(src, 0, acc, 0, N, 1.0, false);
        packOklchBufferToUint32IntoN(src, 0, lut, 0, N, 1.0, true);
        let maxByteErr = 0;
        for (let i = 0; i < N; i++) {
            const A = acc[i] >>> 0, L = lut[i] >>> 0;
            for (let s = 0; s < 24; s += 8) {
                maxByteErr = Math.max(maxByteErr, Math.abs(((A >>> s) & 255) - ((L >>> s) & 255)));
            }
        }
        expect(maxByteErr).toBeLessThanOrEqual(1);
    });

    it('honors offSrc / offDst and treats n <= 0 as a no-op', () => {
        const src = new Float32Array([0, 0, 0, 0.6, 0.2, 120, 0.4, 0.1, 300]);
        const dst = new Uint32Array(3).fill(0xDEADBEEF);
        packOklchBufferToUint32IntoN(src, 3, dst, 1, 2, 1.0, false);
        expect(dst[1] >>> 0).toBe(packOklchBufferToUint32(src, 3) >>> 0);
        expect(dst[2] >>> 0).toBe(packOklchBufferToUint32(src, 6) >>> 0);
        expect(dst[0] >>> 0).toBe(0xDEADBEEF);

        const guard = new Uint32Array(1).fill(0xABCD);
        packOklchBufferToUint32IntoN(src, 0, guard, 0, 0, 1.0, false);
        expect(guard[0] >>> 0).toBe(0xABCD);
    });
});
