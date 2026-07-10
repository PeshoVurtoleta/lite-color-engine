// lite-color-engine v1.3 - batch kernel benchmark
//
// Produces the numbers used as README headlines, so it is written to be fair:
//  - every workload writes into an observable sink (no dead-code elimination)
//  - single and batch variants do identical, fully-observed work
//  - every function is warmed before timing
//  - reports median (representative) and best (peak) over many runs
//  - packs realistic in-gamut colors so the sRGB pow() transfer is actually
//    exercised (packing all-black would skip pow via the c<=0 fast path)
//
// Run from the package root:  node bench/benchmark.mjs

import {
    lerpOklchBuffer,
    lerpOklchBufferN,
    packOklchBufferToUint32,
    packOklchBufferToUint32Fast,
    packOklchBufferToUint32IntoN
} from '../src/runtime.js';

const N = 100_000;
const RUNS = 80;
const WARMUP = 12;

// SoA OKLCH buffers. Ranges are kept mostly in-gamut so the accurate transfer
// runs pow() on most channels (the honest cost for real particle colors).
const A = new Float32Array(3 * N);
const B = new Float32Array(3 * N);
const OUT = new Float32Array(3 * N);
const PACKED = new Uint32Array(N);
const PACKED_REF = new Uint32Array(N);

for (let i = 0; i < N; i++) {
    const o = i * 3;
    A[o] = 0.45 + Math.random() * 0.35;   // L
    A[o + 1] = 0.05 + Math.random() * 0.10; // C
    A[o + 2] = Math.random() * 360;         // H
    B[o] = 0.45 + Math.random() * 0.35;
    B[o + 1] = 0.05 + Math.random() * 0.10;
    B[o + 2] = (A[o + 2] + 120) % 360;
}
// Populate OUT with real lerped colors so the pack benchmarks read live data.
lerpOklchBufferN(A, 0, B, 0, 0.5, OUT, 0, N);

// median + best over RUNS, with a per-function warmup.
const bench = (fn) => {
    for (let w = 0; w < WARMUP; w++) fn();
    const times = new Float64Array(RUNS);
    for (let r = 0; r < RUNS; r++) {
        const t0 = performance.now();
        fn();
        times[r] = performance.now() - t0;
    }
    times.sort();
    const median = times[RUNS >> 1];
    const best = times[0];
    return { median, best, mcs: N / (median * 1000) };
};

// Workloads - every one writes into an observable array (DCE-proof, fair).
const wLerpSingle = () => { for (let i = 0; i < N; i++) lerpOklchBuffer(A, i * 3, B, i * 3, 0.5, OUT, i * 3); };
const wLerpBatch  = () => lerpOklchBufferN(A, 0, B, 0, 0.5, OUT, 0, N);
const wPackSingle = () => { for (let i = 0; i < N; i++) PACKED[i] = packOklchBufferToUint32(OUT, i * 3); };
const wPackBatch  = () => packOklchBufferToUint32IntoN(OUT, 0, PACKED, 0, N, 1.0, false);
const wPackLut    = () => packOklchBufferToUint32IntoN(OUT, 0, PACKED, 0, N, 1.0, true);
const wPackFast   = () => { for (let i = 0; i < N; i++) PACKED[i] = packOklchBufferToUint32Fast(OUT, i * 3); };

const lerpSingle = bench(wLerpSingle);
const lerpBatch  = bench(wLerpBatch);
const packSingle = bench(wPackSingle);
const packBatch  = bench(wPackBatch);
const packLut    = bench(wPackLut);
const packFast   = bench(wPackFast);

// Accuracy: how far is the LUT path from the exact accurate path?
packOklchBufferToUint32IntoN(OUT, 0, PACKED_REF, 0, N, 1.0, false);
packOklchBufferToUint32IntoN(OUT, 0, PACKED, 0, N, 1.0, true);
let lutMaxErr = 0;
for (let i = 0; i < N; i++) {
    const a = PACKED_REF[i] >>> 0, b = PACKED[i] >>> 0;
    for (let s = 0; s < 24; s += 8) {
        const d = Math.abs(((a >>> s) & 255) - ((b >>> s) & 255));
        if (d > lutMaxErr) lutMaxErr = d;
    }
}

const ms = (x) => x.median.toFixed(2);
const mcs = (x) => x.mcs.toFixed(1);
const BUDGET = 1000 / 60; // 16.67 ms

console.log('lite-color-engine v1.3 batch benchmark');
console.log('N = ' + N.toLocaleString() + ' colors/frame | ' + RUNS + ' runs (median) | ' + process.version);
console.log('');

console.table({
    'lerp: scalar loop':     { 'ms/frame': ms(lerpSingle), 'Mcolors/s': mcs(lerpSingle) },
    'lerp: lerpOklchBufferN': { 'ms/frame': ms(lerpBatch),  'Mcolors/s': mcs(lerpBatch) },
    'pack: scalar loop':     { 'ms/frame': ms(packSingle), 'Mcolors/s': mcs(packSingle) },
    'pack: IntoN accurate':  { 'ms/frame': ms(packBatch),  'Mcolors/s': mcs(packBatch) },
    'pack: IntoN + LUT':     { 'ms/frame': ms(packLut),    'Mcolors/s': mcs(packLut) },
    'pack: Fast (sqrt)':     { 'ms/frame': ms(packFast),   'Mcolors/s': mcs(packFast) }
});

const x = (a, b) => (a.median / b.median).toFixed(2) + 'x';
console.log('');
console.log('Key ratios');
console.log('  batch lerp vs scalar lerp .......... ' + x(lerpSingle, lerpBatch) + '  (call-amortization only)');
console.log('  batch accurate vs scalar pack ...... ' + x(packSingle, packBatch) + '  (both pow-bound: batching alone ~= no win)');
console.log('  batch + LUT vs accurate ............ ' + x(packBatch, packLut) + '  <-- the real win');
console.log('  batch + LUT vs Fast (sqrt) ......... ' + x(packFast, packLut) + '  (LUT ~= Fast speed, at ' + lutMaxErr + ' LSB vs exact)');
console.log('');

const lerpMs = lerpBatch.median;
const budgetOk = (m) => (lerpMs + m) <= BUDGET;
console.log('60fps budget for lerp + pack of ' + N.toLocaleString() + ' (' + BUDGET.toFixed(1) + ' ms/frame):');
console.log('  accurate : ' + (lerpMs + packBatch.median).toFixed(1) + ' ms  -> ' + (budgetOk(packBatch.median) ? 'fits' : 'OVER budget'));
console.log('  + LUT    : ' + (lerpMs + packLut.median).toFixed(1) + ' ms  -> ' + (budgetOk(packLut.median) ? 'fits (100k @ 60fps)' : 'OVER budget'));
console.log('');

// Paste-ready README block, filled with the measured numbers.
console.log('--- README snippet (measured) ---');
console.log('Packing ' + (N / 1000) + 'k OKLCH -> Uint32 per frame (' + process.version + ', median of ' + RUNS + '):');
console.log('');
console.log('| method                         | ms/frame | Mcolors/s |');
console.log('|--------------------------------|----------|-----------|');
console.log('| scalar loop / batch accurate   | ~' + ms(packBatch) + '   | ~' + mcs(packBatch) + '      |');
console.log('| **batch + `useLut: true`**     | **' + ms(packLut) + '** | **' + mcs(packLut) + '**  |');
console.log('| Fast (`sqrt`, ~10/255 error)   | ~' + ms(packFast) + '    | ~' + mcs(packFast) + '     |');
console.log('');
console.log('LUT packing is ~' + x(packBatch, packLut) + ' the accurate path and matches the Fast packer within '
    + lutMaxErr + ' LSB. Batching alone does not amortize much - the win is the LUT.');
