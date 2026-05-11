/**
 * TokenScope proxy (embedded) — store.mjs
 *
 * NDJSON ring buffer on disk.
 * File: ~/.tokenscope/records.ndjson (or an Electron-supplied userData dir).
 */

import { readFile, writeFile, appendFile, mkdir, stat, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export class Store {
  constructor(opts = {}) {
    this.dir  = opts.dir  || join(homedir(), '.tokenscope');
    this.file = opts.file || join(this.dir, 'records.ndjson');
    this.retention = opts.retention || 5000;
    this._initialized = false;
    this._compacting = false;
    this._writesSinceCompact = 0;
  }

  async init() {
    if (this._initialized) return;
    await mkdir(this.dir, { recursive: true });
    if (!existsSync(this.file)) await writeFile(this.file, '');
    this._initialized = true;
  }

  async append(record) {
    await this.init();
    const line = JSON.stringify(record) + '\n';
    await appendFile(this.file, line, 'utf8');
    this._writesSinceCompact++;
    if (this._writesSinceCompact >= 200) {
      this._writesSinceCompact = 0;
      this.compact().catch(e => console.warn('[TS-embed] compact failed:', e.message));
    }
  }

  async list(limit = 500) {
    await this.init();
    const buf = await readFile(this.file, 'utf8');
    const lines = buf.split('\n').filter(Boolean);
    const start = Math.max(0, lines.length - limit);
    const out = [];
    for (let i = lines.length - 1; i >= start; i--) {
      try { out.push(JSON.parse(lines[i])); } catch {}
    }
    return out;
  }

  async all() {
    await this.init();
    const buf = await readFile(this.file, 'utf8');
    const lines = buf.split('\n').filter(Boolean);
    const out = [];
    for (const l of lines) { try { out.push(JSON.parse(l)); } catch {} }
    return out;
  }

  async clear() {
    await this.init();
    await writeFile(this.file, '');
  }

  async compact() {
    if (this._compacting) return;
    this._compacting = true;
    try {
      await this.init();
      const rows = await this.all();
      if (rows.length <= this.retention) return;
      const keep = rows.slice(-this.retention);
      const tmp = this.file + '.tmp';
      await writeFile(tmp, keep.map(r => JSON.stringify(r)).join('\n') + '\n');
      await rename(tmp, this.file);
    } finally {
      this._compacting = false;
    }
  }

  async stats() {
    try {
      const s = await stat(this.file);
      return { file: this.file, size: s.size, mtime: s.mtime };
    } catch {
      return { file: this.file, size: 0, mtime: null };
    }
  }
}
