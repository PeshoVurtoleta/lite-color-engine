// Smoke test the F1 lut.js cyclic + Gamut.js batch additions.

import { bakeGradientToUint32, sampleColorLUT } from '../index.js';
import { gamutMapToSrgbBuffer, gamutMapToSrgbBufferN, packOklchBufferToUint32MINDE } from '../src/Gamut.js';

let failures = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: got ${actual}, expected ${expected}`);
    if (!ok) failures++;
};

const abs = Math.abs;

// -- Open-mode LUT: unchanged from v1.4 (regression check) ------------------
console.log('\n[bakeGradientToUint32 - open mode regression]');
const keyframes = new Float32Array([
    0.5, 0.15, 30,
    0.9, 0.08, 200,
    0.1, 0.05, 90
]);
const openLut = bakeGradientToUint32(keyframes, 3, 8);
// Sample 0 must land exactly on stop 0
const stop0 = openLut[0];
const stop0Expected = (function () {
    // Build the expected value directly via lerp(0) on stops[0]->stops[1] + accurate packer.
    // Since bakeGradientToUint32 uses packOklchBufferToUint32 by default, sample 0 is
    // packer(stops[0]) with local t=0.
    // We can't easily reconstruct that without importing runtime.js; instead we
    // just check that sample 0 in this open LUT matches a single-stop bake result.
    const single = new Float32Array([0.5, 0.15, 30, 0.5, 0.15, 30]);
    const lut2 = bakeGradientToUint32(single, 2, 2);
    return lut2[0];
})();
check('open LUT sample 0 == stop 0 pack', stop0, stop0Expected);
check('open LUT length', openLut.length, 8);
// Sample 7 (last) should land on stop 2 (t = 1)
const stop2 = openLut[7];
const stop2Expected = (function () {
    const single = new Float32Array([0.1, 0.05, 90, 0.1, 0.05, 90]);
    return bakeGradientToUint32(single, 2, 2)[0];
})();
check('open LUT last sample == last stop', stop2, stop2Expected);

// -- Cyclic LUT: no duplicate endpoint, period spacing ---------------------
console.log('\n[bakeGradientToUint32 - closed period spacing]');
const closedLut = bakeGradientToUint32(keyframes, 3, 8, undefined, undefined, { closed: true });
check('closed LUT length', closedLut.length, 8);
// Sample 0 lands on stop 0 (t = 0)
check('closed LUT sample 0 == stop 0', closedLut[0], stop0Expected);
// Sample resolution-1 (index 7) is at t = 7/8, which is inside the wrap segment
// (segment N-1 spans t in [2/3, 3/3) = [0.667, 1.0)); 7/8 = 0.875 is inside it.
// The value should NOT equal stop 0 (that's what open mode gives at t=1).
const openLutSameSize = bakeGradientToUint32(keyframes, 3, 8);
check('closed LUT last != open LUT last (different mapping)',
    closedLut[7] !== openLutSameSize[7], true);

// -- Cyclic LUT: seam continuity ratio ---------------------
console.log('\n[bakeGradientToUint32 - cyclic seam <= interior]');
// Bake at high res. Measure max |Δbyte| between adjacent LUT entries wrapping through 0.
// Seam (index res-1 -> 0) should be within the same magnitude as the max interior delta.
const RES = 512;
const cyclicHigh = bakeGradientToUint32(keyframes, 3, RES, undefined, undefined, { closed: true });
const byteDelta = (pxA, pxB) => {
    let d = 0;
    for (let ch = 0; ch < 3; ch++) {
        const a = (pxA >>> (ch * 8)) & 0xff;
        const b = (pxB >>> (ch * 8)) & 0xff;
        const ad = abs(a - b);
        if (ad > d) d = ad;
    }
    return d;
};
let maxInterior = 0;
for (let i = 1; i < RES; i++) {
    const d = byteDelta(cyclicHigh[i - 1], cyclicHigh[i]);
    if (d > maxInterior) maxInterior = d;
}
const seamDelta = byteDelta(cyclicHigh[RES - 1], cyclicHigh[0]);
console.log(`  seam=${seamDelta}, maxInterior=${maxInterior}, ratio=${(seamDelta / Math.max(maxInterior, 1)).toFixed(3)}`);
// Roadmap gate: |lut[res-1] - lut[0]| per channel <= max adjacent interior delta.
check('cyclic seam <= max interior delta', seamDelta <= maxInterior, true);

// -- Cyclic LUT with 2 stops: two-color oscillation --------
console.log('\n[bakeGradientToUint32 - 2-stop closed]');
const twoStop = new Float32Array([0.5, 0.15, 30, 0.5, 0.15, 210]); // opposite hues
const twoStopLut = bakeGradientToUint32(twoStop, 2, 4, undefined, undefined, { closed: true });
// With N=2 stops and R=4 samples, sample positions are 0, 0.25, 0.5, 0.75.
// scaledT = t * 2, so index sequence: 0, 0, 1, 1.
// Segments: [0]->[1] for indices 0,1 and [1]->[0] for the wrap.
// Sample 0 lands on stop 0 exactly.
check('2-stop closed sample 0 == stop 0', twoStopLut[0],
    bakeGradientToUint32(new Float32Array([0.5, 0.15, 30, 0.5, 0.15, 30]), 2, 2)[0]);

// -- Ease function overshoot wraps rather than clamps in closed mode -------
console.log('\n[bakeGradientToUint32 - ease overshoot wraps in closed]');
// An ease that returns 1.25 (overshoot). In open mode this clamps to 1 (last stop).
// In closed mode it wraps to 0.25 (quarter through).
const overshoot = (t) => 1.25;  // constant overshoot
const openOvershoot = bakeGradientToUint32(keyframes, 3, 4, overshoot);
const closedOvershoot = bakeGradientToUint32(keyframes, 3, 4, overshoot, undefined, { closed: true });
// Open should have all samples equal (clamped to t=1 -> stop 2)
const allSameOpen = openOvershoot[0] === openOvershoot[1] &&
                    openOvershoot[1] === openOvershoot[2] &&
                    openOvershoot[2] === openOvershoot[3];
check('open ease overshoot -> all clamped to stop 2', allSameOpen, true);
// Closed should have all samples equal too (t = 1.25 - 1 = 0.25 everywhere)
const allSameClosed = closedOvershoot[0] === closedOvershoot[1] &&
                      closedOvershoot[1] === closedOvershoot[2] &&
                      closedOvershoot[2] === closedOvershoot[3];
check('closed ease overshoot -> all wrapped to t=0.25', allSameClosed, true);
// But open != closed (different mapping)
check('open overshoot != closed overshoot', openOvershoot[0] !== closedOvershoot[0], true);

// -- Gamut batch: bit parity with scalar loop ------------------------------
console.log('\n[gamutMapToSrgbBufferN - bit parity with scalar]');
// Out-of-sRGB OKLCH inputs (high chroma in P3-only region)
const inBuf = new Float32Array([
    0.7, 0.35, 30,   // out-of-gamut red
    0.5, 0.30, 150,  // out-of-gamut green
    0.6, 0.25, 250,  // out-of-gamut blue-purple
    0.5, 0.05, 30,   // in-gamut (low chroma)
    0.5, 0, 0,       // achromatic (fast path)
]);
const n = 5;
const outScalar = new Float32Array(n * 3);
const outBatch = new Float32Array(n * 3);
for (let i = 0; i < n; i++) {
    gamutMapToSrgbBuffer(inBuf, i * 3, outScalar, i * 3);
}
gamutMapToSrgbBufferN(inBuf, 0, outBatch, 0, n);
let batchOk = true;
for (let i = 0; i < n * 3; i++) {
    if (outScalar[i] !== outBatch[i]) {
        console.log(`    idx ${i}: scalar ${outScalar[i]}, batch ${outBatch[i]}`);
        batchOk = false;
    }
}
check('gamut batch matches scalar loop bit-for-bit', batchOk, true);

// -- MINDE bake via bakeGradientToUint32 packer arg -----------------------
console.log('\n[bakeGradientToUint32 + MINDE packer]');
const oog = new Float32Array([0.7, 0.35, 30, 0.5, 0.30, 150]); // out-of-gamut endpoints
const mindeLut = bakeGradientToUint32(oog, 2, 8, undefined, packOklchBufferToUint32MINDE);
// All entries must have valid alpha byte (255) and be non-zero (mapped, not black)
let mindeOk = true;
for (let i = 0; i < 8; i++) {
    const px = mindeLut[i];
    const a = (px >>> 24) & 0xff;
    if (a !== 255) { console.log(`    idx ${i}: alpha ${a}`); mindeOk = false; }
}
check('MINDE-baked LUT alpha all 255', mindeOk, true);

// -- MINDE + closed: no crash, seam continuity ------------------------------
console.log('\n[bakeGradientToUint32 - MINDE + closed]');
const mindeClosedLut = bakeGradientToUint32(oog, 2, 64, undefined, packOklchBufferToUint32MINDE, { closed: true });
const mindeSeam = byteDelta(mindeClosedLut[63], mindeClosedLut[0]);
let mindeMaxInterior = 0;
for (let i = 1; i < 64; i++) {
    const d = byteDelta(mindeClosedLut[i - 1], mindeClosedLut[i]);
    if (d > mindeMaxInterior) mindeMaxInterior = d;
}
console.log(`  MINDE seam=${mindeSeam}, maxInterior=${mindeMaxInterior}`);
check('MINDE closed seam <= max interior delta', mindeSeam <= mindeMaxInterior, true);

console.log(`\n${failures === 0 ? 'ALL SMOKE CHECKS PASS' : `${failures} SMOKE CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
