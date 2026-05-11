/**
 * TokenScope — storage.js
 *
 * IndexedDB wrapper. Three stores:
 *   - calls       : every call record, keyed by callId
 *   - daily_agg   : per-day × per-model aggregated counts (fast dashboard)
 *   - settings    : user preferences (pricing table, watched hosts, lang…)
 *
 * Also exposes pure helper functions for computing totals.
 *
 * Designed to be imported by both the service worker and the UI pages.
 */

const DB_NAME = 'tokenscope';
const DB_VERSION = 1;

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('calls')) {
        const s = db.createObjectStore('calls', { keyPath: 'callId' });
        s.createIndex('by_startedAt', 'startedAt');
        s.createIndex('by_model',     'model');
        s.createIndex('by_origin',    'origin');
        s.createIndex('by_day',       'day');
      }
      if (!db.objectStoreNames.contains('daily_agg')) {
        // key = `${day}|${model}` e.g. "2026-05-11|gpt-4o"
        const s = db.createObjectStore('daily_agg', { keyPath: 'key' });
        s.createIndex('by_day',   'day');
        s.createIndex('by_model', 'model');
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'k' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function tx(db, stores, mode='readonly') {
  const t = db.transaction(stores, mode);
  return { t, s: stores.map(n => t.objectStore(n)) };
}

function req2promise(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

// ---------- CALLS ----------

export async function putCall(db, record) {
  const {t, s:[calls]} = tx(db, ['calls'], 'readwrite');
  calls.put(record);
  return new Promise((res, rej) => { t.oncomplete=()=>res(); t.onerror=()=>rej(t.error); });
}

export async function getCall(db, callId) {
  const {s:[calls]} = tx(db, ['calls']);
  return req2promise(calls.get(callId));
}

export async function listRecentCalls(db, limit = 200) {
  const {s:[calls]} = tx(db, ['calls']);
  const idx = calls.index('by_startedAt');
  return new Promise((res, rej) => {
    const out = [];
    const cur = idx.openCursor(null, 'prev');
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c || out.length >= limit) return res(out);
      out.push(c.value);
      c.continue();
    };
    cur.onerror = () => rej(cur.error);
  });
}

export async function listCallsByDay(db, day, limit = 1000) {
  const {s:[calls]} = tx(db, ['calls']);
  const idx = calls.index('by_day');
  return new Promise((res, rej) => {
    const out = [];
    const cur = idx.openCursor(IDBKeyRange.only(day), 'prev');
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c || out.length >= limit) return res(out);
      out.push(c.value);
      c.continue();
    };
    cur.onerror = () => rej(cur.error);
  });
}

export async function clearAllCalls(db) {
  const {t, s:[calls, agg]} = tx(db, ['calls','daily_agg'], 'readwrite');
  calls.clear();
  agg.clear();
  return new Promise((res, rej) => { t.oncomplete=()=>res(); t.onerror=()=>rej(t.error); });
}

// ---------- DAILY AGGREGATION ----------

export function dayKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

export async function bumpDailyAgg(db, day, model, usage, estimated) {
  const key = `${day}|${model||'(unknown)'}`;
  const {t, s:[agg]} = tx(db, ['daily_agg'], 'readwrite');
  const cur = await req2promise(agg.get(key));
  const rec = cur || { key, day, model: model||'(unknown)', calls:0,
    inputTokens:0, outputTokens:0, totalTokens:0, cacheReadTokens:0, cacheWriteTokens:0,
    estimatedCalls: 0 };
  rec.calls += 1;
  rec.inputTokens      += (usage.inputTokens   || 0);
  rec.outputTokens     += (usage.outputTokens  || 0);
  rec.totalTokens      += (usage.totalTokens   || 0);
  rec.cacheReadTokens  += (usage.cacheReadTokens  || 0);
  rec.cacheWriteTokens += (usage.cacheWriteTokens || 0);
  if (estimated) rec.estimatedCalls += 1;
  agg.put(rec);
  return new Promise((res, rej) => { t.oncomplete=()=>res(); t.onerror=()=>rej(t.error); });
}

export async function aggByDay(db, day) {
  const {s:[agg]} = tx(db, ['daily_agg']);
  const idx = agg.index('by_day');
  return new Promise((res, rej) => {
    const out = [];
    const cur = idx.openCursor(IDBKeyRange.only(day));
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return res(out);
      out.push(c.value);
      c.continue();
    };
    cur.onerror = () => rej(cur.error);
  });
}

export async function aggRange(db, daysBack = 30) {
  const {s:[agg]} = tx(db, ['daily_agg']);
  return new Promise((res, rej) => {
    const out = [];
    const cur = agg.openCursor();
    const cutoff = dayKey(Date.now() - daysBack * 86400000);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return res(out);
      if (c.value.day >= cutoff) out.push(c.value);
      c.continue();
    };
    cur.onerror = () => rej(cur.error);
  });
}

// ---------- SETTINGS ----------

const DEFAULT_SETTINGS = {
  // When `true`, show the popup cost column using user's own pricing
  showCost: true,
  // Array<{ pattern:string, inputPer1M:number, outputPer1M:number, currency:string }>
  // Pattern supports glob: "gpt-4o*", "claude-*-sonnet-*"
  pricing: [],
  // null => watch all hosts; otherwise only listed origins emit records
  watchedHosts: null,
  // 'zh' | 'en' | 'auto'
  language: 'auto',
  // Max calls to keep in detail store (ring buffer)
  retentionCalls: 5000,
  // Connect to local tokenscope-proxy (desktop agent capture)
  proxyEnabled: false,
  proxyControlUrl: 'ws://127.0.0.1:17667/ws'
};

export async function getSettings(db) {
  const {s:[st]} = tx(db, ['settings']);
  const row = await req2promise(st.get('user'));
  if (!row) return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...(row.v || {}) };
}

export async function saveSettings(db, v) {
  const {t, s:[st]} = tx(db, ['settings'], 'readwrite');
  st.put({ k: 'user', v });
  return new Promise((res, rej) => { t.oncomplete=()=>res(); t.onerror=()=>rej(t.error); });
}

// ---------- RETENTION (trim old calls) ----------

export async function enforceRetention(db, maxCalls) {
  if (!maxCalls || maxCalls <= 0) return 0;
  const {s:[calls]} = tx(db, ['calls']);
  const count = await req2promise(calls.count());
  if (count <= maxCalls) return 0;
  const deleteN = count - maxCalls;
  const {t, s:[c2]} = tx(db, ['calls'], 'readwrite');
  const idx = c2.index('by_startedAt');
  let deleted = 0;
  return new Promise((res, rej) => {
    const cur = idx.openCursor(null, 'next');
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c || deleted >= deleteN) {
        t.oncomplete = () => res(deleted);
        return;
      }
      c.delete();
      deleted += 1;
      c.continue();
    };
    cur.onerror = () => rej(cur.error);
  });
}

// ---------- PRICING HELPERS ----------

function globToRegex(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + esc + '$', 'i');
}

export function matchPricing(pricingList, model) {
  if (!pricingList || !pricingList.length || !model) return null;
  // Prefer exact match, then longest-pattern match
  const exact = pricingList.find(p => p.pattern.toLowerCase() === model.toLowerCase());
  if (exact) return exact;
  const candidates = pricingList
    .filter(p => globToRegex(p.pattern).test(model))
    .sort((a,b) => b.pattern.length - a.pattern.length);
  return candidates[0] || null;
}

export function computeCost(pricing, usage) {
  if (!pricing || !usage) return null;
  const inUsd  = (usage.inputTokens  || 0) * (pricing.inputPer1M  || 0) / 1e6;
  const outUsd = (usage.outputTokens || 0) * (pricing.outputPer1M || 0) / 1e6;
  return {
    input: inUsd, output: outUsd, total: inUsd + outUsd,
    currency: pricing.currency || 'USD'
  };
}
