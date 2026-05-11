/**
 * TokenScope proxy (embedded) — server.mjs
 *
 * Transparent HTTP proxy that forwards incoming requests to a target LLM API.
 * Mirror of tokenscope-proxy/src/server.mjs.
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { detectProtocol, extractGeminiModel, parseRequest,
         parseJsonUsage, createStreamAccumulator, estimateTokens } from './parser.mjs';

// Upstream providers. Keyed by logical id (NOT only by protocol), so the user
// can pick e.g. "deepseek" as the default upstream for the `openai` protocol.
// `stripPrefix` removes a path segment from the incoming request before
// forwarding, so that e.g. OpenAI-SDK's /v1/chat/completions can reach
// Zhipu's /api/paas/v4/chat/completions without rewriting on the client side.
export const UPSTREAM_PRESETS = {
  openai:          { label: 'OpenAI',            protocol: 'openai',    url: process.env.TOKENSCOPE_UPSTREAM_OPENAI    || 'https://api.openai.com' },
  'openai-legacy': { label: 'OpenAI (legacy)',   protocol: 'openai',    url: process.env.TOKENSCOPE_UPSTREAM_OPENAI    || 'https://api.openai.com' },
  anthropic:       { label: 'Anthropic',         protocol: 'anthropic', url: process.env.TOKENSCOPE_UPSTREAM_ANTHROPIC || 'https://api.anthropic.com' },
  gemini:          { label: 'Google Gemini',     protocol: 'gemini',    url: process.env.TOKENSCOPE_UPSTREAM_GEMINI    || 'https://generativelanguage.googleapis.com' },

  // OpenAI-compatible 国产模型
  deepseek:    { label: 'DeepSeek',          protocol: 'openai', url: 'https://api.deepseek.com',                       region: 'CN' },
  moonshot:    { label: 'Moonshot Kimi',     protocol: 'openai', url: 'https://api.moonshot.cn',                        region: 'CN' },
  yi:          { label: '零一万物 Yi',        protocol: 'openai', url: 'https://api.lingyiwanwu.com',                    region: 'CN' },
  minimax:     { label: 'MiniMax',           protocol: 'openai', url: 'https://api.minimaxi.com',                       region: 'CN' },
  siliconflow: { label: '硅基流动 (聚合)',  protocol: 'openai', url: 'https://api.siliconflow.cn',                     region: 'CN' },
  qwen:        { label: '阿里通义千问',      protocol: 'openai', url: 'https://dashscope.aliyuncs.com/compatible-mode', region: 'CN' },
  zhipu:       { label: '智谱 GLM',           protocol: 'openai', url: 'https://open.bigmodel.cn/api/paas/v4',           region: 'CN', stripPrefix: '/v1' },
  doubao:      { label: '火山方舟 豆包',     protocol: 'openai', url: 'https://ark.cn-beijing.volces.com/api/v3',       region: 'CN', stripPrefix: '/v1' }
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
  delete out['accept-encoding'];
  delete out['Accept-Encoding'];
  return out;
}

function pickUpstream(req, protocol, resolveUpstream) {
  // 1) explicit per-request override
  const xu = req.headers['x-upstream'];
  if (typeof xu === 'string' && xu.startsWith('http')) {
    return { url: xu.replace(/\/$/, ''), label: 'X-Upstream override' };
  }
  // 2) user-configured default for this protocol
  if (resolveUpstream) {
    const key = resolveUpstream(protocol);
    if (key && UPSTREAM_PRESETS[key]) return UPSTREAM_PRESETS[key];
  }
  // 3) built-in default for this protocol
  return UPSTREAM_PRESETS[protocol] || UPSTREAM_PRESETS.openai;
}

export function createProxyServer({ onCall, verbose = false, resolveUpstream = null } = {}) {
  return createServer(async (req, res) => {
    const startedAt = Date.now();
    const callId = 'px_' + startedAt.toString(36) + '_' + randomUUID().slice(0, 8);
    const urlPath = req.url || '/';
    const method = req.method || 'GET';

    if (method === 'GET' && (urlPath === '/_tokenscope/ping' || urlPath === '/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok:true, service:'tokenscope-desktop', version:'0.3.0' }));
      return;
    }

    const protocol = detectProtocol(urlPath);
    const upstream = pickUpstream(req, protocol, resolveUpstream);
    const upstreamBase = upstream.url;
    // Apply optional per-provider path rewrite (e.g. strip /v1 for Zhipu/Doubao)
    let effectivePath = urlPath;
    if (upstream.stripPrefix && urlPath.startsWith(upstream.stripPrefix)) {
      effectivePath = urlPath.slice(upstream.stripPrefix.length) || '/';
    }
    const targetUrl = upstreamBase + effectivePath;

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
      console.log(`[TS-embed] ${method} ${urlPath} → ${upstreamBase}  (proto=${protocol||'passthru'}, model=${model||'?'}, stream=${reqInfo.streaming})`);
    }

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
      if (verbose) console.error('[TS-embed] upstream fetch error:', err.message);
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'proxy upstream error: ' + err.message } }));
      if (protocol && onCall) {
        onCall({ type:'call_end', callId, status:502, errText: err.message,
                 usage:null, endedAt: Date.now(), elapsedMs: Date.now() - startedAt });
      }
      return;
    }

    const respHeaders = {};
    upstreamResp.headers.forEach((v, k) => {
      if (HOP_BY_HOP.has(k.toLowerCase())) return;
      respHeaders[k] = v;
    });
    res.writeHead(upstreamResp.status, respHeaders);

    const status = upstreamResp.status;
    const ct = upstreamResp.headers.get('content-type') || '';
    const isStream = reqInfo.streaming || ct.includes('event-stream');

    if (!upstreamResp.body) {
      res.end();
      if (protocol && onCall) {
        onCall({ type:'call_end', callId, status, usage:null, endedAt: Date.now(),
                 elapsedMs: Date.now() - startedAt });
      }
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
      if (verbose) console.error('[TS-embed] body read error:', e.message);
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
  });
}
