#!/usr/bin/env node
// tools/preflight.mjs
//
// Stale-base preflight. Fetches the latest published tarball for this package
// via `npm pack` and hash-compares every file in the package's `files[]` list
// against the working tree. Fails hard if code drifts; warns for docs drift.
//
// Rationale: v1.3/v1.4 regressed because feature work started from an
// unrebased working tree. This script is the structural cure — a mandatory
// entry gate that guarantees you know exactly what shipped last time before
// touching anything.
//
// Classification (mirrors the "code hard-fail, docs warn" ruling):
//   CODE  (fail on any drift):  index.js, index.d.ts, src/**, package.json,
//                               anything under tools/ that is committed data
//                               (e.g. the blue-noise binary reference)
//   DOCS  (warn on drift):      README.md, CHANGELOG.md, LICENSE.md, llms.txt
//
// Exit codes:
//   0 — clean, or code-clean with docs warnings only
//   1 — code drift detected (aborts session)
//   2 — infrastructure error (network, tarball fetch, etc.)

import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const DOC_FILES = new Set([
    'README.md',
    'CHANGELOG.md',
    'LICENSE.md',
    'llms.txt'
]);

function sha256File(path) {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function walkFiles(root, base = root) {
    const out = [];
    const entries = readdirSync(root, { withFileTypes: true });
    for (const e of entries) {
        const p = join(root, e.name);
        if (e.isDirectory()) out.push(...walkFiles(p, base));
        else if (e.isFile()) out.push(relative(base, p));
    }
    return out.sort();
}

function classify(relPath) {
    return DOC_FILES.has(relPath) ? 'docs' : 'code';
}

function readPackageJson() {
    const raw = readFileSync(join(REPO_ROOT, 'package.json'), 'utf8');
    return JSON.parse(raw);
}

function fetchPublishedTarball(pkgName) {
    const dir = mkdtempSync(join(tmpdir(), 'preflight-'));
    console.log(`[preflight] fetching ${pkgName}@latest tarball into ${dir}`);
    try {
        execSync(`npm pack ${pkgName}@latest --pack-destination "${dir}"`, {
            cwd: dir,
            stdio: ['ignore', 'pipe', 'pipe']
        });
    } catch (e) {
        console.error(`[preflight] npm pack failed: ${e.message}`);
        return null;
    }
    // Locate the .tgz
    const tgzs = readdirSync(dir).filter(f => f.endsWith('.tgz'));
    if (tgzs.length !== 1) {
        console.error(`[preflight] expected 1 .tgz in ${dir}, found ${tgzs.length}`);
        return null;
    }
    // Extract in place
    execSync(`tar -xzf "${tgzs[0]}"`, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    const pkgDir = join(dir, 'package');
    if (!existsSync(pkgDir)) {
        console.error(`[preflight] extracted 'package/' missing in ${dir}`);
        return null;
    }
    return { dir, pkgDir };
}

function main() {
    const pkg = readPackageJson();
    const pkgName = pkg.name;
    console.log(`[preflight] package: ${pkgName}, HEAD version: ${pkg.version}`);

    const fetched = fetchPublishedTarball(pkgName);
    if (!fetched) {
        console.error('[preflight] could not obtain published tarball; aborting');
        process.exit(2);
    }
    const { dir: tmpDir, pkgDir } = fetched;

    // Compare every file in the published tarball against HEAD
    const pubFiles = walkFiles(pkgDir);
    const codeDrift = [];
    const docsDrift = [];
    const missingInHead = [];

    for (const relPath of pubFiles) {
        const pubHash = sha256File(join(pkgDir, relPath));
        const headPath = join(REPO_ROOT, relPath);
        if (!existsSync(headPath)) {
            missingInHead.push(relPath);
            continue;
        }
        const headHash = sha256File(headPath);
        if (pubHash !== headHash) {
            const bucket = classify(relPath);
            (bucket === 'code' ? codeDrift : docsDrift).push({ path: relPath, pubHash, headHash });
        }
    }

    // Cleanup temp dir
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

    // Report
    if (missingInHead.length > 0) {
        console.warn('\n[preflight] files present in published tarball but MISSING from HEAD:');
        for (const p of missingInHead) console.warn(`  - ${p}`);
        console.warn('  (this may indicate a `files[]` regression; treated as code drift)');
    }

    if (docsDrift.length > 0) {
        console.warn('\n[preflight] docs drift (warn-only):');
        for (const d of docsDrift) console.warn(`  - ${d.path}`);
    }

    const hardFail = codeDrift.length > 0 || missingInHead.length > 0;
    if (hardFail) {
        console.error('\n[preflight] CODE DRIFT DETECTED — session gate FAIL:');
        for (const d of codeDrift) {
            console.error(`  - ${d.path}`);
            console.error(`      published: ${d.pubHash}`);
            console.error(`      HEAD:      ${d.headHash}`);
        }
        console.error('\n  Working tree has code changes not present in the published version.');
        console.error('  Rebase / rebuild against @latest before starting feature work,');
        console.error('  or bump the version + publish first if these changes are intended.');
        process.exit(1);
    }

    console.log('\n[preflight] PASS — HEAD code is a superset of published state.');
    console.log(`  code files checked: ${pubFiles.filter(p => classify(p) === 'code').length}`);
    console.log(`  docs files checked: ${pubFiles.filter(p => classify(p) === 'docs').length}`);
    if (docsDrift.length > 0) console.log(`  docs drift (non-blocking): ${docsDrift.length} file(s)`);
    process.exit(0);
}

main();
