// Bench for the v1.5 dither + P3 batch + closed-bake additions.
// Follows the v1.3 median-of-80 / 100k-triplet convention.

import {
    packOklchBufferToUint32,
    packOklchBufferToUint32Dithered,
    packOklchBufferToUint32IntoN,
    packOklchBufferToUint32IntoNDithered,
    packOklchBufferToUint32P3,
    packOklchBufferToUint32P3IntoN,
    bakeGradientToUint32,
    getBlueNoise64
} from '../index.js';

const N = 100_000;
const RUNS = 80;

const median = (arr) => {
    const s = arr.slice().sort((a, b) => a - b);
    return s[s.length >> 1];
};

const bench = (label, fn) => {
    // Warm-up
    for (let w = 0; w < 20; w++) fn();
    const samples = new Array(RUNS);
    for (let r = 0; r < RUNS; r++) {
        const t0 = performance.now();
        fn();
        samples[r] = performance.now() - t0;
    }
    const med = median(samples);
    const throughput = (N / med) * 1000 / 1e6;
    console.log(`  ${label.padEnd(48)} ${med.toFixed(2).padStart(7)} ms  ${throughput.toFixed(1).padStart(5)} M/s`);
    return med;
};

// -- Setup buffers -----------------------------------------------------------
const src = new Float32Array(N * 3);
for (let i = 0; i < N; i++) {
    src[i * 3] = 0.5 + (Math.sin(i * 0.0001) * 0.3);
    src[i * 3 + 1] = 0.05 + (Math.cos(i * 0.0003) * 0.05);
    src[i * 3 + 2] = (i * 0.13) % 360;
}
const dst = new Uint32Array(N);
const tile = getBlueNoise64();

console.log(`\nlite-color-engine v1.5 bench  (N=${N}, median of ${RUNS} runs)\n`);
console.log('  === Existing paths (regression sanity) ===');

// v1.3 baselines
bench('packOklchBufferToUint32IntoN (accurate)', () => {
    packOklchBufferToUint32IntoN(src, 0, dst, 0, N, 1, false);
});
const lutMed = bench('packOklchBufferToUint32IntoN (useLut=true)', () => {
    packOklchBufferToUint32IntoN(src, 0, dst, 0, N, 1, true);
});
bench('scalar loop of packOklchBufferToUint32', () => {
    for (let i = 0; i < N; i++) dst[i] = packOklchBufferToUint32(src, i * 3, 1);
});

console.log('\n  === v1.5 additions ===');

// Dithered scalar
bench('scalar loop of packOklchBufferToUint32Dithered', () => {
    for (let i = 0; i < N; i++) {
        const noise01 = tile[((0 & 63) << 6) | (i & 63)] / 256;
        dst[i] = packOklchBufferToUint32Dithered(src, i * 3, 1, noise01);
    }
});

// Dithered batch (v1.5 flagship)
const dithMed = bench('packOklchBufferToUint32IntoNDithered', () => {
    packOklchBufferToUint32IntoNDithered(src, 0, dst, 0, N, 1, tile, 0, 0, 316); // ~sqrt(100k)
});

// P3 batches
bench('packOklchBufferToUint32P3IntoN (accurate)', () => {
    packOklchBufferToUint32P3IntoN(src, 0, dst, 0, N, 1, false);
});
const p3LutMed = bench('packOklchBufferToUint32P3IntoN (useLut=true)', () => {
    packOklchBufferToUint32P3IntoN(src, 0, dst, 0, N, 1, true);
});
bench('scalar loop of packOklchBufferToUint32P3', () => {
    for (let i = 0; i < N; i++) dst[i] = packOklchBufferToUint32P3(src, i * 3, 1);
});

console.log('\n  === Bake (setup-time, ratios vs open mode) ===');
const kf = new Float32Array([0.5, 0.15, 30, 0.9, 0.08, 200, 0.1, 0.05, 90]);
const B_RUNS = 40;
const bakeBench = (label, fn) => {
    for (let w = 0; w < 5; w++) fn();
    const samples = new Array(B_RUNS);
    for (let r = 0; r < B_RUNS; r++) {
        const t0 = performance.now();
        fn();
        samples[r] = performance.now() - t0;
    }
    const med = median(samples);
    console.log(`  ${label.padEnd(48)} ${med.toFixed(3).padStart(7)} ms`);
    return med;
};
const openBakeMed = bakeBench('bakeGradientToUint32(kf, 3, 1024) open', () => bakeGradientToUint32(kf, 3, 1024));
const closedBakeMed = bakeBench('bakeGradientToUint32(kf, 3, 1024) closed', () => bakeGradientToUint32(kf, 3, 1024, undefined, undefined, { closed: true }));

// -- Ratios ------------------------------------------------------------------
console.log('\n  === Ratios (this machine) ===');
console.log(`  dithered batch vs accurate LUT:    ${(dithMed / lutMed).toFixed(2)}x`);
console.log(`  P3 LUT vs sRGB LUT:                ${(p3LutMed / lutMed).toFixed(2)}x`);
console.log(`  closed bake vs open bake:          ${(closedBakeMed / openBakeMed).toFixed(2)}x`);
console.log('');
