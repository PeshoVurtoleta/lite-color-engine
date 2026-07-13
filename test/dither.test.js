import { describe, it, expect } from 'vitest';
import {
    packOklchBufferToUint32,
    packOklchBufferToUint32Dithered,
    packOklchBufferToUint32IntoN,
    packOklchBufferToUint32IntoNDithered,
    packOklchBufferToUint32P3,
    packOklchBufferToUint32P3IntoN,
    getBlueNoise64
} from '../index.js';

// -- getBlueNoise64 -----------------------------------------------------------

describe('getBlueNoise64', () => {
    it('returns a Uint8Array of length 4096', () => {
        const tile = getBlueNoise64();
        expect(tile).toBeInstanceOf(Uint8Array);
        expect(tile.length).toBe(4096);
    });

    it('returns the same reference on repeated calls (shared, cached)', () => {
        const a = getBlueNoise64();
        const b = getBlueNoise64();
        expect(a).toBe(b);
    });

    it('has an exactly uniform histogram (each byte 0..255 appears 16 times)', () => {
        const tile = getBlueNoise64();
        const hist = new Uint32Array(256);
        for (let i = 0; i < 4096; i++) hist[tile[i]]++;
        for (let b = 0; b < 256; b++) {
            expect(hist[b]).toBe(16);
        }
    });

    it('has a stable SHA-256 fingerprint (regression guard on the inlined blob)', async () => {
        const { createHash } = await import('node:crypto');
        const tile = getBlueNoise64();
        const hex = createHash('sha256').update(tile).digest('hex');
        expect(hex).toBe('8867ddb65e16379ad42244fa24b82dcbd813c684ce14944f86a9e3e8f6b72968');
    });

    it('is torus-tileable (indexing wraps cleanly on 63-mask)', () => {
        const tile = getBlueNoise64();
        // The (& 63) index math is deterministic; a smoke test that no index
        // falls outside 0..4095 across a 128x128 sweep confirms the caller
        // pattern is valid.
        for (let y = 0; y < 128; y++) {
            for (let x = 0; x < 128; x++) {
                const idx = ((y & 63) << 6) | (x & 63);
                expect(idx).toBeGreaterThanOrEqual(0);
                expect(idx).toBeLessThan(4096);
                expect(tile[idx]).toBeGreaterThanOrEqual(0);
                expect(tile[idx]).toBeLessThanOrEqual(255);
            }
        }
    });
});

// -- packOklchBufferToUint32Dithered ------------------------------------------

describe('packOklchBufferToUint32Dithered', () => {
    const buf = new Float32Array([0.5, 0.15, 30, 0.9, 0.08, 200, 0.1, 0.05, 90]);

    it('at noise01 = 0.5 matches packOklchBufferToUint32 bit-for-bit', () => {
        for (let i = 0; i < 3; i++) {
            const plain = packOklchBufferToUint32(buf, i * 3, 1);
            const dith = packOklchBufferToUint32Dithered(buf, i * 3, 1, 0.5);
            expect(dith).toBe(plain);
        }
    });

    it('never overflows a byte at noise01 near 1', () => {
        const white = new Float32Array([1.0, 0.0, 0]);
        // Sweep noise01 through the maximum-realistic range
        for (let k = 0; k < 256; k++) {
            const noise01 = k / 256;
            const px = packOklchBufferToUint32Dithered(white, 0, 1, noise01);
            const r = px & 0xff, g = (px >>> 8) & 0xff, b = (px >>> 16) & 0xff, a = (px >>> 24) & 0xff;
            expect(r).toBeLessThanOrEqual(255);
            expect(g).toBeLessThanOrEqual(255);
            expect(b).toBeLessThanOrEqual(255);
            expect(a).toBe(255);
        }
    });

    it('applies the same noise offset to R, G, B (luminance dither, no chroma speckle)', () => {
        // A pure gray (zero chroma) input must always yield R === G === B
        const gray = new Float32Array([0.5, 0, 0]);
        for (let k = 0; k < 256; k++) {
            const noise01 = k / 256;
            const px = packOklchBufferToUint32Dithered(gray, 0, 1, noise01);
            const r = px & 0xff, g = (px >>> 8) & 0xff, b = (px >>> 16) & 0xff;
            expect(g).toBe(r);
            expect(b).toBe(r);
        }
    });

    it('stays within +/-1 of the plain packer for any noise01 in [0, 1)', () => {
        for (let i = 0; i < 3; i++) {
            const plain = packOklchBufferToUint32(buf, i * 3, 1);
            const pR = plain & 0xff, pG = (plain >>> 8) & 0xff, pB = (plain >>> 16) & 0xff;
            for (let k = 0; k < 256; k++) {
                const noise01 = k / 256;
                const dith = packOklchBufferToUint32Dithered(buf, i * 3, 1, noise01);
                const dR = dith & 0xff, dG = (dith >>> 8) & 0xff, dB = (dith >>> 16) & 0xff;
                expect(Math.abs(dR - pR)).toBeLessThanOrEqual(1);
                expect(Math.abs(dG - pG)).toBeLessThanOrEqual(1);
                expect(Math.abs(dB - pB)).toBeLessThanOrEqual(1);
            }
        }
    });
});

// -- packOklchBufferToUint32IntoNDithered -------------------------------------

describe('packOklchBufferToUint32IntoNDithered', () => {
    it('is deterministic for a given (x0, y0, rowWidth, input)', () => {
        const n = 64;
        const src = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            src[i * 3] = 0.5;
            src[i * 3 + 1] = 0.1;
            src[i * 3 + 2] = (i * 5) % 360;
        }
        const tile = getBlueNoise64();
        const a = new Uint32Array(n);
        const b = new Uint32Array(n);
        packOklchBufferToUint32IntoNDithered(src, 0, a, 0, n, 1, tile, 0, 0, 8);
        packOklchBufferToUint32IntoNDithered(src, 0, b, 0, n, 1, tile, 0, 0, 8);
        expect(Array.from(a)).toEqual(Array.from(b));
    });

    it('gray input -> R === G === B in every output pixel', () => {
        const n = 64;
        const gray = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { gray[i * 3] = 0.5; gray[i * 3 + 1] = 0; gray[i * 3 + 2] = 0; }
        const tile = getBlueNoise64();
        const dst = new Uint32Array(n);
        packOklchBufferToUint32IntoNDithered(gray, 0, dst, 0, n, 1, tile, 0, 0, 8);
        for (let i = 0; i < n; i++) {
            const px = dst[i];
            const r = px & 0xff, g = (px >>> 8) & 0xff, b = (px >>> 16) & 0xff;
            expect(g).toBe(r);
            expect(b).toBe(r);
        }
    });

    it('varies output over the tile (produces distinct bytes on a flat gray)', () => {
        // A flat gray input should map to a HISTOGRAM of nearby bytes after
        // dithering — that's the whole point. If we get exactly one byte,
        // the dither is silently doing nothing.
        const n = 4096;
        const gray = new Float32Array(n * 3);
        // Use an L that makes the encoded byte fall between integers (0.5 lands near 187/255).
        for (let i = 0; i < n; i++) { gray[i * 3] = 0.5; gray[i * 3 + 1] = 0; gray[i * 3 + 2] = 0; }
        const tile = getBlueNoise64();
        const dst = new Uint32Array(n);
        packOklchBufferToUint32IntoNDithered(gray, 0, dst, 0, n, 1, tile, 0, 0, 64);
        const uniqueR = new Set();
        for (let i = 0; i < n; i++) uniqueR.add(dst[i] & 0xff);
        // Expect at least 2 distinct byte values from the noise sweep.
        expect(uniqueR.size).toBeGreaterThanOrEqual(2);
    });

    it('per-channel deviation from undithered is <= 1 across a full row', () => {
        const n = 256;
        const src = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            src[i * 3] = 0.5 + (i / n) * 0.001;  // shallow ramp
            src[i * 3 + 1] = 0.1;
            src[i * 3 + 2] = 200;
        }
        const tile = getBlueNoise64();
        const dstD = new Uint32Array(n);
        const dstU = new Uint32Array(n);
        packOklchBufferToUint32IntoNDithered(src, 0, dstD, 0, n, 1, tile, 0, 0, n);
        packOklchBufferToUint32IntoN(src, 0, dstU, 0, n, 1, false);
        for (let i = 0; i < n; i++) {
            for (let ch = 0; ch < 3; ch++) {
                const d = (dstD[i] >>> (ch * 8)) & 0xff;
                const u = (dstU[i] >>> (ch * 8)) & 0xff;
                expect(Math.abs(d - u)).toBeLessThanOrEqual(1);
            }
        }
    });

    it('breaks up banding: shallow ramp produces shorter identical-pixel runs vs undithered', () => {
        // Worst-case banding: a very shallow L ramp of many samples. The
        // undithered output will have long runs of identical bytes; the
        // dithered output should shorten the longest run substantially.
        const n = 4096;
        const src = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            src[i * 3] = 0.5 + (i / n) * 0.005;
            src[i * 3 + 1] = 0.03;
            src[i * 3 + 2] = 200;
        }
        const tile = getBlueNoise64();
        const dstD = new Uint32Array(n);
        const dstU = new Uint32Array(n);
        packOklchBufferToUint32IntoNDithered(src, 0, dstD, 0, n, 1, tile, 0, 0, 64);
        packOklchBufferToUint32IntoN(src, 0, dstU, 0, n, 1, false);
        const maxRun = (arr) => {
            let best = 0, cur = 1, prev = arr[0] & 0xff;
            for (let i = 1; i < arr.length; i++) {
                const b = arr[i] & 0xff;
                if (b === prev) cur++;
                else { if (cur > best) best = cur; cur = 1; prev = b; }
            }
            return Math.max(best, cur);
        };
        const runU = maxRun(dstU);
        const runD = maxRun(dstD);
        // Dithered should shorten the longest run to a small fraction of the undithered one.
        expect(runD).toBeLessThan(runU);
        expect(runD).toBeLessThan(runU / 2);
    });
});

// -- packOklchBufferToUint32P3IntoN -------------------------------------------

describe('packOklchBufferToUint32P3IntoN', () => {
    const src = new Float32Array([
        0.5, 0.15, 30,
        0.9, 0.08, 200,
        0.1, 0.05, 90,
        0.7, 0.20, 340
    ]);
    const n = 4;

    it('bit-for-bit matches a scalar loop of packOklchBufferToUint32P3 (useLut=false)', () => {
        const batch = new Uint32Array(n);
        packOklchBufferToUint32P3IntoN(src, 0, batch, 0, n, 1, false);
        for (let i = 0; i < n; i++) {
            expect(batch[i]).toBe(packOklchBufferToUint32P3(src, i * 3, 1));
        }
    });

    it('useLut=true stays within 1 LSB of the exact encoder', () => {
        const exact = new Uint32Array(n);
        const lut = new Uint32Array(n);
        packOklchBufferToUint32P3IntoN(src, 0, exact, 0, n, 1, false);
        packOklchBufferToUint32P3IntoN(src, 0, lut, 0, n, 1, true);
        for (let i = 0; i < n; i++) {
            for (let ch = 0; ch < 3; ch++) {
                const e = (exact[i] >>> (ch * 8)) & 0xff;
                const l = (lut[i] >>> (ch * 8)) & 0xff;
                expect(Math.abs(e - l)).toBeLessThanOrEqual(1);
            }
            // Alpha must be exactly equal (undithered)
            const eA = (exact[i] >>> 24) & 0xff;
            const lA = (lut[i] >>> 24) & 0xff;
            expect(lA).toBe(eA);
        }
    });

    it('n <= 0 is a no-op (does not touch the destination)', () => {
        const dst = new Uint32Array(4).fill(0xdeadbeef);
        packOklchBufferToUint32P3IntoN(src, 0, dst, 0, 0, 1, false);
        expect(Array.from(dst)).toEqual([0xdeadbeef, 0xdeadbeef, 0xdeadbeef, 0xdeadbeef]);
    });
});

// -- parameter defaults -------------------------------------------------------
// The RC shipped this packer with no defaults while every sibling defaults
// alpha = 1.0. Calling it with the plain packer's arity produced 0x00000000 --
// alpha undefined -> NaN -> a8 = 0, noise01 undefined -> NaN -> rgb = 0. Silent
// transparent black, and the .d.ts made it a TS-only guarantee.
describe('packOklchBufferToUint32Dithered: parameter defaults', () => {
    const buf = new Float32Array([0.62, 0.14, 29.2]);

    it('called with the plain packer arity, IS the plain packer', () => {
        expect(packOklchBufferToUint32Dithered(buf, 0)).toBe(packOklchBufferToUint32(buf, 0));
    });

    it('never silently returns fully transparent black', () => {
        expect(packOklchBufferToUint32Dithered(buf, 0)).not.toBe(0x00000000);
        expect(packOklchBufferToUint32Dithered(buf, 0) >>> 24).toBe(255);
    });

    it('defaults noise01 to 0.5 (the no-dither identity) when alpha is given alone', () => {
        expect(packOklchBufferToUint32Dithered(buf, 0, 1.0)).toBe(packOklchBufferToUint32(buf, 0, 1.0));
        expect(packOklchBufferToUint32Dithered(buf, 0, 0.5)).toBe(packOklchBufferToUint32(buf, 0, 0.5));
    });
});
