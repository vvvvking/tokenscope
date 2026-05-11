/**
 * TokenScope proxy — main wiring.
 *
 * Starts the HTTP proxy (default :17666) and the control+WS server
 * (default :17667), holding a shared Store instance.
 */

import { createProxyServer } from './server.mjs';
import { createControlServer } from './control.mjs';
import { Store } from './store.mjs';

export const VERSION = '0.1.0';

export async function start(opts = {}) {
  const proxyPort   = opts.proxyPort   || Number(process.env.TOKENSCOPE_PROXY_PORT)   || 17666;
  const controlPort = opts.controlPort || Number(process.env.TOKENSCOPE_CONTROL_PORT) || 17667;
  const host        = opts.host || '127.0.0.1';
  const verbose     = !!opts.verbose;
  const retention   = opts.retention || 5000;

  const store = new Store({ retention });
  await store.init();

  // In-flight call records — filled on call_start, flushed on call_end
  const pending = new Map();

  const control = createControlServer({ store, version: VERSION, proxyPort });

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
        control.broadcast({ kind:'start', rec: pending.get(ev.callId) });
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
        store.append(rec).catch(e => verbose && console.warn('[TS-proxy] store.append:', e.message));
        control.broadcast({ kind:'end', rec });
        if (verbose) {
          const u = rec.usage || {};
          console.log(`[TS-proxy] ← ${rec.httpStatus} ${rec.model||'?'}  in=${u.inputTokens||0}  out=${u.outputTokens||0}  ${rec.elapsedMs}ms${rec.estimated?' (~)':''}`);
        }
        return;
      }
    } catch (e) {
      if (verbose) console.warn('[TS-proxy] onCall error:', e.message);
    }
  };

  const proxy = createProxyServer({ onCall, verbose });

  await new Promise((res, rej) => {
    proxy.on('error', rej).listen(proxyPort, host, () => res());
  });
  await new Promise((res, rej) => {
    control.server.on('error', rej).listen(controlPort, host, () => res());
  });

  const banner = [
    '',
    '  🔍 TokenScope Proxy',
    `  └─ proxy   http://${host}:${proxyPort}`,
    `  └─ control http://${host}:${controlPort}   ws://${host}:${controlPort}/ws`,
    `  └─ store   ${store.file}`,
    '',
    '  Point your agent/SDK at the proxy URL, then keep working as usual:',
    '    Claude Code    →  export ANTHROPIC_BASE_URL=http://localhost:' + proxyPort,
    '    OpenAI SDK     →  export OPENAI_BASE_URL=http://localhost:'     + proxyPort + '/v1',
    '    Google Gemini  →  base  http://localhost:'                      + proxyPort + '/v1beta',
    ''
  ].join('\n');
  console.log(banner);

  return {
    proxyPort, controlPort, host, store, control,
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
