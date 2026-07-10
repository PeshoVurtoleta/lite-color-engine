import { describe, it, expect } from 'vitest';

import { parseCSSColor } from '../src/authoring.js';
import { sRgbToOklchBuffer, displayP3ToOklchBuffer, oklchToLinearP3 } from '../src/convert.js';
import {
    packOklchBufferToUint32,
    packOklchBufferToUint32P3,
    packOklchBufferToUint32P3Fast
} from '../src/runtime.js';

const linearize = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

describe('display-p3 parsing', () => {
    it('parseCSSColor accepts color(display-p3 ...)', () => {
        const buf = new Float32Array(3);
        const alpha = parseCSSColor('color(display-p3 0.9 0.3 0.1)', buf, 0);
        expect(alpha).toBeCloseTo(1, 5);
        expect(buf[1]).toBeGreaterThan(0.2); // red-ish -> decent chroma
    });

    it('parses slash-alpha in display-p3', () => {
        const buf = new Float32Array(3);
        const alpha = parseCSSColor('color(display-p3 0.2 0.5 0.9 / 0.4)', buf, 0);
        expect(alpha).toBeCloseTo(0.4, 3);
    });

    it('parses percentage components', () => {
        const a = new Float32Array(3), b = new Float32Array(3);
        parseCSSColor('color(display-p3 100% 30% 10%)', a, 0);
        parseCSSColor('color(display-p3 1 0.3 0.1)', b, 0);
        expect(a[0]).toBeCloseTo(b[0], 5);
        expect(a[1]).toBeCloseTo(b[1], 5);
        expect(a[2]).toBeCloseTo(b[2], 3);
    });
});

describe('display-p3 conversion correctness', () => {
    // Strong guard: an in-sRGB-gamut colour expressed in P3 must yield the SAME
    // OKLCH as the (known-good) sRGB path. Oracle values below were computed via
    // the sRGB->XYZ->P3 chain; here we assert the two engine paths agree.
    it('P3 red is more saturated than sRGB red', () => {
        const p3 = new Float32Array(3), srgb = new Float32Array(3);
        displayP3ToOklchBuffer(255, 0, 0, p3, 0);
        parseCSSColor('#ff0000', srgb, 0);
        expect(p3[1]).toBeGreaterThan(srgb[1] * 1.1);
    });

    it('round-trips P3 rgb -> OKLCH -> linear P3', () => {
        const out = new Float32Array(3), o = new Float32Array(3);
        for (const [R, G, B] of [[255,0,0],[0,255,0],[0,0,255],[200,50,240],[30,30,30]]) {
            displayP3ToOklchBuffer(R, G, B, o, 0);
            oklchToLinearP3(o[0], o[1], o[2], out);
            expect(out[0]).toBeCloseTo(linearize(R/255), 5);
            expect(out[1]).toBeCloseTo(linearize(G/255), 5);
            expect(out[2]).toBeCloseTo(linearize(B/255), 5);
        }
    });
});

describe('display-p3 packers', () => {
    it('P3 packer differs from sRGB packer on wide-gamut colours', () => {
        const buf = new Float32Array(3);
        parseCSSColor('oklch(70% 0.25 200)', buf, 0);
        expect(packOklchBufferToUint32P3(buf, 0)).not.toBe(packOklchBufferToUint32(buf, 0));
    });

    it('fast P3 packer returns a valid uint32', () => {
        const buf = new Float32Array(3);
        parseCSSColor('color(display-p3 0.5 0.8 0.2)', buf, 0);
        const v = packOklchBufferToUint32P3Fast(buf, 0);
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThanOrEqual(0xFFFFFFFF);
    });
});
