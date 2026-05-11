/**
 * TokenScope — inject_hook.js (PAGE WORLD)
 *
 * This script is injected into the page's MAIN world so it can monkey-patch
 * `window.fetch` and `XMLHttpRequest` — things content scripts in ISOLATED
 * world cannot touch. It observes LLM API calls, extracts token usage from
 * the response (including SSE streams), then relays a summary record to the
 * ISOLATED content script via window.postMessage.
 *
 * IMPORTANT: this runs with the page's privileges. We never read or forward
 * Authorization headers or API keys. Only request metadata (URL, model,
 * streaming flag, timing) and response usage counts are reported.
 */

(function () {
  if (window.__TOKENSCOPE_HOOK_INSTALLED__) return;
  window.__TOKENSCOPE_HOOK_INSTALLED__ = true;

  const CHANNEL = 'tokenscope:event';
  const HOOK_VERSION = '0.1.0';

  // ---- URL match ----
  const URL_REGEX = [
    /\/v1\/chat\/completions(\?|$)/i,
    /\/chat\/completions(\?|$)/i,
    /\/v1\/completions(\?|$)/i,
    /\/v1\/messages(\?|$)/i,
    /\/v1beta\/models\/[^/]+:(generate|streamGenerate)Content/i
  ];
  function urlMatches(url) {
    for (const re of URL_REGEX) if (re.test(url)) return true;
    return false;
  }
  function detectProtocol(url) {
    if (/\/v1\/messages(\?|$)/i.test(url)) return 'anthropic';
    if (/\/v1beta\/models\/[^/]+:/i.test(url)) return 'gemini';
    if (/\/v1\/completions(\?|$)/i.test(url)) return 'openai-legacy';
    return 'openai';
  }
  function extractGeminiModel(url) {
    const m = url.match(/\/models\/([^:]+):/);
    return m ? m[1] : null;
  }

  // ---- Minimal (self-contained) protocol parsers ----
  // Kept inline to avoid cross-world module loading complications.

  function parseRequest(protocol, bodyText) {
    if (!bodyText) return { model: null, inputText: '', streaming: false };
    let body;
    try { body = JSON.parse(bodyText); } catch { return { model: null, inputText: String(bodyText).slice(0, 2000), streaming: false }; }
    const streaming = body.stream === true;
    const extractMessageContent = (msgs) => {
      if (!Array.isArray(msgs)) return '';
      return msgs.map(m => {
        const c = m.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return c.map(p => p && p.type === 'text' ? (p.text||'') : '').join('\n');
        return '';
      }).join('\n');
    };
    if (protocol === 'openai' || protocol === 'openai-legacy') {
      return { model: body.model || null, inputText: extractMessageContent(body.messages) || String(body.prompt||''), streaming };
    }
    if (protocol === 'anthropic') {
      return { model: body.model || null, inputText: (body.system||'') + '\n' + extractMessageContent(body.messages), streaming };
    }
    if (protocol === 'gemini') {
      let t = '';
      if (Array.isArray(body.contents)) t = body.contents.map(c => (c.parts||[]).map(p=>p.text||'').join('\n')).join('\n');
      return { model: null, inputText: t, streaming };
    }
    return { model: null, inputText: '', streaming };
  }

  function parseJsonUsage(protocol, data) {
    if (!data || typeof data !== 'object') return { usage: null, outputText: '', model: null };
    if (protocol === 'openai' || protocol === 'openai-legacy') {
      const u = data.usage;
      const usage = u ? {
        inputTokens:   u.prompt_tokens     || 0,
        outputTokens:  u.completion_tokens || 0,
        totalTokens:   u.total_tokens      || (u.prompt_tokens||0)+(u.completion_tokens||0),
        cacheReadTokens: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0
      } : null;
      let outputText = '';
      if (Array.isArray(data.choices) && data.choices[0]) {
        const c = data.choices[0];
        outputText = (c.message && c.message.content) || c.text || '';
        if (Array.isArray(outputText)) outputText = outputText.map(p=>p&&p.type==='text'?(p.text||''):'').join('');
      }
      return { usage, outputText, model: data.model || null };
    }
    if (protocol === 'anthropic') {
      const u = data.usage;
      const usage = u ? {
        inputTokens:   u.input_tokens  || 0,
        outputTokens:  u.output_tokens || 0,
        totalTokens:   (u.input_tokens||0)+(u.output_tokens||0),
        cacheReadTokens:  u.cache_read_input_tokens     || 0,
        cacheWriteTokens: u.cache_creation_input_tokens || 0
      } : null;
      let outputText = '';
      if (Array.isArray(data.content)) outputText = data.content.map(p=>p&&p.type==='text'?(p.text||''):'').join('');
      return { usage, outputText, model: data.model || null };
    }
    if (protocol === 'gemini') {
      const u = data.usageMetadata;
      const usage = u ? {
        inputTokens:  u.promptTokenCount     || 0,
        outputTokens: u.candidatesTokenCount || 0,
        totalTokens:  u.totalTokenCount      || 0,
        cacheReadTokens: u.cachedContentTokenCount || 0
      } : null;
      let outputText = '';
      if (Array.isArray(data.candidates) && data.candidates[0]) {
        const parts = (data.candidates[0].content && data.candidates[0].content.parts) || [];
        outputText = parts.map(p=>p.text||'').join('');
      }
      return { usage, outputText, model: null };
    }
    return { usage: null, outputText: '', model: null };
  }

  // ---- Streaming accumulator (inlined to avoid module boundary) ----
  function makeAcc(protocol) {
    return {
      protocol, buffer: '', outputText: '', usage: null, model: null,
      feed(txt) {
        this.buffer += txt;
        this._process(false);
      },
      finish() {
        this._process(true);
        return { usage: this.usage, outputText: this.outputText, model: this.model };
      },
      _process(flush) {
        const lines = this.buffer.split('\n');
        if (!flush) this.buffer = lines.pop();
        else        this.buffer = '';
        for (const lineRaw of lines) {
          const line = lineRaw.replace(/\r$/, '');
          if (this.protocol === 'gemini') {
            const t = line.trim();
            if (!t) continue;
            let j; try { j = JSON.parse(t); } catch { continue; }
            this._applyGemini(j);
            continue;
          }
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let j; try { j = JSON.parse(payload); } catch { continue; }
          if (this.protocol === 'anthropic') this._applyAnthropic(j);
          else                               this._applyOpenAI(j);
        }
      },
      _applyOpenAI(j) {
        if (j.model && !this.model) this.model = j.model;
        if (j.usage) {
          this.usage = {
            inputTokens:  j.usage.prompt_tokens     || 0,
            outputTokens: j.usage.completion_tokens || 0,
            totalTokens:  j.usage.total_tokens      || 0,
            cacheReadTokens: (j.usage.prompt_tokens_details && j.usage.prompt_tokens_details.cached_tokens) || 0
          };
        }
        if (Array.isArray(j.choices) && j.choices[0]) {
          const d = j.choices[0].delta || {};
          if (typeof d.content === 'string') this.outputText += d.content;
          else if (Array.isArray(d.content)) this.outputText += d.content.map(p=>p&&p.type==='text'?(p.text||''):'').join('');
        }
      },
      _applyAnthropic(j) {
        const t = j.type;
        if (t === 'message_start' && j.message) {
          if (j.message.model) this.model = j.message.model;
          if (j.message.usage) {
            this.usage = this.usage || {inputTokens:0,outputTokens:0,totalTokens:0,cacheReadTokens:0,cacheWriteTokens:0};
            this.usage.inputTokens      = j.message.usage.input_tokens  || 0;
            this.usage.cacheReadTokens  = j.message.usage.cache_read_input_tokens     || 0;
            this.usage.cacheWriteTokens = j.message.usage.cache_creation_input_tokens || 0;
          }
        } else if (t === 'content_block_delta' && j.delta && j.delta.type==='text_delta') {
          if (typeof j.delta.text === 'string') this.outputText += j.delta.text;
        } else if (t === 'message_delta' && j.usage) {
          this.usage = this.usage || {inputTokens:0,outputTokens:0,totalTokens:0};
          this.usage.outputTokens = j.usage.output_tokens || this.usage.outputTokens || 0;
          this.usage.totalTokens  = (this.usage.inputTokens||0) + (this.usage.outputTokens||0);
        }
      },
      _applyGemini(j) {
        if (j.usageMetadata) {
          this.usage = {
            inputTokens:  j.usageMetadata.promptTokenCount     || 0,
            outputTokens: j.usageMetadata.candidatesTokenCount || 0,
            totalTokens:  j.usageMetadata.totalTokenCount      || 0,
            cacheReadTokens: j.usageMetadata.cachedContentTokenCount || 0
          };
        }
        if (Array.isArray(j.candidates) && j.candidates[0]) {
          const parts = (j.candidates[0].content && j.candidates[0].content.parts) || [];
          this.outputText += parts.map(p=>p.text||'').join('');
        }
      }
    };
  }

  function estimate(t) {
    if (!t) return 0;
    const s = String(t);
    const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7a3]/g) || []).length;
    const rest = s.length - cjk;
    return Math.ceil(rest/4) + Math.ceil(cjk/1.5);
  }

  function post(msg) {
    try { window.postMessage({ __tokenscope: true, payload: msg }, '*'); } catch (e) {}
  }

  function uid() { return 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10); }

  // ================== FETCH PATCH ==================
  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    // Resolve URL
    let url = '';
    try {
      if (typeof input === 'string') url = input;
      else if (input && input.url) url = input.url;
    } catch {}
    if (!url || !urlMatches(url)) {
      return originalFetch.apply(this, arguments);
    }

    const callId = uid();
    const protocol = detectProtocol(url);

    // Body
    let reqBodyText = null;
    try {
      if (init && init.body && typeof init.body === 'string') reqBodyText = init.body;
      else if (input && typeof input.clone === 'function') {
        // Request object
        const reqClone = input.clone();
        reqBodyText = await reqClone.text();
      }
    } catch {}

    const reqInfo = parseRequest(protocol, reqBodyText || '');
    const model = reqInfo.model || (protocol === 'gemini' ? extractGeminiModel(url) : null);

    const origin = (function(){ try { return new URL(url, location.href).host; } catch { return location.host; } })();
    const startedAt = Date.now();

    post({
      type: 'call_start',
      callId, url, origin, protocol, model,
      streaming: reqInfo.streaming,
      inputChars: (reqInfo.inputText||'').length,
      inputEstimate: estimate(reqInfo.inputText),
      startedAt
    });

    let response;
    try {
      response = await originalFetch.apply(this, arguments);
    } catch (err) {
      post({ type: 'call_error', callId, errMsg: String(err && err.message || err), endedAt: Date.now() });
      throw err;
    }

    const status = response.status;

    if (!response.ok || !response.body) {
      // error or bodyless — still report
      let errText = '';
      try { errText = (await response.clone().text()).slice(0, 500); } catch {}
      post({ type: 'call_end', callId, status, errText,
             usage: null, outputText: '', outputEstimate: 0,
             endedAt: Date.now(), elapsedMs: Date.now() - startedAt });
      return response;
    }

    // Tee the body so we can inspect while the page reads normally.
    try {
      const [pageStream, ourStream] = response.body.tee();
      // Return to the page an equivalent Response using pageStream
      const forwarded = new Response(pageStream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });

      // Background-parse ourStream
      (async () => {
        const reader = ourStream.getReader();
        const decoder = new TextDecoder();
        const acc = makeAcc(protocol);
        let rawText = '';
        const isStream = reqInfo.streaming || (response.headers.get('content-type')||'').includes('event-stream');
        try {
          while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, {stream: true});
            if (isStream) acc.feed(chunk);
            else rawText += chunk;
          }
        } catch (e) {
          // ignore; still emit best-effort
        }
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
          } catch {
            // non-json error
          }
        }

        // Fallback estimate if provider didn't include usage
        let usage = finalUsage;
        let estimated = false;
        if (!usage) {
          usage = {
            inputTokens:  estimate(reqInfo.inputText),
            outputTokens: estimate(outputText),
            totalTokens:  estimate(reqInfo.inputText) + estimate(outputText),
            cacheReadTokens: 0
          };
          estimated = true;
        }

        post({
          type: 'call_end',
          callId, status,
          model: finalModel,
          usage,
          estimated,
          outputText: outputText.slice(0, 4000),
          outputChars: outputText.length,
          outputEstimate: estimate(outputText),
          inputText: (reqInfo.inputText||'').slice(0, 4000),
          endedAt: Date.now(),
          elapsedMs: Date.now() - startedAt
        });
      })().catch(()=>{});

      return forwarded;
    } catch (e) {
      // tee failed — fall back to transparent passthrough
      post({ type: 'call_end', callId, status,
             errText: 'tee-failed:'+String(e&&e.message||e),
             usage: null, endedAt: Date.now(), elapsedMs: Date.now() - startedAt });
      return response;
    }
  };

  // ================== XHR PATCH ==================
  const XHR = window.XMLHttpRequest;
  const origOpen = XHR.prototype.open;
  const origSend = XHR.prototype.send;

  XHR.prototype.open = function(method, url) {
    this.__ts_url = url;
    this.__ts_method = method;
    return origOpen.apply(this, arguments);
  };

  XHR.prototype.send = function(body) {
    const xhr = this;
    const url = xhr.__ts_url || '';
    if (!urlMatches(url)) return origSend.apply(this, arguments);

    const callId = uid();
    const protocol = detectProtocol(url);
    const bodyText = typeof body === 'string' ? body : null;
    const reqInfo = parseRequest(protocol, bodyText || '');
    const model   = reqInfo.model || (protocol === 'gemini' ? extractGeminiModel(url) : null);
    const startedAt = Date.now();
    const origin = (function(){ try { return new URL(url, location.href).host; } catch { return location.host; } })();

    post({
      type: 'call_start', callId, url, origin, protocol, model,
      streaming: reqInfo.streaming,
      inputChars: (reqInfo.inputText||'').length,
      inputEstimate: estimate(reqInfo.inputText),
      startedAt
    });

    xhr.addEventListener('loadend', function() {
      try {
        const status = xhr.status;
        const respText = (xhr.responseType === '' || xhr.responseType === 'text') ? xhr.responseText : '';
        let usage = null, outputText = '', finalModel = model;
        if (respText) {
          // Try SSE first
          if ((respText.indexOf('data:') === 0) || /^\s*data:/.test(respText)) {
            const acc = makeAcc(protocol);
            acc.feed(respText);
            const r = acc.finish();
            usage = r.usage; outputText = r.outputText; finalModel = r.model || model;
          } else {
            try {
              const j = JSON.parse(respText);
              const r = parseJsonUsage(protocol, j);
              usage = r.usage; outputText = r.outputText; finalModel = r.model || model;
            } catch {}
          }
        }
        let estimated = false;
        if (!usage) {
          usage = {
            inputTokens:  estimate(reqInfo.inputText),
            outputTokens: estimate(outputText),
            totalTokens:  estimate(reqInfo.inputText) + estimate(outputText),
            cacheReadTokens: 0
          };
          estimated = true;
        }
        post({
          type: 'call_end', callId, status,
          model: finalModel,
          usage, estimated,
          outputText: outputText.slice(0, 4000),
          outputChars: outputText.length,
          outputEstimate: estimate(outputText),
          inputText: (reqInfo.inputText||'').slice(0, 4000),
          endedAt: Date.now(),
          elapsedMs: Date.now() - startedAt
        });
      } catch (e) {
        post({ type: 'call_error', callId, errMsg: String(e && e.message || e), endedAt: Date.now() });
      }
    });

    return origSend.apply(this, arguments);
  };

  post({ type: 'hook_ready', version: HOOK_VERSION, location: String(location.href) });
})();
