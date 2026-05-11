/**
 * TokenScope — proxy_client.js
 *
 * Maintains a WebSocket connection from the browser extension's service
 * worker to the local tokenscope-proxy (ws://127.0.0.1:17667/ws by default).
 *
 * Events arriving from the proxy are converted into the same shape as
 * on-page hook events so the existing persistence path can reuse them.
 * The only distinguishing field is `source:'proxy'`, which is carried
 * through to the stored record.
 *
 * Resilience:
 *   - Auto-reconnect with exponential backoff (max 30s)
 *   - App-level ping every 20s to keep the MV3 service worker awake while
 *     the user is actively using a desktop agent
 */

export class ProxyClient {
  constructor({ url, onEvent, onStatus }) {
    this.url = url;
    this.onEvent = onEvent;   // (payload) => void
    this.onStatus = onStatus; // (status:'connecting'|'open'|'closed'|'error', info?) => void
    this.ws = null;
    this.retryMs = 1000;
    this.stopped = false;
    this.pingTimer = null;
    this.reconnectTimer = null;
    this.lastConnectedAt = 0;
    this.serverInfo = null;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    this._clearTimers();
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this._setStatus('closed');
  }

  _setStatus(s, info) {
    try { this.onStatus && this.onStatus(s, info); } catch {}
  }

  _clearTimers() {
    if (this.pingTimer)      { clearInterval(this.pingTimer);    this.pingTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  _scheduleReconnect() {
    if (this.stopped) return;
    const delay = Math.min(30_000, this.retryMs);
    this.retryMs = Math.min(30_000, this.retryMs * 2);
    this.reconnectTimer = setTimeout(() => this._connect(), delay);
  }

  _connect() {
    if (this.stopped) return;
    this._setStatus('connecting', { url: this.url });
    let ws;
    try { ws = new WebSocket(this.url); }
    catch (e) {
      this._setStatus('error', { error: String(e.message || e) });
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.retryMs = 1000;
      this.lastConnectedAt = Date.now();
      this._setStatus('open', { url: this.url });
      // App-level keepalive
      this.pingTimer = setInterval(() => {
        if (ws.readyState === 1) { try { ws.send('ping'); } catch {} }
      }, 20_000);
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'hello') {
        this.serverInfo = { version: msg.version, proxyPort: msg.proxyPort };
        this._setStatus('open', { url: this.url, ...this.serverInfo });
        return;
      }
      if (msg.type === 'event' && msg.payload) {
        // Convert proxy broadcast shape {kind, rec} -> hook-event shape
        this._forward(msg.payload);
      }
    });

    ws.addEventListener('close', () => {
      this._clearTimers();
      this.ws = null;
      this._setStatus('closed');
      this._scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      this._setStatus('error');
      // close handler will schedule reconnect
    });
  }

  _forward({ kind, rec }) {
    if (!rec) return;
    if (kind === 'start') {
      this.onEvent && this.onEvent({
        type: 'call_start',
        callId: rec.callId,
        url:    rec.url,
        origin: rec.origin || 'proxy',
        protocol: rec.protocol,
        model:   rec.model,
        streaming: !!rec.streaming,
        inputChars:    rec.inputChars    || 0,
        inputEstimate: rec.inputEstimate || 0,
        startedAt: rec.startedAt,
        source: 'proxy'
      });
    } else if (kind === 'end') {
      this.onEvent && this.onEvent({
        type: 'call_end',
        callId: rec.callId,
        status: rec.httpStatus || (rec.status === 'error' ? 500 : 200),
        model:  rec.model,
        usage:  rec.usage,
        estimated: !!rec.estimated,
        inputText:  rec.inputTextPreview  || '',
        outputText: rec.outputTextPreview || '',
        outputChars: rec.outputChars || 0,
        outputEstimate: rec.outputEstimate || 0,
        errText: rec.errText || null,
        endedAt: rec.endedAt || Date.now(),
        elapsedMs: rec.elapsedMs || 0,
        source: 'proxy',
        origin: rec.origin || 'proxy',
        protocol: rec.protocol,
        startedAt: rec.startedAt
      });
    }
  }
}

export async function probeProxy(ctrlHttpUrl) {
  try {
    const r = await fetch(ctrlHttpUrl + '/info', { method: 'GET' });
    if (!r.ok) return { ok: false, status: r.status };
    const j = await r.json();
    return { ok: true, info: j };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

export function wsToHttp(wsUrl) {
  return wsUrl.replace(/^wss:/,'https:').replace(/^ws:/,'http:').replace(/\/ws$/,'');
}
