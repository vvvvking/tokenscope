/**
 * TokenScope proxy — control.mjs
 *
 * Tiny HTTP + WebSocket server on a separate port, used by the browser
 * extension to:
 *   - Subscribe to live call events (WebSocket at /ws)
 *   - Query historical records  (GET  /records?limit=N)
 *   - Clear records             (POST /clear)
 *   - Health check              (GET  /info)
 *
 * Listens on 127.0.0.1 only by default. No auth, no TLS — this is strictly
 * a loopback integration channel.
 */

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

export function createControlServer({ store, version = '0.1.0', proxyPort, origin }) {
  const subscribers = new Set();

  const http = createServer(async (req, res) => {
    // Permissive CORS so the browser extension can query from any origin
    const cors = {
      'access-control-allow-origin':  '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type'
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const u = new URL(req.url, 'http://127.0.0.1');

    try {
      if (u.pathname === '/info' && req.method === 'GET') {
        const stats = await store.stats();
        res.writeHead(200, { 'content-type':'application/json', ...cors });
        res.end(JSON.stringify({ ok:true, service:'tokenscope-proxy', version, proxyPort,
                                 records: stats }));
        return;
      }

      if (u.pathname === '/records' && req.method === 'GET') {
        const limit = Math.max(1, Math.min(5000, Number(u.searchParams.get('limit') || 500)));
        const rows = await store.list(limit);
        res.writeHead(200, { 'content-type':'application/json', ...cors });
        res.end(JSON.stringify({ ok:true, rows }));
        return;
      }

      if (u.pathname === '/clear' && req.method === 'POST') {
        await store.clear();
        res.writeHead(200, { 'content-type':'application/json', ...cors });
        res.end(JSON.stringify({ ok:true }));
        return;
      }

      res.writeHead(404, { 'content-type':'application/json', ...cors });
      res.end(JSON.stringify({ ok:false, error:'not found' }));
    } catch (e) {
      res.writeHead(500, { 'content-type':'application/json', ...cors });
      res.end(JSON.stringify({ ok:false, error:String(e.message||e) }));
    }
  });

  const wss = new WebSocketServer({ server: http, path: '/ws' });
  wss.on('connection', (ws) => {
    subscribers.add(ws);
    try { ws.send(JSON.stringify({ type:'hello', version, proxyPort })); } catch {}
    ws.on('close', () => subscribers.delete(ws));
    ws.on('error', () => subscribers.delete(ws));
  });

  return {
    server: http,
    broadcast(ev) {
      const msg = JSON.stringify({ type:'event', payload: ev });
      for (const ws of subscribers) {
        if (ws.readyState === 1) { try { ws.send(msg); } catch {} }
      }
    },
    subscriberCount() { return subscribers.size; }
  };
}
