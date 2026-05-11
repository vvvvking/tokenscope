#!/usr/bin/env node
/**
 * Package the extension into dist/tokenscope-<version>.zip
 * ready for "Load unpacked" or Chrome Web Store upload.
 *
 * Run: npm run build
 */

import { readFile, mkdir, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import AdmZip from 'adm-zip';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC  = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

const manifest = JSON.parse(await readFile(join(SRC, 'manifest.json'), 'utf8'));
const version = manifest.version;

// Ensure icons exist
for (const s of [16, 32, 48, 128]) {
  if (!existsSync(join(SRC, 'icons', `icon${s}.png`))) {
    console.error(`\n❌  Missing src/icons/icon${s}.png — run \`npm run icons\` first.\n`);
    process.exit(1);
  }
}

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

const zip = new AdmZip();
zip.addLocalFolder(SRC, '');
const outZip = join(DIST, `tokenscope-${version}.zip`);
zip.writeZip(outZip);
console.log(`[build] ${outZip}`);
console.log(`[build] size: ${(zip.toBuffer().length/1024).toFixed(1)} KB`);
