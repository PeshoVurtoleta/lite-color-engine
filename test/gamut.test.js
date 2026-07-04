import { describe, it, expect } from 'vitest';

import {
    gamutMapToSrgbBuffer,
    packOklchBufferToUint32MINDE
} from '../src/Gamut.js';

import { packOklchBufferToUint32 } from '../src/runtime.js';
import { bakeGradientToUint32 } from '../src/lut.js';
import { parseCSSColor } from '../src/authoring.js';


// ─────────────────────────────────────────────────────────────────────────────
// Local helpers — test-only, not shipped.
// ─────────────────────────────────────────────────────────────────────────────

const oklchToLinRgb = (L, C, H) => {
    const hRad = H * Math.PI / 180;
    const a = C * Math.cos(hRad);
    const b = C * Math.sin(hRad);
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ * l_ * l_;
    const m = m_ * m_ * m_;
    const s = s_ * s_ * s_;
    return [
         4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    ];
};

const inSrgb = (rgb, eps = 0.001) =>
    rgb[0] >= -eps && rgb[0] <= 1 + eps &&
    rgb[1] >= -eps && rgb[1] <= 1 + eps &&
    rgb[2] >= -eps && rgb[2] <= 1 + eps;


// ─────────────────────────────────────────────────────────────────────────────
// gamutMapToSrgbBuffer — invariants
// ─────────────────────────────────────────────────────────────────────────────

describe('gamutMapToSrgbBuffer', () => {
    it('passes an in-gamut color through unchanged', () => {
        const IN = new Float32Array([0.5, 0.05, 240]); // low-chroma blue, safely in sRGB
        const OUT = new Float32Array(3);
        gamutMapToSrgbBuffer(IN, 0, OUT, 0);
        expect(OUT[0]).toBe(IN[0]);
        expect(OUT[1]).toBe(IN[1]);
        expect(OUT[2]).toBe(IN[2]);
    });

    it('reduces chroma on out-of-gamut input, preserving L and H within tolerance', () => {
        // C=0.35 at L=0.7 H=30 is well outside sRGB.
        const IN = new Float32Array([0.7, 0.35, 30]);
        const OUT = new Float32Array(3);
        gamutMapToSrgbBuffer(IN, 0, OUT, 0);
        // MINDE can return either the clip-in-Lab result (may nudge L, H slightly)
        // or the bisection convergence (exact L, H). Accept both, but require
        // chroma has decreased and result is in-gamut.
        expect(OUT[1]).toBeLessThan(IN[1]);
        expect(OUT[1]).toBeGreaterThanOrEqual(0);
        expect(Math.abs(OUT[0] - IN[0])).toBeLessThan(0.05);
        const dH = Math.min(Math.abs(OUT[2] - IN[2]), 360 - Math.abs(OUT[2] - IN[2]));
        expect(dH).toBeLessThan(15);
        expect(inSrgb(oklchToLinRgb(OUT[0], OUT[1], OUT[2]), 0.005)).toBe(true);
    });

    it('collapses L >= 1 to white (C=0, H preserved)', () => {
        const IN = new Float32Array([1.0, 0.20, 100]);
        const OUT = new Float32Array(3);
        gamutMapToSrgbBuffer(IN, 0, OUT, 0);
        expect(OUT[0]).toBe(1);
        expect(OUT[1]).toBe(0);
        expect(OUT[2]).toBe(100);
    });

    it('collapses L <= 0 to black (C=0, H preserved)', () => {
        const IN = new Float32Array([0.0, 0.20, 100]);
        const OUT = new Float32Array(3);
        gamutMapToSrgbBuffer(IN, 0, OUT, 0);
        expect(OUT[0]).toBe(0);
        expect(OUT[1]).toBe(0);
        expect(OUT[2]).toBe(100);
    });

    it('passes achromatic C=0 through unchanged', () => {
        const IN = new Float32Array([0.5, 0, 200]);
        const OUT = new Float32Array(3);
        gamutMapToSrgbBuffer(IN, 0, OUT, 0);
        expect(OUT[0]).toBe(0.5);
        expect(OUT[1]).toBe(0);
        expect(OUT[2]).toBe(200);
    });

    it('is safe when source and destination alias (in-place)', () => {
        const BUF = new Float32Array([0.7, 0.35, 30]);
        gamutMapToSrgbBuffer(BUF, 0, BUF, 0);
        expect(BUF[1]).toBeLessThan(0.35);
        expect(inSrgb(oklchToLinRgb(BUF[0], BUF[1], BUF[2]), 0.005)).toBe(true);
    });

    it('writes at arbitrary offsets without disturbing neighbours', () => {
        const IN = new Float32Array([0, 0, 0, 0.7, 0.35, 30, 0, 0, 0]);
        const OUT = new Float32Array(9);
        OUT[0] = 42; OUT[1] = 42; OUT[2] = 42;
        OUT[6] = 99; OUT[7] = 99; OUT[8] = 99;
        gamutMapToSrgbBuffer(IN, 3, OUT, 3);
        expect(OUT[0]).toBe(42);
        expect(OUT[6]).toBe(99);
        expect(OUT[4]).toBeLessThan(0.35);
        expect(OUT[4]).toBeGreaterThanOrEqual(0);
    });

    it('is deterministic (repeated calls give identical bits)', () => {
        const IN = new Float32Array([0.7, 0.35, 30]);
        const A = new Float32Array(3);
        const B = new Float32Array(3);
        gamutMapToSrgbBuffer(IN, 0, A, 0);
        gamutMapToSrgbBuffer(IN, 0, B, 0);
        expect(A[0]).toBe(B[0]);
        expect(A[1]).toBe(B[1]);
        expect(A[2]).toBe(B[2]);
    });

    it('keeps a hue sweep in-gamut at a chroma frequently outside sRGB', () => {
        // Sweep L=0.5, C=0.30 across all hues. Every mapped output must be in sRGB.
        const IN = new Float32Array(3);
        const OUT = new Float32Array(3);
        for (let h = 0; h < 360; h += 10) {
            IN[0] = 0.5;
            IN[1] = 0.30;
            IN[2] = h;
            gamutMapToSrgbBuffer(IN, 0, OUT, 0);
            expect(inSrgb(oklchToLinRgb(OUT[0], OUT[1], OUT[2]), 0.005))
                .toBe(true);
            expect(OUT[1]).toBeLessThanOrEqual(IN[1] + 1e-9);
        }
    });
});


// ─────────────────────────────────────────────────────────────────────────────
// packOklchBufferToUint32MINDE
// ─────────────────────────────────────────────────────────────────────────────

describe('packOklchBufferToUint32MINDE', () => {
    it('returns an unsigned Uint32 with alpha in the high byte', () => {
        const IN = new Float32Array([0.5, 0.10, 200]);
        const u = packOklchBufferToUint32MINDE(IN, 0, 1.0);
        expect(typeof u).toBe('number');
        expect(u >>> 0).toBe(u);
        expect((u >>> 24) & 0xFF).toBe(255);
    });

    it('defaults alpha to 1 when omitted', () => {
        const IN = new Float32Array([0.5, 0.10, 200]);
        const uOmit = packOklchBufferToUint32MINDE(IN, 0);
        const uExplicit = packOklchBufferToUint32MINDE(IN, 0, 1);
        expect(uOmit).toBe(uExplicit);
        expect((uOmit >>> 24) & 0xFF).toBe(255);
    });

    it('packs alpha=0 to alpha byte 0', () => {
        const IN = new Float32Array([0.5, 0.10, 200]);
        const u = packOklchBufferToUint32MINDE(IN, 0, 0);
        expect((u >>> 24) & 0xFF).toBe(0);
    });

    it('clamps alpha outside [0, 1]', () => {
        const IN = new Float32Array([0.5, 0.10, 200]);
        const uLo = packOklchBufferToUint32MINDE(IN, 0, -0.5);
        const uHi = packOklchBufferToUint32MINDE(IN, 0, 1.5);
        expect((uLo >>> 24) & 0xFF).toBe(0);
        expect((uHi >>> 24) & 0xFF).toBe(255);
    });

    it('encodes pure black to RGB=(0,0,0)', () => {
        const IN = new Float32Array([0, 0, 0]);
        const u = packOklchBufferToUint32MINDE(IN, 0, 1);
        expect(u & 0xFF).toBe(0);
        expect((u >>> 8) & 0xFF).toBe(0);
        expect((u >>> 16) & 0xFF).toBe(0);
    });

    it('encodes pure white to RGB=(255,255,255)', () => {
        const IN = new Float32Array([1, 0, 0]);
        const u = packOklchBufferToUint32MINDE(IN, 0, 1);
        expect(u & 0xFF).toBe(255);
        expect((u >>> 8) & 0xFF).toBe(255);
        expect((u >>> 16) & 0xFF).toBe(255);
    });

    it('keeps the dominant channel consistent between in-gamut and out-of-gamut input at the same hue', () => {
        // Same L, H, but different chromas. The MINDE version should keep the
        // dominant channel stable across the gamut boundary.
        const A = new Float32Array([0.6, 0.10, 30]);   // in-gamut orange
        const B = new Float32Array([0.6, 0.35, 30]);   // out-of-gamut orange
        const uA = packOklchBufferToUint32MINDE(A, 0, 1);
        const uB = packOklchBufferToUint32MINDE(B, 0, 1);
        const rA = uA & 0xFF, gA = (uA >>> 8) & 0xFF, bA = (uA >>> 16) & 0xFF;
        const rB = uB & 0xFF, gB = (uB >>> 8) & 0xFF, bB = (uB >>> 16) & 0xFF;
        expect(rA >= gA && rA >= bA).toBe(true);
        expect(rB >= gB && rB >= bB).toBe(true);
    });

    it('matches the core packer bit-for-bit on in-gamut input', () => {
        // MINDE is meant to be a drop-in that only diverges outside the gamut.
        // For a clearly in-gamut color, the two packers must agree exactly.
        const IN = new Float32Array(3);
        parseCSSColor('#4a90e2', IN, 0);
        const uCore = packOklchBufferToUint32(IN, 0, 1);
        const uMinde = packOklchBufferToUint32MINDE(IN, 0, 1);
        expect(uMinde).toBe(uCore);
    });

    it('is drop-in usable as the packer argument to bakeGradientToUint32', () => {
        // Bake the same 2-stop gradient with the core and MINDE packers.
        // For an entirely in-gamut gradient, the two LUTs should be bit-identical.
        const stops = new Float32Array(6);
        parseCSSColor('#4a90e2', stops, 0);
        parseCSSColor('#e2a04a', stops, 3);
        const lutCore = bakeGradientToUint32(stops, 2, 64);
        const lutMinde = bakeGradientToUint32(stops, 2, 64, undefined, packOklchBufferToUint32MINDE);
        expect(lutMinde.length).toBe(lutCore.length);
        for (let i = 0; i < lutCore.length; i++) {
            expect(lutMinde[i]).toBe(lutCore[i]);
        }
    });

    it('produces stable output over many calls (hot-path smoothness)', () => {
        const IN = new Float32Array([0.5, 0.20, 100]);
        const first = packOklchBufferToUint32MINDE(IN, 0, 1);
        for (let i = 0; i < 5000; i++) {
            expect(packOklchBufferToUint32MINDE(IN, 0, 1)).toBe(first);
        }
    });
});
