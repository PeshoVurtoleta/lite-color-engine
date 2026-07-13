// tools/generate-bluenoise.mjs
// Void-and-cluster blue-noise tile generator (Ulichney 1993).
// Deterministic, seeded, torus-wrapped, 64x64, byte output 0..255.
//
// Emits a base64 blob suitable for pasting into src/runtime.js. The blob is the
// serialized `Uint8Array(4096)` where index (y<<6)|x holds a rank in [0..4095],
// then mapped byte = (rank * 256 / 4096) | 0 = rank >> 4 (since 4096 = 256*16).
// Actually we emit the byte-mapped tile directly so consumers just index and use.
//
// Script version: 1.0.0
// Author: Zahary Shinikchiev
// License: MIT (matches package)

const N = 64;
const SIZE = N * N;               // 4096
const SIGMA = 1.5;
const SIGMA2 = SIGMA * SIGMA;
const INITIAL_ONES = 410;         // ~10% of 4096, per Ulichney recommendation
const SEED = 0xC0FFEE1E;          // committed deterministic seed

// --- xorshift32 PRNG (allocation-free, reproducible) ------------------------
let rngState = SEED >>> 0;
function rand01() {
    let x = rngState | 0;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;  x >>>= 0;
    rngState = x >>> 0;
    return (rngState & 0x7fffffff) / 0x80000000;
}

// --- Precompute Gaussian energy kernel (toroidal, radius 6 covers 4-sigma) --
const KERNEL_R = 6;
const KERNEL_D = KERNEL_R * 2 + 1;
const kernel = new Float64Array(KERNEL_D * KERNEL_D);
{
    for (let dy = -KERNEL_R; dy <= KERNEL_R; dy++) {
        for (let dx = -KERNEL_R; dx <= KERNEL_R; dx++) {
            const d2 = dx * dx + dy * dy;
            kernel[(dy + KERNEL_R) * KERNEL_D + (dx + KERNEL_R)] =
                Math.exp(-d2 / (2 * SIGMA2));
        }
    }
    kernel[KERNEL_R * KERNEL_D + KERNEL_R] = 0; // exclude self (Ulichney)
}

// --- Energy field: sum of kernel contributions from every '1' cell ----------
// Field is maintained incrementally: adding/removing a '1' updates a KERNEL_D^2
// window around it. Toroidal wrap on all edges.
function addContribution(field, x, y, sign) {
    for (let ky = 0; ky < KERNEL_D; ky++) {
        const fy = (y + ky - KERNEL_R + N) % N;
        const rowF = fy * N;
        const rowK = ky * KERNEL_D;
        for (let kx = 0; kx < KERNEL_D; kx++) {
            const fx = (x + kx - KERNEL_R + N) % N;
            field[rowF + fx] += sign * kernel[rowK + kx];
        }
    }
}

function rebuildField(bp) {
    const field = new Float64Array(SIZE);
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            if (bp[y * N + x]) addContribution(field, x, y, +1);
        }
    }
    return field;
}

// --- Tightest cluster = highest-energy cell that is a '1' -------------------
function findTightestCluster(bp, field) {
    let best = -Infinity, bestIdx = -1;
    for (let i = 0; i < SIZE; i++) {
        if (bp[i] && field[i] > best) { best = field[i]; bestIdx = i; }
    }
    return bestIdx;
}

// --- Largest void = lowest-energy cell that is a '0' ------------------------
function findLargestVoid(bp, field) {
    let best = Infinity, bestIdx = -1;
    for (let i = 0; i < SIZE; i++) {
        if (!bp[i] && field[i] < best) { best = field[i]; bestIdx = i; }
    }
    return bestIdx;
}

// --- Step 1: initial binary pattern via seeded random placement -------------
function initialPattern() {
    const bp = new Uint8Array(SIZE);
    let placed = 0;
    while (placed < INITIAL_ONES) {
        const i = (rand01() * SIZE) | 0;
        if (!bp[i]) { bp[i] = 1; placed++; }
    }
    return bp;
}

// --- Step 2: iterate swap-tightest-for-largest-void until stable ------------
function relaxPattern(bp) {
    const field = rebuildField(bp);
    for (let iter = 0; iter < 10000; iter++) {
        const tight = findTightestCluster(bp, field);
        // temporarily remove it, find largest void, swap if different
        bp[tight] = 0;
        addContribution(field, tight % N, (tight / N) | 0, -1);
        const void_ = findLargestVoid(bp, field);
        if (void_ === tight) {
            // stable: put it back
            bp[tight] = 1;
            addContribution(field, tight % N, (tight / N) | 0, +1);
            return { bp, field, iters: iter };
        }
        bp[void_] = 1;
        addContribution(field, void_ % N, (void_ / N) | 0, +1);
    }
    throw new Error('relaxPattern did not converge');
}

// --- Step 3a: rank the initial pattern (Phase 1 of Ulichney) ---------------
// Assign ranks INITIAL_ONES-1 down to 0 by iteratively finding tightest cluster,
// setting its rank, and removing it.
function rankInitialOnes(bp, field, ranks) {
    // Copy bp so we can consume it
    const work = new Uint8Array(bp);
    const workField = new Float64Array(field);
    for (let r = INITIAL_ONES - 1; r >= 0; r--) {
        const t = findTightestCluster(work, workField);
        ranks[t] = r;
        work[t] = 0;
        addContribution(workField, t % N, (t / N) | 0, -1);
    }
}

// --- Step 3b: rank the remaining zeros (Phase 2 + 3 of Ulichney) -----------
// Now insert ones one at a time into largest voids, ranking each from INITIAL_ONES
// up to SIZE/2 (Phase 2), then flip semantics and continue placing zeros into
// tightest clusters, ranking from SIZE/2 up to SIZE-1 (Phase 3).
function rankRemaining(bp, field, ranks) {
    // Phase 2: from initial pattern, add ones into voids, rank INITIAL_ONES..SIZE/2-1
    const work = new Uint8Array(bp);
    const workField = new Float64Array(field);
    const HALF = SIZE >> 1;
    for (let r = INITIAL_ONES; r < HALF; r++) {
        const v = findLargestVoid(work, workField);
        ranks[v] = r;
        work[v] = 1;
        addContribution(workField, v % N, (v / N) | 0, +1);
    }
    // Phase 3: past 50% the ZEROS are the minority phase. We keep converting
    // zeros to ones; the cells that stay zero longest get the highest ranks, and
    // those are exactly the minority pixels of every threshold pattern above 128.
    // For those to be homogeneous, each step must eat the zero that is most
    // CLUSTERED WITH OTHER ZEROS -- i.e. the tightest cluster of the complement.
    //
    // A cell "most surrounded by 1s" is the opposite of that: it is an ISOLATED
    // zero, the largest void of the complement. Selecting it leaves the zero
    // clumps intact until last, which clusters the top half of the tonal range.
    // (v1.5.0-rc took the maximum here; it cost ~7x clumpiness above T=128.)
    //
    // Because the filter is toroidal and constant-sum, filtering the complement
    // is not needed: sum(K) is the same at every cell, so
    //     zerosField = sum(K) - onesField
    // and therefore  argmax(zerosField) === argmin(onesField). "Tightest cluster
    // of zeros" is exactly findLargestVoid() on the ones-field -- Phase 3 uses
    // the same selector as Phase 2, and the two loops fuse.
    for (let r = HALF; r < SIZE; r++) {
        const v = findLargestVoid(work, workField);
        ranks[v] = r;
        work[v] = 1;
        addContribution(workField, v % N, (v / N) | 0, +1);
    }
}

// --- Assemble the full ranking ---------------------------------------------
function generate() {
    const bp = initialPattern();
    const { bp: relaxedBp, field: relaxedField, iters } = relaxPattern(bp);
    const ranks = new Uint32Array(SIZE);
    rankInitialOnes(relaxedBp, relaxedField, ranks);
    rankRemaining(relaxedBp, relaxedField, ranks);

    // Map rank in [0..SIZE-1] to byte in [0..255].
    // With SIZE=4096, byte = rank >> 4 gives each byte exactly 16 times.
    const tile = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i++) tile[i] = ranks[i] >> 4;

    return { tile, ranks, relaxIters: iters };
}

// --- Verify histogram is exactly uniform (16 of each byte 0..255) ----------
function verifyHistogram(tile) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < SIZE; i++) hist[tile[i]]++;
    for (let b = 0; b < 256; b++) {
        if (hist[b] !== 16) {
            throw new Error(`histogram FAIL: byte ${b} appears ${hist[b]} times, expected 16`);
        }
    }
    return true;
}

// --- Verify blue-noise spectral property ACROSS THE WHOLE TONAL RANGE -------
// A dither array is only blue if the MINORITY phase of *every* threshold
// pattern is homogeneous. Measuring one threshold is not enough: the previous
// version of this file sampled T=128 only, which is precisely the threshold an
// inverted Phase 3 cannot affect (Phase 3 only permutes ranks >= HALF, so the
// T=128 binarization is bit-identical either way). It reported a healthy
// 0.5133 for a tile that was 7x over-clustered in the highlights.
//
// clumpiness(T) = stddev of the Gaussian-filtered minority-phase field.
// Low = homogeneous = blue. It must also be SYMMETRIC about 128, because at
// T and 256-T the minority phase simply swaps roles.
function clumpiness(tile, T) {
    const bp = new Uint8Array(SIZE);
    let ones = 0;
    for (let i = 0; i < SIZE; i++) { bp[i] = tile[i] < T ? 1 : 0; ones += bp[i]; }
    const minority = ones > (SIZE >> 1) ? 0 : 1;
    const field = new Float64Array(SIZE);
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            if (bp[y * N + x] === minority) addContribution(field, x, y, +1);
        }
    }
    let mean = 0;
    for (let i = 0; i < SIZE; i++) mean += field[i];
    mean /= SIZE;
    let variance = 0;
    for (let i = 0; i < SIZE; i++) { const d = field[i] - mean; variance += d * d; }
    return Math.sqrt(variance / SIZE);
}

const SWEEP_T = [16, 32, 64, 96, 128, 160, 192, 224, 240];
const CLUMP_MAX = 0.70;      // white noise sits near 2.5-3.0; a good tile stays under 0.6
const SYMMETRY_TOL = 0.08;   // |clump(T) - clump(256-T)| for a correct array is ~0

function verifySpectralQuality(tile) {
    const curve = SWEEP_T.map((T) => ({ T, c: clumpiness(tile, T) }));
    for (const { T, c } of curve) {
        if (!(c < CLUMP_MAX)) {
            throw new Error(
                `spectral FAIL: clumpiness at T=${T} is ${c.toFixed(3)}, ceiling ${CLUMP_MAX}. ` +
                `The minority phase is clustered -- this is not blue noise.`
            );
        }
    }
    for (const T of [16, 32, 64, 96]) {
        const lo = clumpiness(tile, T);
        const hi = clumpiness(tile, 256 - T);
        if (Math.abs(lo - hi) > SYMMETRY_TOL) {
            throw new Error(
                `symmetry FAIL: clumpiness(${T})=${lo.toFixed(3)} vs clumpiness(${256 - T})=${hi.toFixed(3)}, ` +
                `delta ${Math.abs(lo - hi).toFixed(3)} > ${SYMMETRY_TOL}. One half of the tonal range is worse ` +
                `than the other -- suspect the Phase 2/3 selectors.`
            );
        }
    }
    return curve;
}

// --- SHA-256 (for provenance fingerprint) ----------------------------------
async function sha256Hex(bytes) {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(bytes).digest('hex');
}

// --- Main -------------------------------------------------------------------
console.log(`[bluenoise] generating 64x64 void-and-cluster tile, seed=0x${SEED.toString(16)}`);
const t0 = performance.now();
const { tile, relaxIters } = generate();
const t1 = performance.now();
console.log(`[bluenoise] generated in ${(t1 - t0).toFixed(1)} ms (relax iters: ${relaxIters})`);

verifyHistogram(tile);
console.log('[bluenoise] histogram check PASS (each of 0..255 appears exactly 16 times)');

const curve = verifySpectralQuality(tile);
console.log('[bluenoise] clumpiness sweep PASS (lower = bluer, must be symmetric about 128)');
console.log('[bluenoise]   T     : ' + curve.map((p) => String(p.T).padStart(5)).join(''));
console.log('[bluenoise]   clump : ' + curve.map((p) => p.c.toFixed(2).padStart(5)).join(''));

const hash = await sha256Hex(tile);
console.log(`[bluenoise] tile SHA-256: ${hash}`);

// Emit base64
const base64 = Buffer.from(tile).toString('base64');
console.log(`[bluenoise] base64 length: ${base64.length} chars`);
console.log('[bluenoise] base64 blob:');
console.log(base64);

// Also write the raw bytes to a sibling file for downstream tests/reference
const { writeFileSync } = await import('node:fs');
writeFileSync(new URL('./bluenoise-64x64.bin', import.meta.url), tile);
writeFileSync(new URL('./bluenoise-64x64.txt', import.meta.url),
    `# Blue-noise tile, 64x64, void-and-cluster
# Generator: tools/generate-bluenoise.mjs v1.1.0
# Seed: 0x${SEED.toString(16)}
# SHA-256: ${hash}
# Base64:
${base64}
`);
console.log('[bluenoise] wrote tools/bluenoise-64x64.bin and .txt');
