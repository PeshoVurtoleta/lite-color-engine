import { describe, it, expect } from 'vitest';

import { deltaEOK } from '../src/delta.js';
import { parseCSSColor } from '../src/authoring.js';


describe('deltaEOK', () => {
    it('returns 0 for identical colors', () => {
        const a = new Float32Array([0.5, 0.15, 240]);
        const b = new Float32Array([0.5, 0.15, 240]);
        expect(deltaEOK(a, 0, b, 0)).toBe(0);
    });

    it('returns 0 for the same buffer at the same offset', () => {
        const buf = new Float32Array([0.6, 0.10, 30]);
        expect(deltaEOK(buf, 0, buf, 0)).toBe(0);
    });

    it('is symmetric: d(a, b) === d(b, a)', () => {
        const a = new Float32Array([0.5, 0.15, 60]);
        const b = new Float32Array([0.7, 0.10, 200]);
        expect(deltaEOK(a, 0, b, 0)).toBe(deltaEOK(b, 0, a, 0));
    });

    it('is non-negative for any pair', () => {
        const a = new Float32Array([0.30, 0.05, 10]);
        const b = new Float32Array([0.90, 0.35, 300]);
        expect(deltaEOK(a, 0, b, 0)).toBeGreaterThanOrEqual(0);
    });

    it('gives a large value between visually distant colors (red vs blue)', () => {
        // Pure red and pure blue in OKLCH — should be well above the "unambiguous" 0.15 threshold.
        const buf = new Float32Array(6);
        parseCSSColor('#ff0000', buf, 0);
        parseCSSColor('#0000ff', buf, 3);
        expect(deltaEOK(buf, 0, buf, 3)).toBeGreaterThan(0.15);
    });

    it('gives a small value between near-identical colors', () => {
        // Two colors 0.01 apart in L, same hue and chroma.
        const a = new Float32Array([0.50, 0.10, 60]);
        const b = new Float32Array([0.51, 0.10, 60]);
        expect(deltaEOK(a, 0, b, 0)).toBeCloseTo(0.01, 6);
    });

    it('respects offsets — computes ΔE from the correct triplet in a larger buffer', () => {
        // Layout: [red, blue, green]. ΔE(red, blue) should be much larger than ΔE(red, red).
        const buf = new Float32Array(9);
        parseCSSColor('#ff0000', buf, 0);
        parseCSSColor('#0000ff', buf, 3);
        parseCSSColor('#ff0000', buf, 6);
        expect(deltaEOK(buf, 0, buf, 6)).toBeCloseTo(0, 5);
        expect(deltaEOK(buf, 0, buf, 3)).toBeGreaterThan(0.15);
    });

    it('handles hue wraparound correctly (H=1 vs H=359 is a small ΔE at same L, C)', () => {
        // 1° and 359° are only 2° apart on the wheel — after cos/sin, the (a,b)
        // vectors are near-identical, so ΔE should be tiny.
        const a = new Float32Array([0.5, 0.10,   1]);
        const b = new Float32Array([0.5, 0.10, 359]);
        const d = deltaEOK(a, 0, b, 0);
        expect(d).toBeLessThan(0.01);
    });

    it('grows monotonically as chroma diverges at fixed L and H', () => {
        const base = new Float32Array([0.5, 0.05, 60]);
        const mid  = new Float32Array([0.5, 0.15, 60]);
        const far  = new Float32Array([0.5, 0.25, 60]);
        const dMid = deltaEOK(base, 0, mid, 0);
        const dFar = deltaEOK(base, 0, far, 0);
        expect(dMid).toBeGreaterThan(0);
        expect(dFar).toBeGreaterThan(dMid);
    });

    it('is deterministic (no hidden state, same result on repeated calls)', () => {
        const a = new Float32Array([0.5, 0.15, 60]);
        const b = new Float32Array([0.7, 0.10, 200]);
        const first = deltaEOK(a, 0, b, 0);
        for (let i = 0; i < 1000; i++) {
            expect(deltaEOK(a, 0, b, 0)).toBe(first);
        }
    });
});
