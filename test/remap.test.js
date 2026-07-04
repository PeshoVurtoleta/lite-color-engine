import { describe, it, expect } from 'vitest';

import {
    sRgba8ToOklabBuffer,
    oklchToOklabBuffer,
    oklabToOklchBuffer,
    nearestPaletteIndexBuffer,
    remapPixelsToPalette
} from '../src/Remap.js';


// ─────────────────────────────────────────────────────────────────────────────
// oklchToOklabBuffer / oklabToOklchBuffer — round-trip
// ─────────────────────────────────────────────────────────────────────────────

describe('oklchToOklabBuffer / oklabToOklchBuffer', () => {
    it('at H=0, OKLCH → OKLab gives a=C, b=0', () => {
        const lch = new Float32Array([0.5, 0.15, 0]);
        const lab = new Float32Array(3);
        oklchToOklabBuffer(lch, lab, 1);
        expect(lab[0]).toBe(0.5);
        expect(Math.abs(lab[1] - 0.15)).toBeLessThan(1e-6);
        expect(Math.abs(lab[2])).toBeLessThan(1e-6);
    });

    it('at H=90, OKLCH → OKLab gives a=0, b=C', () => {
        const lch = new Float32Array([0.5, 0.15, 90]);
        const lab = new Float32Array(3);
        oklchToOklabBuffer(lch, lab, 1);
        expect(Math.abs(lab[1])).toBeLessThan(1e-6);
        expect(Math.abs(lab[2] - 0.15)).toBeLessThan(1e-6);
    });

    it('round-trips OKLCH → OKLab → OKLCH within 1e-5', () => {
        const src = new Float32Array([0.5, 0.15, 0, 0.3, 0.08, 120, 0.7, 0.22, 240]);
        const lab = new Float32Array(9);
        const back = new Float32Array(9);
        oklchToOklabBuffer(src, lab, 3);
        oklabToOklchBuffer(lab, back, 3);
        for (let i = 0; i < 9; i++) {
            // Wrap hue slot at 360-boundary.
            let diff = Math.abs(back[i] - src[i]);
            if (i % 3 === 2 && diff > 180) diff = 360 - diff;
            expect(diff).toBeLessThan(1e-5);
        }
    });

    it('canonicalizes hue to [0, 360) on OKLab → OKLCH', () => {
        // a < 0, b < 0 → atan2 lands in third quadrant → H should still be positive.
        const lab = new Float32Array([0.5, -0.10, -0.10]);
        const lch = new Float32Array(3);
        oklabToOklchBuffer(lab, lch, 1);
        expect(lch[2]).toBeGreaterThanOrEqual(0);
        expect(lch[2]).toBeLessThan(360);
    });
});


// ─────────────────────────────────────────────────────────────────────────────
// sRgba8ToOklabBuffer
// ─────────────────────────────────────────────────────────────────────────────

describe('sRgba8ToOklabBuffer', () => {
    it('encodes pure black RGBA to L=0', () => {
        const px = new Uint8ClampedArray([0, 0, 0, 255]);
        const lab = new Float32Array(3);
        sRgba8ToOklabBuffer(px, lab, 1);
        expect(Math.abs(lab[0])).toBeLessThan(1e-6);
        expect(Math.abs(lab[1])).toBeLessThan(1e-6);
        expect(Math.abs(lab[2])).toBeLessThan(1e-6);
    });

    it('encodes pure white RGBA to L=1', () => {
        const px = new Uint8ClampedArray([255, 255, 255, 255]);
        const lab = new Float32Array(3);
        sRgba8ToOklabBuffer(px, lab, 1);
        expect(Math.abs(lab[0] - 1)).toBeLessThan(1e-4);
        expect(Math.abs(lab[1])).toBeLessThan(1e-4);
        expect(Math.abs(lab[2])).toBeLessThan(1e-4);
    });

    it('batches primary colors with correct stride and signs', () => {
        const px = new Uint8ClampedArray([
            255, 0, 0, 255,
            0, 255, 0, 255,
            0, 0, 255, 255
        ]);
        const lab = new Float32Array(9);
        sRgba8ToOklabBuffer(px, lab, 3);
        // Red: positive a (positive a is red direction).
        expect(lab[1]).toBeGreaterThan(0.15);
        // Green: negative a.
        expect(lab[4]).toBeLessThan(-0.1);
        // Blue: negative b.
        expect(lab[8]).toBeLessThan(-0.15);
    });

    it('accepts a plain Uint8Array (not just Uint8ClampedArray)', () => {
        const px = new Uint8Array([0, 0, 0, 255]);
        const lab = new Float32Array(3);
        sRgba8ToOklabBuffer(px, lab, 1);
        expect(Math.abs(lab[0])).toBeLessThan(1e-6);
    });
});


// ─────────────────────────────────────────────────────────────────────────────
// nearestPaletteIndexBuffer
// ─────────────────────────────────────────────────────────────────────────────

describe('nearestPaletteIndexBuffer', () => {
    it('returns own index for exact match', () => {
        const pal = new Float32Array([
            0.20, 0.05, 0.05,
            0.50, 0.10, 0.10,
            0.80, 0.02, 0.02
        ]);
        const px = new Float32Array([0.50, 0.10, 0.10]);
        const out = new Uint32Array(1);
        nearestPaletteIndexBuffer(px, pal, out, 1, 3);
        expect(out[0]).toBe(1);
    });

    it('breaks ties by lowest palette index', () => {
        // Two palette entries equidistant from the query.
        const pal = new Float32Array([
            0.50,  0.10, 0.00,   // slot 0
            0.50, -0.10, 0.00    // slot 1 (mirror across a=0 axis)
        ]);
        const px = new Float32Array([0.50, 0.00, 0.00]);
        const out = new Uint32Array(1);
        nearestPaletteIndexBuffer(px, pal, out, 1, 2);
        expect(out[0]).toBe(0);
    });

    it('preserveLightness ignores L in distance metric', () => {
        // Palette designed so the two paths pick different slots:
        //   slot 0: wrong L, right (a, b)          → wins with preserveLightness
        //   slot 1: right L, slightly wrong (a, b) → wins in full (L, a, b) space
        const pal = new Float32Array([
            0.20, 0.10, 0.00,   // slot 0: same a,b as pixel, wildly wrong L
            0.80, 0.10, 0.02    // slot 1: matches L, tiny a,b drift
        ]);
        const px = new Float32Array([0.80, 0.10, 0.00]);
        const outPreserved = new Uint32Array(1);
        nearestPaletteIndexBuffer(px, pal, outPreserved, 1, 2, { preserveLightness: true });
        expect(outPreserved[0]).toBe(0);
        // Sanity: without preserveLightness, L matters and slot 1 wins overwhelmingly.
        const outFull = new Uint32Array(1);
        nearestPaletteIndexBuffer(px, pal, outFull, 1, 2);
        expect(outFull[0]).toBe(1);
    });

    it('explicit preserveLightness=false matches the default (undefined opts) behaviour', () => {
        const pal = new Float32Array([
            0.20, 0.10, 0.00,
            0.80, 0.10, 0.02
        ]);
        const px = new Float32Array([0.80, 0.10, 0.00]);
        const outDefault = new Uint32Array(1);
        const outExplicit = new Uint32Array(1);
        nearestPaletteIndexBuffer(px, pal, outDefault, 1, 2);
        nearestPaletteIndexBuffer(px, pal, outExplicit, 1, 2, { preserveLightness: false });
        expect(outExplicit[0]).toBe(outDefault[0]);
    });

    it('gives each pixel in a batch its own nearest', () => {
        const pal = new Float32Array([
            0.20, 0.00, 0.00,
            0.50, 0.00, 0.00,
            0.80, 0.00, 0.00
        ]);
        const px = new Float32Array([
            0.18, 0.00, 0.00,  // → 0
            0.52, 0.00, 0.00,  // → 1
            0.79, 0.00, 0.00,  // → 2
            0.35, 0.00, 0.00   // → 0 (tie at 0.15 with slot 1; lowest-index wins)
        ]);
        const out = new Uint32Array(4);
        nearestPaletteIndexBuffer(px, pal, out, 4, 3);
        expect(out[0]).toBe(0);
        expect(out[1]).toBe(1);
        expect(out[2]).toBe(2);
        expect(out[3]).toBe(0);
    });

    it('accepts a Uint16Array index buffer', () => {
        const pal = new Float32Array([0.5, 0.1, 0.0]);
        const px = new Float32Array([0.5, 0.1, 0.0]);
        const out = new Uint16Array(1);
        nearestPaletteIndexBuffer(px, pal, out, 1, 1);
        expect(out[0]).toBe(0);
    });

    it('accepts a Uint8Array index buffer', () => {
        const pal = new Float32Array([0.5, 0.1, 0.0]);
        const px = new Float32Array([0.5, 0.1, 0.0]);
        const out = new Uint8Array(1);
        nearestPaletteIndexBuffer(px, pal, out, 1, 1);
        expect(out[0]).toBe(0);
    });
});


// ─────────────────────────────────────────────────────────────────────────────
// remapPixelsToPalette — one-shot end-to-end
// ─────────────────────────────────────────────────────────────────────────────

// Reference palette: red, green, blue, black, white — in OKLCH.
// Rough hue anchors: red H≈29, green H≈142, blue H≈264.
const PALETTE = new Float32Array([
    0.628, 0.258,  29,   // red
    0.867, 0.294, 142,   // green
    0.452, 0.313, 264,   // blue
    0.000, 0.000,   0,   // black
    1.000, 0.000,   0    // white
]);

describe('remapPixelsToPalette', () => {
    it('maps a solid-red image to palette[0] and preserves alpha', () => {
        const w = 4, h = 4;
        const px = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) {
            px[i * 4]     = 255;
            px[i * 4 + 1] = 0;
            px[i * 4 + 2] = 0;
            px[i * 4 + 3] = 200;  // partial alpha
        }
        const out = new Uint32Array(w * h);
        remapPixelsToPalette(px, PALETTE, out, w * h, 5);
        const first = out[0];
        for (let i = 0; i < w * h; i++) {
            expect(out[i]).toBe(first);
        }
        expect((first >>> 24) & 0xFF).toBe(200);
        const r = first & 0xFF, g = (first >>> 8) & 0xFF, b = (first >>> 16) & 0xFF;
        expect(r).toBeGreaterThan(g);
        expect(r).toBeGreaterThan(b);
    });

    it('maps each primary-color pixel to its matching palette slot', () => {
        const px = new Uint8ClampedArray([
            255,   0,   0, 255,
              0, 255,   0, 255,
              0,   0, 255, 255,
              0,   0,   0, 255,
            255, 255, 255, 255
        ]);
        const out = new Uint32Array(5);
        remapPixelsToPalette(px, PALETTE, out, 5, 5);

        // Red pixel: R dominant.
        expect(out[0] & 0xFF).toBeGreaterThan((out[0] >>> 8) & 0xFF);
        // Green pixel: G dominant.
        expect((out[1] >>> 8) & 0xFF).toBeGreaterThan(out[1] & 0xFF);
        expect((out[1] >>> 8) & 0xFF).toBeGreaterThan((out[1] >>> 16) & 0xFF);
        // Blue pixel: B dominant.
        expect((out[2] >>> 16) & 0xFF).toBeGreaterThan(out[2] & 0xFF);
        // Black pixel.
        expect(out[3] & 0xFF).toBe(0);
        expect((out[3] >>> 8) & 0xFF).toBe(0);
        expect((out[3] >>> 16) & 0xFF).toBe(0);
        // White pixel.
        expect(out[4] & 0xFF).toBe(255);
    });

    it('preserveLightness produces per-pixel-L output (darker input stays darker)', () => {
        // Dark red input mapped through a palette containing a much lighter
        // "red-ish" slot. With preserveLightness, output L tracks the input's L
        // (dark), not the palette slot's L (light).
        const bright = new Float32Array([0.85, 0.15, 30]);  // light red-ish
        const px = new Uint8ClampedArray([64, 0, 0, 255]);  // very dark red
        const outSimple = new Uint32Array(1);
        const outPreserved = new Uint32Array(1);
        remapPixelsToPalette(px, bright, outSimple, 1, 1);
        remapPixelsToPalette(px, bright, outPreserved, 1, 1, { preserveLightness: true });

        const luma = (u) => 0.2126 * (u & 0xFF) + 0.7152 * ((u >>> 8) & 0xFF) + 0.0722 * ((u >>> 16) & 0xFF);
        // Simple path: output tracks palette L (bright).
        // Preserve path: output tracks pixel L (dark).
        expect(luma(outPreserved)).toBeLessThan(luma(outSimple) - 30);
    });

    it('passes input alpha byte through unchanged in both code paths', () => {
        const px = new Uint8ClampedArray([128, 128, 128, 137]);
        const outA = new Uint32Array(1);
        const outB = new Uint32Array(1);
        remapPixelsToPalette(px, PALETTE, outA, 1, 5);
        remapPixelsToPalette(px, PALETTE, outB, 1, 5, { preserveLightness: true });
        expect((outA[0] >>> 24) & 0xFF).toBe(137);
        expect((outB[0] >>> 24) & 0xFF).toBe(137);
    });

    it('is deterministic across repeated calls', () => {
        const px = new Uint8ClampedArray([200, 100, 50, 255, 40, 40, 40, 255]);
        const a = new Uint32Array(2);
        const b = new Uint32Array(2);
        remapPixelsToPalette(px, PALETTE, a, 2, 5);
        remapPixelsToPalette(px, PALETTE, b, 2, 5);
        expect(a[0]).toBe(b[0]);
        expect(a[1]).toBe(b[1]);
    });

    it('produces correct output after scratch has been grown by a larger palette', () => {
        // Grow scratch with a big palette, then verify a small-palette call
        // still produces the right output — no stale data leak from grown
        // scratch. A solid red pixel is unambiguous and must pick palette[0].
        const red = new Uint8ClampedArray([255, 0, 0, 255]);
        const big = new Float32Array(30);
        for (let i = 0; i < 10; i++) {
            big[i * 3]     = i / 10;
            big[i * 3 + 1] = 0;
            big[i * 3 + 2] = 0;
        }
        const throwaway = new Uint32Array(1);
        const out = new Uint32Array(1);
        remapPixelsToPalette(red, big, throwaway, 1, 10);   // grow scratch to 10
        remapPixelsToPalette(red, PALETTE, out, 1, 5);      // then use small palette
        const r = out[0] & 0xFF;
        const g = (out[0] >>> 8) & 0xFF;
        const b = (out[0] >>> 16) & 0xFF;
        expect(r).toBeGreaterThan(g);
        expect(r).toBeGreaterThan(b);
    });
});
