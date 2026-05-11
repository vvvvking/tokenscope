#!/usr/bin/env node
/**
 * Build PNG icons (16/32/48/128) from src/icons/icon.svg.
 *
 * Run:   npm install    (installs sharp)
 *        npm run icons
 *
 * Output: src/icons/icon16.png  icon32.png  icon48.png  icon128.png
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SVG_PATH = join(ROOT, 'src', 'icons', 'icon.svg');
const OUT_DIR  = join(ROOT, 'src', 'icons');
const SIZES = [16, 32, 48, 128];

const svg = await readFile(SVG_PATH);
await mkdir(OUT_DIR, { recursive: true });

for (const s of SIZES) {
  const out = join(OUT_DIR, `icon${s}.png`);
  await sharp(svg, { density: 512 })
    .resize(s, s)
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(`[icons] ${s}x${s} -> ${out}`);
}
console.log('[icons] done.');
