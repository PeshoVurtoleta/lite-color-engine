// Smoke test the F1 runtime additions.
// Not a replacement for the formal vitest suite — just proves the code paths
// wire up before we invest in the full test surface.

import {
    packOklchBufferToUint32,
    packOklchBufferToUint32Dithered,
    packOklchBufferToUint32IntoN,
    packOklchBufferToUint32IntoNDithered,
    packOklchBufferToUint32P3,
    packOklchBufferToUint32P3IntoN,
    getBlueNoise64
} from '../index.js';

let failures = 0;
const check = (name, actual, expected) => {
    const ok = actual === expected;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: got ${actual}, expected ${expected}`);
    if (!ok) failures++;
};

// -- getBlueNoise64: identity + histogram + shared reference ---------------
console.log('\n[getBlueNoise64]');
const tile = getBlueNoise64();
check('tile length', tile.length, 4096);
check('same reference on second call', getBlueNoise64() === tile, true);
const hist = new Uint32Array(256);
for (let i = 0; i < 4096; i++) hist[tile[i]]++;
let uniformOk = true;
for (let b = 0; b < 256; b++) if (hist[b] !== 16) { uniformOk = false; break; }
check('histogram uniform (16x each byte)', uniformOk, true);

// -- Dithered scalar parity at noise01 = 0.5 -------------------------------
console.log('\n[packOklchBufferToUint32Dithered - noise01=0.5 parity]');
const buf = new Float32Array([0.5, 0.15, 30, 0.9, 0.08, 200, 0.1, 0.05, 90]);
let parityOk = true;
for (let i = 0; i < 3; i++) {
    const off = i * 3;
    const plain = packOklchBufferToUint32(buf, off, 1);
    const dith = packOklchBufferToUint32Dithered(buf, off, 1, 0.5);
    if (plain !== dith) {
        console.log(`    triplet ${i}: plain 0x${plain.toString(16)}, dith 0x${dith.toString(16)}`);
        parityOk = false;
    }
}
check('noise01=0.5 matches plain packer', parityOk, true);

// -- Dithered scalar: no byte overflow at extreme noise01 ------------------
console.log('\n[packOklchBufferToUint32Dithered - extreme values do not overflow]');
const white = new Float32Array([1.0, 0.0, 0]);
const packed = packOklchBufferToUint32Dithered(white, 0, 1, 255 / 256);
const r = packed & 0xff, g = (packed >>> 8) & 0xff, b = (packed >>> 16) & 0xff, a = (packed >>> 24) & 0xff;
check('R <= 255', r <= 255, true);
check('G <= 255', g <= 255, true);
check('B <= 255', b <= 255, true);
check('A === 255', a, 255);

// -- Batch non-dithered: bit-parity with scalar (regression check) ---------
console.log('\n[packOklchBufferToUint32IntoN - bit parity vs scalar loop (regression)]');
const n = 4;
const srcN = new Float32Array([
    0.5, 0.15, 30,
    0.9, 0.08, 200,
    0.1, 0.05, 90,
    0.7, 0.20, 340
]);
const dst = new Uint32Array(n);
packOklchBufferToUint32IntoN(srcN, 0, dst, 0, n, 1.0, false);
let batchParityOk = true;
for (let i = 0; i < n; i++) {
    const scalar = packOklchBufferToUint32(srcN, i * 3, 1.0);
    if (dst[i] !== scalar) {
        console.log(`    idx ${i}: batch 0x${dst[i].toString(16)}, scalar 0x${scalar.toString(16)}`);
        batchParityOk = false;
    }
}
check('batch matches scalar loop', batchParityOk, true);

// -- Batch dithered: shared noise across R/G/B (no chroma speckle) ---------
console.log('\n[packOklchBufferToUint32IntoNDithered - luminance-only dither]');
// A pure gray input should produce R=G=B in every pixel (no chroma introduced)
const grayN = 32;
const gray = new Float32Array(grayN * 3);
for (let i = 0; i < grayN; i++) {
    gray[i * 3] = 0.5;      // mid L
    gray[i * 3 + 1] = 0;    // zero chroma
    gray[i * 3 + 2] = 0;    // hue irrelevant
}
const dstD = new Uint32Array(grayN);
packOklchBufferToUint32IntoNDithered(gray, 0, dstD, 0, grayN, 1.0, tile, 0, 0, 8);
let chromaFree = true;
for (let i = 0; i < grayN; i++) {
    const px = dstD[i];
    const r = px & 0xff, g = (px >>> 8) & 0xff, b = (px >>> 16) & 0xff;
    if (r !== g || g !== b) {
        console.log(`    pixel ${i}: R=${r} G=${g} B=${b}`);
        chromaFree = false;
        break;
    }
}
check('gray input -> R=G=B every pixel', chromaFree, true);

// -- Batch dithered: bounded deviation from undithered (max +/-1) -----------
console.log('\n[packOklchBufferToUint32IntoNDithered - bounded deviation vs undithered]');
const dstUnd = new Uint32Array(grayN);
packOklchBufferToUint32IntoN(gray, 0, dstUnd, 0, grayN, 1.0, false);
let maxDev = 0;
for (let i = 0; i < grayN; i++) {
    const dr = ((dstD[i] & 0xff) - (dstUnd[i] & 0xff));
    if (Math.abs(dr) > maxDev) maxDev = Math.abs(dr);
}
check(`max R deviation <= 1 (got ${maxDev})`, maxDev <= 1, true);

// -- P3 batch parity with scalar --------------------------------------------
console.log('\n[packOklchBufferToUint32P3IntoN - bit parity vs scalar]');
const dstP3 = new Uint32Array(n);
packOklchBufferToUint32P3IntoN(srcN, 0, dstP3, 0, n, 1.0, false);
let p3ParityOk = true;
for (let i = 0; i < n; i++) {
    const scalar = packOklchBufferToUint32P3(srcN, i * 3, 1.0);
    if (dstP3[i] !== scalar) {
        console.log(`    idx ${i}: batch 0x${dstP3[i].toString(16)}, scalar 0x${scalar.toString(16)}`);
        p3ParityOk = false;
    }
}
check('P3 batch matches P3 scalar', p3ParityOk, true);

// -- P3 batch LUT path: within 1 LSB of exact --------------------------------
console.log('\n[packOklchBufferToUint32P3IntoN - useLut within 1 LSB]');
const dstP3Lut = new Uint32Array(n);
packOklchBufferToUint32P3IntoN(srcN, 0, dstP3Lut, 0, n, 1.0, true);
let maxP3LutDev = 0;
for (let i = 0; i < n; i++) {
    const exact = dstP3[i];
    const lut = dstP3Lut[i];
    for (let ch = 0; ch < 3; ch++) {
        const ex = (exact >>> (ch * 8)) & 0xff;
        const lu = (lut >>> (ch * 8)) & 0xff;
        const d = Math.abs(ex - lu);
        if (d > maxP3LutDev) maxP3LutDev = d;
    }
}
check(`P3 LUT max deviation <= 1 (got ${maxP3LutDev})`, maxP3LutDev <= 1, true);

console.log(`\n${failures === 0 ? 'ALL SMOKE CHECKS PASS' : `${failures} SMOKE CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
