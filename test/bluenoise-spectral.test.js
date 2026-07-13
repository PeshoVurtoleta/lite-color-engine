import { describe, it, expect } from 'vitest';
import { getBlueNoise64 } from '../index.js';

// ---------------------------------------------------------------------------
// Why this file exists
// ---------------------------------------------------------------------------
// v1.5.0-rc shipped a tile that passed every gate in dither.test.js -- uniform
// histogram, stable SHA-256, +/-1 bounded deviation, no chroma speckle, halved
// banding run-length -- and was still 7x over-clustered above mid-gray, because
// Phase 3 of the void-and-cluster generator selected the MAXIMUM of the ones-field
// (an isolated zero) instead of the minimum (the tightest cluster of zeros).
//
// None of those gates could see it:
//   - the histogram is invariant under ANY permutation of ranks (a linear ramp
//     passes it: t[i] = i >> 4 gives each byte exactly 16 times);
//   - the SHA pins the artifact, it does not validate it -- it was cementing the
//     defect into the contract;
//   - "run-length halved vs undithered" is satisfied by white noise too. It tests
//     THAT there is noise, not that the noise is blue.
//
// These are the gates that actually constrain blue-noise-ness. The symmetry test
// alone fails the old tile on the first run.
// ---------------------------------------------------------------------------

const N = 64;
const SIZE = N * N;
const SIGMA2 = 2 * 1.5 * 1.5;
const KR = 6;
const KD = KR * 2 + 1;

const KERNEL = new Float64Array(KD * KD);
for (let dy = -KR; dy <= KR; dy++) {
    for (let dx = -KR; dx <= KR; dx++) {
        KERNEL[(dy + KR) * KD + (dx + KR)] = Math.exp(-(dx * dx + dy * dy) / SIGMA2);
    }
}
KERNEL[KR * KD + KR] = 0; // exclude self (Ulichney)

/**
 * Stddev of the Gaussian-filtered MINORITY-phase field of the binary pattern
 * {tile < T}. Low = the minority pixels are spread evenly = blue. High = they
 * are clumped. Filtered toroidally, matching the generator.
 */
const clumpiness = (tile, T) => {
    const bp = new Uint8Array(SIZE);
    let ones = 0;
    for (let i = 0; i < SIZE; i++) { bp[i] = tile[i] < T ? 1 : 0; ones += bp[i]; }
    const minority = ones > (SIZE >> 1) ? 0 : 1;

    const field = new Float64Array(SIZE);
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            if (bp[y * N + x] !== minority) continue;
            for (let ky = 0; ky < KD; ky++) {
                const fy = (y + ky - KR + N) % N;
                for (let kx = 0; kx < KD; kx++) {
                    const fx = (x + kx - KR + N) % N;
                    field[fy * N + fx] += KERNEL[ky * KD + kx];
                }
            }
        }
    }
    let mean = 0;
    for (let i = 0; i < SIZE; i++) mean += field[i];
    mean /= SIZE;
    let variance = 0;
    for (let i = 0; i < SIZE; i++) { const d = field[i] - mean; variance += d * d; }
    return Math.sqrt(variance / SIZE);
};

/**
 * Radially-averaged power spectrum of the tile, via a separable DFT (O(N^3)).
 * The DFT treats the tile as periodic, so this measures the TILED signal --
 * a tile that is not torus-correct shows up here as low-frequency leakage.
 * Returns power[r] for r = 1..32; the white-noise floor is var(U[0,1]) = 1/12.
 */
const radialPower = (tile) => {
    const re1 = new Float64Array(SIZE), im1 = new Float64Array(SIZE);
    const cos = new Float64Array(N * N), sin = new Float64Array(N * N);
    for (let k = 0; k < N; k++) {
        for (let x = 0; x < N; x++) {
            const a = -2 * Math.PI * k * x / N;
            cos[k * N + x] = Math.cos(a);
            sin[k * N + x] = Math.sin(a);
        }
    }
    // rows
    for (let y = 0; y < N; y++) {
        for (let u = 0; u < N; u++) {
            let r = 0, i = 0;
            for (let x = 0; x < N; x++) {
                const s = tile[y * N + x] / 255 - 0.5;
                r += s * cos[u * N + x];
                i += s * sin[u * N + x];
            }
            re1[y * N + u] = r; im1[y * N + u] = i;
        }
    }
    // columns
    const rings = new Float64Array(33), counts = new Uint32Array(33);
    for (let u = 0; u < N; u++) {
        for (let v = 0; v < N; v++) {
            let r = 0, i = 0;
            for (let y = 0; y < N; y++) {
                const c = cos[v * N + y], s = sin[v * N + y];
                r += re1[y * N + u] * c - im1[y * N + u] * s;
                i += re1[y * N + u] * s + im1[y * N + u] * c;
            }
            if (u === 0 && v === 0) continue;
            const du = u > N / 2 ? u - N : u;
            const dv = v > N / 2 ? v - N : v;
            const ring = Math.round(Math.hypot(du, dv));
            if (ring >= 1 && ring <= 32) {
                rings[ring] += (r * r + i * i) / SIZE;
                counts[ring]++;
            }
        }
    }
    const out = new Float64Array(33);
    for (let r = 1; r <= 32; r++) out[r] = counts[r] ? rings[r] / counts[r] : 0;
    return out;
};

const WHITE_NOISE_FLOOR = 1 / 12; // 0.0833 -- power per ring for uniform white noise

describe('blue-noise tile: spectral gates', () => {
    const tile = getBlueNoise64();

    it('is blue at EVERY threshold, not just at T=128', () => {
        // The generator's old self-check measured T=128 only -- the single
        // threshold an inverted Phase 3 cannot affect, since Phase 3 only
        // permutes ranks >= 2048 and leaves the T=128 binarization identical.
        for (const T of [16, 32, 64, 96, 128, 160, 192, 224, 240]) {
            const c = clumpiness(tile, T);
            expect(c, `clumpiness at T=${T}`).toBeLessThan(0.7);
        }
    });

    it('has a clumpiness curve symmetric about T=128', () => {
        // At T and 256-T the minority phase simply swaps roles, so a correct
        // dither array must be equally homogeneous on both sides. THIS is the
        // assertion that fails the old tile: 0.36 at T=32 vs 2.64 at T=224.
        for (const T of [16, 32, 64, 96]) {
            const lo = clumpiness(tile, T);
            const hi = clumpiness(tile, 256 - T);
            expect(Math.abs(lo - hi), `|clump(${T}) - clump(${256 - T})|`).toBeLessThan(0.08);
        }
    });

    it('suppresses low-frequency energy well below the white-noise floor', () => {
        // The defining property of blue noise. The old tile carried 0.577 here --
        // 7x the white-noise floor, i.e. WORSE than random at these frequencies,
        // which is a visible blotch at the 64px tile period.
        const p = radialPower(tile);
        let low = 0;
        for (let r = 1; r <= 4; r++) low += p[r];
        low /= 4;
        expect(low, 'mean radial power r=1..4').toBeLessThan(0.02);
        expect(low).toBeLessThan(WHITE_NOISE_FLOOR);
    });

    it('pushes energy into the high frequencies (that is what makes it blue)', () => {
        const p = radialPower(tile);
        let high = 0;
        for (let r = 21; r <= 32; r++) high += p[r];
        high /= 12;
        expect(high, 'mean radial power r=21..32').toBeGreaterThan(WHITE_NOISE_FLOOR);
    });

    it('is torus-seamless: the wrap edges are as decorrelated as the interior', () => {
        // A tile that is only locally blue but not toroidally blue produces a
        // visible grid at the tile period. Blue noise is strongly ANTI-correlated
        // between neighbours, so |delta| across the wrap must not collapse toward
        // the smoother, correlated regime. The old tile scored 67.5 across the
        // horizontal wrap against 92.2 in the interior.
        const meanAbsDelta = (pairs) => {
            let s = 0;
            for (const [a, b] of pairs) s += Math.abs(a - b);
            return s / pairs.length;
        };
        const wrapX = [], wrapY = [], interiorX = [], interiorY = [];
        for (let y = 0; y < N; y++) {
            wrapX.push([tile[y * N + (N - 1)], tile[y * N + 0]]);
            for (let x = 0; x < N - 1; x++) interiorX.push([tile[y * N + x], tile[y * N + x + 1]]);
        }
        for (let x = 0; x < N; x++) {
            wrapY.push([tile[(N - 1) * N + x], tile[0 * N + x]]);
            for (let y = 0; y < N - 1; y++) interiorY.push([tile[y * N + x], tile[(y + 1) * N + x]]);
        }
        const ix = meanAbsDelta(interiorX);
        const iy = meanAbsDelta(interiorY);
        // 64 samples per seam, so allow generous slack -- we are catching a
        // structural break (a ~30% collapse), not measuring to three places.
        expect(meanAbsDelta(wrapX) / ix, 'horizontal wrap vs interior').toBeGreaterThan(0.82);
        expect(meanAbsDelta(wrapY) / iy, 'vertical wrap vs interior').toBeGreaterThan(0.82);
    });

    it('a uniform histogram alone proves nothing (guards the gate, not the tile)', () => {
        // A linear ramp has a PERFECTLY uniform histogram and zero blue-noise
        // character. If this ever stops failing the spectral gates, the gates
        // have gone slack.
        const ramp = new Uint8Array(SIZE);
        for (let i = 0; i < SIZE; i++) ramp[i] = i >> 4;
        const hist = new Uint32Array(256);
        for (const b of ramp) hist[b]++;
        expect(hist.every((c) => c === 16)).toBe(true);      // passes the old gate
        expect(clumpiness(ramp, 192)).toBeGreaterThan(0.7);  // fails this one
    });
});
