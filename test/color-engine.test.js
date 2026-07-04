import { describe, it, expect } from 'vitest';

import {
    parseCSSColor,
    parseHexToBuffer,
    parseRgbToBuffer,
    parseHslToBuffer,
    parseOklchToBuffer,
    parseOklabToBuffer,
} from '../src/authoring.js';

import {
    lerpOklchBuffer,
    packOklchBufferToUint32,
    packOklchBufferToUint32Fast,
    sampleColorLUT,
} from '../src/runtime.js';

import { bakeGradientToUint32 } from '../src/lut.js';
import { sRgbToOklchBuffer } from '../src/convert.js';

// ─────────────────────────────────────────────────────────────────────────────
// Authoring: parseCSSColor master switch
// ─────────────────────────────────────────────────────────────────────────────

describe('parseCSSColor — master dispatch', () => {
    it('parses standard hex into OKLCH memory', () => {
        const buf = new Float32Array(3);
        const alpha = parseCSSColor('#FF0000', buf, 0);
        expect(alpha).toBe(1.0);
        expect(buf[0]).toBeGreaterThan(0.6);  // Lightness of pure red
        expect(buf[1]).toBeGreaterThan(0.2);  // Chroma
        expect(buf[2]).toBeCloseTo(29.23, 1); // Red hue in OKLCH
    });

    it('parses oklch() with slash-alpha into the buffer verbatim', () => {
        const buf = new Float32Array(3);
        const alpha = parseCSSColor('oklch(60% 0.15 250 / 0.5)', buf, 0);
        expect(alpha).toBe(0.5);
        expect(buf[0]).toBeCloseTo(0.6, 5);
        expect(buf[1]).toBeCloseTo(0.15, 5);
        expect(buf[2]).toBeCloseTo(250, 5);
    });

    it('routes named colors through the hex fast-path', () => {
        const ref = new Float32Array(3);
        const named = new Float32Array(3);
        parseCSSColor('#ff0000', ref, 0);
        parseCSSColor('red', named, 0);
        expect(named[0]).toBeCloseTo(ref[0], 5);
        expect(named[1]).toBeCloseTo(ref[1], 5);
        expect(named[2]).toBeCloseTo(ref[2], 5);
    });

    it('handles a representative sample of named colors', () => {
        const buf = new Float32Array(3);
        for (const name of ['black', 'white', 'transparent', 'rebeccapurple', 'lightcoral']) {
            expect(() => parseCSSColor(name, buf, 0)).not.toThrow();
        }
    });

    it('is case- and whitespace-insensitive', () => {
        const a = new Float32Array(3);
        const b = new Float32Array(3);
        parseCSSColor('  RED  ', a, 0);
        parseCSSColor('red', b, 0);
        expect(a[0]).toBeCloseTo(b[0], 5);
        expect(a[1]).toBeCloseTo(b[1], 5);
        expect(a[2]).toBeCloseTo(b[2], 5);
    });

    it('throws on garbage input', () => {
        const buf = new Float32Array(3);
        expect(() => parseCSSColor('not-a-color', buf, 0)).toThrow();
        expect(() => parseCSSColor('#zzz', buf, 0)).toThrow();
    });

    it('writes to the requested offset, leaving other slots untouched', () => {
        const buf = new Float32Array(9);
        buf.fill(-1);
        parseCSSColor('#ff0000', buf, 3);
        expect(buf[0]).toBe(-1);
        expect(buf[1]).toBe(-1);
        expect(buf[2]).toBe(-1);
        expect(buf[3]).toBeGreaterThan(0); // L written here
        expect(buf[6]).toBe(-1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Authoring: hex
// ─────────────────────────────────────────────────────────────────────────────

describe('parseHexToBuffer', () => {
    it('expands 3-digit shorthand', () => {
        const ref = new Float32Array(3);
        const sh = new Float32Array(3);
        parseHexToBuffer('#ffffff', ref, 0);
        parseHexToBuffer('#fff', sh, 0);
        expect(sh[0]).toBeCloseTo(ref[0], 5);
        expect(sh[1]).toBeCloseTo(ref[1], 5);
        expect(sh[2]).toBeCloseTo(ref[2], 5);
    });

    it('expands 4-digit shorthand and reads alpha', () => {
        const buf = new Float32Array(3);
        const a = parseHexToBuffer('#ff00', buf, 0);
        expect(a).toBe(0); // 0x00 / 255 = 0
    });

    it('parses 8-digit hex alpha', () => {
        const buf = new Float32Array(3);
        const a = parseHexToBuffer('#ff000080', buf, 0);
        expect(a).toBeCloseTo(0x80 / 255, 5);
    });

    it('rejects malformed lengths', () => {
        const buf = new Float32Array(3);
        expect(() => parseHexToBuffer('#abcde', buf, 0)).toThrow();
        expect(() => parseHexToBuffer('#1234567', buf, 0)).toThrow();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Authoring: rgb / hsl / oklab
// ─────────────────────────────────────────────────────────────────────────────

describe('parseRgbToBuffer', () => {
    it('parses comma-separated rgba()', () => {
        const buf = new Float32Array(3);
        const a = parseRgbToBuffer('rgba(255, 0, 0, 0.25)', buf, 0);
        expect(a).toBe(0.25);
        expect(buf[2]).toBeCloseTo(29.23, 1);
    });

    it('parses slash-alpha rgb()', () => {
        const buf = new Float32Array(3);
        const a = parseRgbToBuffer('rgb(255 0 0 / 0.5)', buf, 0);
        expect(a).toBe(0.5);
    });

    it('parses % channel values', () => {
        const buf = new Float32Array(3);
        parseRgbToBuffer('rgb(100% 0% 0%)', buf, 0);
        expect(buf[2]).toBeCloseTo(29.23, 1);
    });
});

describe('parseHslToBuffer', () => {
    it('parses standard hsl()', () => {
        const buf = new Float32Array(3);
        parseHslToBuffer('hsl(0, 100%, 50%)', buf, 0); // pure red
        expect(buf[2]).toBeCloseTo(29.23, 1);
    });

    it('accepts deg/rad/turn hue units', () => {
        const a = new Float32Array(3);
        const b = new Float32Array(3);
        const c = new Float32Array(3);
        parseHslToBuffer('hsl(120deg, 100%, 50%)', a, 0);
        parseHslToBuffer('hsl(0.3333turn, 100%, 50%)', b, 0);
        parseHslToBuffer('hsl(2.0944rad, 100%, 50%)', c, 0);
        // All three should land on the same hue (~ green's OKLCH hue)
        expect(b[2]).toBeCloseTo(a[2], 0);
        expect(c[2]).toBeCloseTo(a[2], 0);
    });
});

describe('parseOklabToBuffer', () => {
    it('converts a/b to polar C/H correctly', () => {
        const buf = new Float32Array(3);
        // Pure red is approximately oklab(0.628 0.225 0.126)
        parseOklabToBuffer('oklab(62.8% 0.225 0.126)', buf, 0);
        expect(buf[0]).toBeCloseTo(0.628, 2);
        expect(buf[1]).toBeCloseTo(Math.sqrt(0.225 * 0.225 + 0.126 * 0.126), 3);
        expect(buf[2]).toBeCloseTo(29.23, 0);
    });

    it('canonicalizes negative-a/b hues into [0, 360)', () => {
        const buf = new Float32Array(3);
        parseOklabToBuffer('oklab(0.5 -0.1 -0.1)', buf, 0);
        expect(buf[2]).toBeGreaterThanOrEqual(0);
        expect(buf[2]).toBeLessThan(360);
    });
});

describe('parseOklchToBuffer', () => {
    it('round-trips a numeric oklch() string verbatim', () => {
        const buf = new Float32Array(3);
        parseOklchToBuffer('oklch(0.7 0.2 180)', buf, 0);
        expect(buf[0]).toBeCloseTo(0.7, 5);
        expect(buf[1]).toBeCloseTo(0.2, 5);
        expect(buf[2]).toBeCloseTo(180, 5);
    });

    it('accepts deg/rad/turn hue', () => {
        const buf = new Float32Array(3);
        parseOklchToBuffer('oklch(0.5 0.1 0.5turn)', buf, 0);
        expect(buf[2]).toBeCloseTo(180, 5);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Convert: sRGB → OKLCH (forward path)
// ─────────────────────────────────────────────────────────────────────────────

describe('sRgbToOklchBuffer', () => {
    it('produces L=0 for pure black', () => {
        const buf = new Float32Array(3);
        sRgbToOklchBuffer(0, 0, 0, buf, 0);
        expect(buf[0]).toBeCloseTo(0, 5);
    });

    it('produces L≈1 for pure white with negligible chroma', () => {
        const buf = new Float32Array(3);
        sRgbToOklchBuffer(255, 255, 255, buf, 0);
        expect(buf[0]).toBeCloseTo(1, 4);
        expect(buf[1]).toBeLessThan(0.001);
    });

    it('keeps hue strictly inside [0, 360) for all primaries', () => {
        const buf = new Float32Array(3);
        for (const [r, g, b] of [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255]]) {
            sRgbToOklchBuffer(r, g, b, buf, 0);
            expect(buf[2]).toBeGreaterThanOrEqual(0);
            expect(buf[2]).toBeLessThan(360);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Runtime: lerp
// ─────────────────────────────────────────────────────────────────────────────

describe('lerpOklchBuffer', () => {
    it('returns A at t=0 and B at t=1', () => {
        const A = new Float32Array([0.2, 0.1, 30]);
        const B = new Float32Array([0.8, 0.3, 200]);
        const out = new Float32Array(3);

        lerpOklchBuffer(A, 0, B, 0, 0, out, 0);
        expect(out[0]).toBeCloseTo(0.2, 5);
        expect(out[1]).toBeCloseTo(0.1, 5);
        expect(out[2]).toBeCloseTo(30, 5);

        lerpOklchBuffer(A, 0, B, 0, 1, out, 0);
        expect(out[0]).toBeCloseTo(0.8, 5);
        expect(out[1]).toBeCloseTo(0.3, 5);
        expect(out[2]).toBeCloseTo(200, 5);
    });

    it('interpolates hue along the SHORT arc (350° → 10° passes through 0°)', () => {
        const A = new Float32Array([0.5, 0.1, 350]);
        const B = new Float32Array([0.5, 0.1, 10]);
        const out = new Float32Array(3);
        lerpOklchBuffer(A, 0, B, 0, 0.5, out, 0);
        // Short path: 350 → 10 via 0 = midpoint at 0/360
        expect(out[2] === 0 || Math.abs(out[2] - 360) < 0.01 || out[2] < 1).toBe(true);
    });

    it('clamps lightness to [0, 1] on extrapolation', () => {
        const A = new Float32Array([0.0, 0.1, 0]);
        const B = new Float32Array([1.0, 0.1, 0]);
        const out = new Float32Array(3);
        lerpOklchBuffer(A, 0, B, 0, 2, out, 0); // extrapolate
        expect(out[0]).toBe(1);
        lerpOklchBuffer(A, 0, B, 0, -1, out, 0);
        expect(out[0]).toBe(0);
    });

    it('clamps chroma to >= 0', () => {
        const A = new Float32Array([0.5, 0, 0]);
        const B = new Float32Array([0.5, 0.2, 0]);
        const out = new Float32Array(3);
        lerpOklchBuffer(A, 0, B, 0, -2, out, 0);
        expect(out[1]).toBe(0);
    });

    it('honors offsets — supports SoA-style packed buffers', () => {
        const buf = new Float32Array([
            0.2, 0.1, 30,    // color 0
            0.8, 0.3, 200,   // color 1
            0, 0, 0,         // out
        ]);
        lerpOklchBuffer(buf, 0, buf, 3, 0.5, buf, 6);
        expect(buf[6]).toBeCloseTo(0.5, 5);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Runtime: pack (accurate vs fast)
// ─────────────────────────────────────────────────────────────────────────────

describe('packOklchBufferToUint32 (accurate, sRGB transfer)', () => {
    it('produces opaque black 0xFF000000 for L=0', () => {
        const buf = new Float32Array([0, 0, 0]);
        expect(packOklchBufferToUint32(buf, 0, 1.0)).toBe(0xFF000000);
    });

    it('round-trips mid-gray within 1/255', () => {
        const buf = new Float32Array(3);
        sRgbToOklchBuffer(128, 128, 128, buf, 0);
        const packed = packOklchBufferToUint32(buf, 0, 1.0);
        // little-endian RGBA: low byte is R
        const r = packed & 0xff;
        const g = (packed >>> 8) & 0xff;
        const b = (packed >>> 16) & 0xff;
        expect(Math.abs(r - 128)).toBeLessThanOrEqual(1);
        expect(Math.abs(g - 128)).toBeLessThanOrEqual(1);
        expect(Math.abs(b - 128)).toBeLessThanOrEqual(1);
    });

    it('round-trips primaries exactly', () => {
        const buf = new Float32Array(3);
        for (const [R, G, B] of [[255, 0, 0], [0, 255, 0], [0, 0, 255]]) {
            sRgbToOklchBuffer(R, G, B, buf, 0);
            const packed = packOklchBufferToUint32(buf, 0, 1.0);
            const r = packed & 0xff;
            const g = (packed >>> 8) & 0xff;
            const b = (packed >>> 16) & 0xff;
            expect(Math.abs(r - R)).toBeLessThanOrEqual(1);
            expect(Math.abs(g - G)).toBeLessThanOrEqual(1);
            expect(Math.abs(b - B)).toBeLessThanOrEqual(1);
        }
    });

    it('clamps alpha < 0 to 0 and alpha > 1 to 255', () => {
        const buf = new Float32Array([1, 0, 0]);
        expect((packOklchBufferToUint32(buf, 0, -1) >>> 24) & 0xff).toBe(0);
        expect((packOklchBufferToUint32(buf, 0, 5) >>> 24) & 0xff).toBe(255);
    });

    it('emits a non-negative Uint32 even when the high bit is set', () => {
        const buf = new Float32Array([1, 0, 0]);
        const v = packOklchBufferToUint32(buf, 0, 1.0);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(v)).toBe(true);
    });
});

describe('packOklchBufferToUint32Fast (sqrt approximation)', () => {
    it('matches accurate path on pure black', () => {
        const buf = new Float32Array([0, 0, 0]);
        expect(packOklchBufferToUint32Fast(buf, 0, 1.0)).toBe(0xFF000000);
    });

    it('intentionally darkens mid-gray (documented tradeoff)', () => {
        const buf = new Float32Array(3);
        sRgbToOklchBuffer(128, 128, 128, buf, 0);
        const fast = packOklchBufferToUint32Fast(buf, 0, 1.0);
        const r = fast & 0xff;
        // Fast path is known to undershoot mid-gray by ~10/255.
        expect(r).toBeLessThan(128);
        expect(r).toBeGreaterThan(110);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// LUT: bake + sample
// ─────────────────────────────────────────────────────────────────────────────

describe('bakeGradientToUint32', () => {
    it('produces a Uint32Array of the requested length', () => {
        const stops = new Float32Array(6);
        parseCSSColor('#000000', stops, 0);
        parseCSSColor('#ffffff', stops, 3);
        const lut = bakeGradientToUint32(stops, 2, 64);
        expect(lut).toBeInstanceOf(Uint32Array);
        expect(lut.length).toBe(64);
    });

    it('pins endpoints — index 0 ≈ stop 0, last index ≈ stop N-1', () => {
        const stops = new Float32Array(6);
        parseCSSColor('#ff0000', stops, 0);
        parseCSSColor('#0000ff', stops, 3);
        const lut = bakeGradientToUint32(stops, 2, 256);
        const first = lut[0] & 0xff;
        const last = lut[255] & 0xff;
        expect(first).toBeGreaterThan(200); // red
        expect(last).toBeLessThan(50);      // blue (low R)
    });

    it('throws on degenerate stop counts and resolutions', () => {
        const stops = new Float32Array(3);
        expect(() => bakeGradientToUint32(stops, 1, 64)).toThrow();
        expect(() => bakeGradientToUint32(stops, 2, 1)).toThrow();
    });

    it('clamps overshoot easings instead of NaN-poisoning the buffer', () => {
        const stops = new Float32Array(6);
        parseCSSColor('#ff0000', stops, 0);
        parseCSSColor('#0000ff', stops, 3);
        // back-out style ease: returns values < 0 and > 1
        const aggressive = (t) => t * 1.4 - 0.2;
        const lut = bakeGradientToUint32(stops, 2, 32, aggressive);
        for (let i = 0; i < lut.length; i++) {
            expect(Number.isFinite(lut[i])).toBe(true);
            expect(lut[i]).toBeGreaterThanOrEqual(0);
        }
    });

    it('accepts a custom packer (Fast variant)', () => {
        const stops = new Float32Array(6);
        parseCSSColor('#808080', stops, 0);
        parseCSSColor('#808080', stops, 3);
        const accurate = bakeGradientToUint32(stops, 2, 8);
        const fast = bakeGradientToUint32(stops, 2, 8, undefined, packOklchBufferToUint32Fast);
        // Accurate gives ~0x80 in each channel; fast gives ~0x76 in each channel.
        expect(accurate[0] & 0xff).toBeGreaterThan(fast[0] & 0xff);
    });
});

describe('sampleColorLUT', () => {
    it('returns lut[0] at t=0 and lut[last] at t=1', () => {
        const lut = new Uint32Array([0xAAAAAAAA, 0xBBBBBBBB, 0xCCCCCCCC, 0xDDDDDDDD]);
        expect(sampleColorLUT(lut, 0)).toBe(0xAAAAAAAA);
        expect(sampleColorLUT(lut, 1)).toBe(0xDDDDDDDD);
    });

    it('clamps t outside [0, 1]', () => {
        const lut = new Uint32Array([0xAAAAAAAA, 0xBBBBBBBB, 0xCCCCCCCC, 0xDDDDDDDD]);
        expect(sampleColorLUT(lut, -10)).toBe(0xAAAAAAAA);
        expect(sampleColorLUT(lut, 999)).toBe(0xDDDDDDDD);
    });

    it('selects the floor-indexed entry mid-range', () => {
        const lut = new Uint32Array([10, 20, 30, 40]);
        // (0.5 * 3) | 0 = 1
        expect(sampleColorLUT(lut, 0.5)).toBe(20);
    });
});
