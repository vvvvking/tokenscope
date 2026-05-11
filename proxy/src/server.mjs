/**
 * TokenScope proxy — server.mjs
 *
 * Transparent HTTP proxy that forwards incoming requests to a target LLM API,
 * observes the response body (handling SSE streams), and emits call records.
 *
 * Upstream routing:
 *   - /v1/messages               → https://api.anthropic.com   (unless overridden)
 *   - /v1beta/models/...         → https://generativelanguage.googleapis.com
 *   - /v1/chat/completions, *    → https://api.openai.com      (default)
 * Override per-request:
 *   - X-Upstream: https://your-endpoint     (client-supplied)
 * Or set TOKENSCOPE_UPSTREAM_{OPENAI,ANTHROPIC,GEMINI} env vars.
 *
 * Authorization and other headers are forwarded as-is. Body is buffered for
 * model/prompt extraction but NOT altered.
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { detectProtocol, extractGeminiModel, parseRequest,
         parseJsonUsage, createStreamAccumulator, estimateTokens } from './parser.mjs';

const DEFAULT_UPSTREAM = {
  openai:     process.env.TOKENSCOPE_UPSTREAM_OPENAI    || 'https://api.openai.com',
  'openai-legacy': process.env.TOKENSCOPE_UPSTREAM_OPENAI || 'https://api.openai.com',
  anthropic:  process.env.TOKENSCOPE_UPSTREAM_ANTHROPIC || 'https://api.anthropic.com',
  gemini:     process.env.TOKENSCOPE_UPSTREAM_GEMINI    || 'https://generativelanguage.googleapis.com'
};

const HOP_BY_HOP = new Set([
  'connection','keep-alive','proxy-authenticate','proxy-authorization',
  'te','trailers','transfer-encoding','upgrade','host'
]);

function filterReqHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  // We need the upstream to return un-compressed bodies so we can parse them.
  delete out['accept-encoding'];
  delete out['Accept-Encoding'];
  return out;
}

function pickUpstream(req, protocol) {
  const xu = req.headers['x-upstream'];
  if (typeof xu === 'string' && xu.startsWith('http')) return xu.replace(/\/$/, '');
  return DEFAULT_UPSTREAM[protocol] || DEFAULT_UPSTREAM.openai;
}

export function createProxyServer({ onCall, verbose = false } = {}) {
  return createServer(async (req, res) => {
    const startedAt = Date.now();
    const callId = 'px_' + startedAt.toString(36) + '_' + randomUUID().slice(0, 8);
    const urlPath = req.url || '/';
    const method = req.method || 'GET';

    // --- health / info endpoints ---
    if (method === 'GET' && (urlPath === '/_tokenscope/ping' || urlPath === '/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok:true, service:'tokenscope-proxy', version:'0.1.0' }));
      return;
    }

    const protocol = detectProtocol(urlPath);

    // Not an LLM endpoint we know of → passthrough to default (openai), untracked
    const upstreamBase = pickUpstream(req, protocol);
    const targetUrl = upstreamBase + urlPath;

    // --- buffer request body (for protocol parsing & upstream forwarding) ---
    const chunks = [];
    let reqBytes = 0;
    for await (const chunk of req) { chunks.push(chunk); reqBytes += chunk.length; }
    const reqBody = Buffer.concat(chunks);
    const reqBodyText = (reqBody.length && (req.headers['content-type']||'').includes('json'))
                          ? reqBody.toString('utf8') : '';

    const reqInfo = protocol ? parseRequest(protocol, reqBodyText) : { model: null, inputText: '', streaming: false };
    const model = reqInfo.model || (protocol === 'gemini' ? extractGeminiModel(urlPath) : null);

    if (protocol && onCall) {
      onCall({
        type: 'call_start', callId, url: targetUrl, origin: new URL(upstreamBase).host,
        protocol, model, streaming: reqInfo.streaming,
        inputChars: (reqInfo.inputText||'').length,
        inputEstimate: estimateTokens(reqInfo.inputText),
        startedAt
      });
    }

    if (verbose) {
      console.log(`[TS-proxy] ${method} ${urlPath} → ${upstreamBase}  (proto=${protocol||'passthru'}, model=${model||'?'}, stream=${reqInfo.streaming})`);
    }

    // --- forward to upstream ---
    let upstreamResp;
    try {
      upstreamResp = await fetch(targetUrl, {
        method,
        headers: filterReqHeaders(req.headers),
        body: (method === 'GET' || method === 'HEAD') ? undefined : reqBody,
        redirect: 'manual',
        duplex: 'half'
      });
    } catch (err) {
      if (verbose) console.error('[TS-proxy] upstream fetch error:', err.message);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'proxy upstream error: ' + err.message } }));
      if (protocol && onCall) {
        onCall({ type:'call_end', callId, status:502, errText: err.message,
                 usage:null, endedAt: Date.now(), elapsedMs: Date.now() - startedAt });
      }
      return;
    }

    // --- write response headers ---
    const respHeaders = {};
    upstreamResp.headers.forEach((v, k) => {
      if (HOP_BY_HOP.has(k.toLowerCase())) return;
      respHeaders[k] = v;
    });
    res.writeHead(upstreamResp.status, respHeaders);

    const status = upstreamResp.status;
    const ct = upstreamResp.headers.get('content-type') || '';
    const isStream = reqInfo.streaming || ct.includes('event-stream');

    // --- stream body with tee-and-parse ---
    if (!upstreamResp.body) {
      res.end();
      if (protocol && onCall) finalizeNoBody();
      return;
    }

    const acc = protocol ? createStreamAccumulator(protocol) : null;
    let rawText = '';
    const decoder = new TextDecoder('utf-8', { fatal: false });

    const reader = upstreamResp.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          res.write(Buffer.from(value));
          if (acc) {
            const t = decoder.decode(value, { stream: true });
            if (isStream) acc.feed(t);
            else rawText += t;
          }
        }
      }
    } catch (e) {
      if (verbose) console.error('[TS-proxy] body read error:', e.message);
    }
    res.end();

    if (protocol && onCall) {
      let finalUsage = null, outputText = '', finalModel = model;
      if (isStream) {
        const r = acc.finish();
        finalUsage = r.usage;
        outputText = r.outputText;
        finalModel = r.model || finalModel;
      } else {
        try {
          const j = JSON.parse(rawText);
          const r = parseJsonUsage(protocol, j);
          finalUsage = r.usage;
          outputText = r.outputText;
          finalModel = r.model || finalModel;
        } catch {}
      }
      let estimated = false;
      let usage = finalUsage;
      if (!usage) {
        usage = {
          inputTokens:  estimateTokens(reqInfo.inputText),
          outputTokens: estimateTokens(outputText),
          totalTokens:  estimateTokens(reqInfo.inputText) + estimateTokens(outputText),
          cacheReadTokens: 0
        };
        estimated = true;
      }
      onCall({
        type: 'call_end',
        callId, status,
        model: finalModel,
        usage, estimated,
        inputText:  (reqInfo.inputText || '').slice(0, 4000),
        outputText: outputText.slice(0, 4000),
        outputChars: outputText.length,
        outputEstimate: estimateTokens(outputText),
        endedAt: Date.now(),
        elapsedMs: Date.now() - startedAt
      });
    }

    function finalizeNoBody() {
      onCall({ type:'call_end', callId, status, usage:null, endedAt: Date.now(),
               elapsedMs: Date.now() - startedAt });
    }
  });
}
