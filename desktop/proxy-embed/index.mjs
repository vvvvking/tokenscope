/**
 * TokenScope proxy (embedded) — main wiring.
 *
 * Identical to tokenscope-proxy/src/index.mjs, bundled inside the desktop app
 * so end-users don't need Node.js. Starts the HTTP proxy (default :17666) and
 * the control+WS server (default :17667).
 */

import { createProxyServer, UPSTREAM_PRESETS } from './server.mjs';
import { createControlServer } from './control.mjs';
import { Store } from './store.mjs';

export const VERSION = '0.3.0';
export { UPSTREAM_PRESETS } from './server.mjs';

export async function start(opts = {}) {
  const proxyPort   = opts.proxyPort   || Number(process.env.TOKENSCOPE_PROXY_PORT)   || 17666;
  const controlPort = opts.controlPort || Number(process.env.TOKENSCOPE_CONTROL_PORT) || 17667;
  const host        = opts.host || '127.0.0.1';
  const verbose     = !!opts.verbose;
  const retention   = opts.retention || 5000;
  const storeDir    = opts.storeDir; // allow Electron to override ~/.tokenscope

  // Mutable upstream routing table: { <protocol>: <upstream-preset-key> }.
  // Hot-swappable via the returned setUpstream() — no proxy restart needed.
  const upstreams = { ...(opts.upstreams || {}) };
  const resolveUpstream = (protocol) => upstreams[protocol] || null;

  const store = new Store({ retention, dir: storeDir });
  await store.init();

  const pending = new Map();
  const control = createControlServer({ store, version: VERSION, proxyPort });

  // Additional in-process listener (so Electron main can forward to renderer)
  const listeners = new Set();
  function emitRecord(kind, rec) {
    for (const fn of listeners) { try { fn(kind, rec); } catch {} }
  }

  const onCall = (ev) => {
    try {
      if (ev.type === 'call_start') {
        const day = dayKey(ev.startedAt);
        pending.set(ev.callId, {
          callId: ev.callId,
          url: ev.url, origin: ev.origin, protocol: ev.protocol, model: ev.model,
          streaming: ev.streaming,
          inputChars: ev.inputChars, inputEstimate: ev.inputEstimate,
          status: 'active',
          startedAt: ev.startedAt, day,
          source: 'proxy'
        });
        const rec = pending.get(ev.callId);
        control.broadcast({ kind:'start', rec });
        emitRecord('start', rec);
        return;
      }
      if (ev.type === 'call_end') {
        const prev = pending.get(ev.callId) || {
          callId: ev.callId,
          startedAt: (ev.endedAt||Date.now()) - (ev.elapsedMs||0),
          day: dayKey(ev.endedAt||Date.now()),
          source: 'proxy'
        };
        pending.delete(ev.callId);
        const rec = {
          ...prev,
          model:      ev.model || prev.model || null,
          status:     ev.status && ev.status >= 400 ? 'error' : 'done',
          httpStatus: ev.status || null,
          errText:    ev.errText || null,
          usage:      ev.usage || null,
          estimated:  !!ev.estimated,
          outputChars:   ev.outputChars   || 0,
          outputEstimate:ev.outputEstimate|| 0,
          inputTextPreview:  (ev.inputText  || '').slice(0, 2000),
          outputTextPreview: (ev.outputText || '').slice(0, 2000),
          endedAt:    ev.endedAt   || Date.now(),
          elapsedMs:  ev.elapsedMs || 0
        };
        store.append(rec).catch(e => verbose && console.warn('[TS-embed] store.append:', e.message));
        control.broadcast({ kind:'end', rec });
        emitRecord('end', rec);
        return;
      }
    } catch (e) {
      if (verbose) console.warn('[TS-embed] onCall error:', e.message);
    }
  };

  const proxy = createProxyServer({ onCall, verbose, resolveUpstream });

  await new Promise((res, rej) => {
    proxy.on('error', rej).listen(proxyPort, host, () => res());
  });
  await new Promise((res, rej) => {
    control.server.on('error', rej).listen(controlPort, host, () => res());
  });

  if (verbose) {
    console.log(`[TS-embed] proxy http://${host}:${proxyPort}  control http://${host}:${controlPort}  store ${store.file}`);
  }

  return {
    proxyPort, controlPort, host, store, control,
    onRecord(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    setUpstream(protocol, key) {
      if (!protocol) return;
      if (!key || key === 'default') delete upstreams[protocol];
      else upstreams[protocol] = key;
    },
    getUpstream(protocol) { return upstreams[protocol] || null; },
    getUpstreams() { return { ...upstreams }; },
    getUpstreamPresets() { return UPSTREAM_PRESETS; },
    async stop() {
      await Promise.all([
        new Promise(r => proxy.close(() => r())),
        new Promise(r => control.server.close(() => r()))
      ]);
    }
  };
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
