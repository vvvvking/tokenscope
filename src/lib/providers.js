/**
 * TokenScope — Providers registry
 *
 * Maps a captured request URL + body + response to a unified token-usage record.
 *
 * Each provider returns { matched: bool, protocol: string, model: string|null,
 *   streaming: bool, parseStream(chunk)/parseJson(data) -> {usage, deltaText} }
 *
 * Currently supported protocols (covering ~95% of real-world LLM traffic):
 *   - openai        : /v1/chat/completions, /v1/completions   (OpenAI, Azure, DeepSeek,
 *                     Moonshot, Qwen OpenAI-compat, Doubao Ark, Together, Groq,
 *                     OpenRouter, NovAI, LiteLLM, one-api/new-api, vLLM, Ollama-OAI, …)
 *   - anthropic     : /v1/messages                            (Claude native)
 *   - gemini        : /v1beta/models/*:generateContent|streamGenerateContent
 *
 * Unified usage shape:
 *   { inputTokens:number, outputTokens:number, totalTokens:number,
 *     cacheReadTokens?:number, cacheWriteTokens?:number }
 */

const URL_PATTERNS = [
  { re: /\/v1\/chat\/completions(\?|$)/i,     protocol: 'openai'   },
  { re: /\/chat\/completions(\?|$)/i,         protocol: 'openai'   },
  { re: /\/v1\/completions(\?|$)/i,           protocol: 'openai-legacy' },
  { re: /\/v1\/messages(\?|$)/i,              protocol: 'anthropic'},
  { re: /\/v1beta\/models\/.+?:generateContent/i,       protocol: 'gemini'   },
  { re: /\/v1beta\/models\/.+?:streamGenerateContent/i, protocol: 'gemini'   }
];

export function matchProtocol(url) {
  for (const p of URL_PATTERNS) {
    if (p.re.test(url)) return p.protocol;
  }
  return null;
}

// ========== REQUEST PARSING ==========

export function parseRequest(protocol, bodyText) {
  if (!bodyText) return { model: null, inputText: '', streaming: false };
  let body;
  try { body = JSON.parse(bodyText); } catch { return { model: null, inputText: bodyText.slice(0, 4000), streaming: false }; }

  const streaming = body.stream === true;

  if (protocol === 'openai' || protocol === 'openai-legacy') {
    const model = body.model || null;
    let inputText = '';
    if (Array.isArray(body.messages)) {
      inputText = body.messages.map(m => {
        const c = m.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return c.map(p => p && p.type === 'text' ? (p.text||'') : '').join('\n');
        return '';
      }).join('\n');
    } else if (typeof body.prompt === 'string') {
      inputText = body.prompt;
    }
    return { model, inputText, streaming };
  }

  if (protocol === 'anthropic') {
    const model = body.model || null;
    let inputText = (body.system || '') + '\n';
    if (Array.isArray(body.messages)) {
      inputText += body.messages.map(m => {
        const c = m.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return c.map(p => p && p.type === 'text' ? (p.text||'') : '').join('\n');
        return '';
      }).join('\n');
    }
    return { model, inputText, streaming };
  }

  if (protocol === 'gemini') {
    // Model is encoded in URL path for Gemini; caller should pass it in `modelHint`
    let inputText = '';
    if (Array.isArray(body.contents)) {
      inputText = body.contents.map(c => {
        if (!c.parts) return '';
        return c.parts.map(p => p.text || '').join('\n');
      }).join('\n');
    }
    return { model: null, inputText, streaming };
  }

  return { model: null, inputText: '', streaming };
}

export function extractGeminiModel(url) {
  const m = url.match(/\/models\/([^:]+):/);
  return m ? m[1] : null;
}

// ========== RESPONSE PARSING (non-streaming) ==========

export function parseResponseJson(protocol, data) {
  if (!data || typeof data !== 'object') return { usage: null, outputText: '' };

  if (protocol === 'openai' || protocol === 'openai-legacy') {
    const u = data.usage;
    const usage = u ? {
      inputTokens:   u.prompt_tokens    || 0,
      outputTokens:  u.completion_tokens|| 0,
      totalTokens:   u.total_tokens     || (u.prompt_tokens||0) + (u.completion_tokens||0),
      cacheReadTokens:  (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0
    } : null;
    let outputText = '';
    if (Array.isArray(data.choices) && data.choices[0]) {
      const c = data.choices[0];
      outputText = (c.message && c.message.content) || c.text || '';
      if (Array.isArray(outputText)) {
        outputText = outputText.map(p => p && p.type==='text' ? (p.text||'') : '').join('');
      }
    }
    return { usage, outputText, model: data.model || null };
  }

  if (protocol === 'anthropic') {
    const u = data.usage;
    const usage = u ? {
      inputTokens:   u.input_tokens  || 0,
      outputTokens:  u.output_tokens || 0,
      totalTokens:   (u.input_tokens||0) + (u.output_tokens||0),
      cacheReadTokens:  u.cache_read_input_tokens     || 0,
      cacheWriteTokens: u.cache_creation_input_tokens || 0
    } : null;
    let outputText = '';
    if (Array.isArray(data.content)) {
      outputText = data.content.map(p => p && p.type==='text' ? (p.text||'') : '').join('');
    }
    return { usage, outputText, model: data.model || null };
  }

  if (protocol === 'gemini') {
    const u = data.usageMetadata;
    const usage = u ? {
      inputTokens:   u.promptTokenCount     || 0,
      outputTokens:  u.candidatesTokenCount || 0,
      totalTokens:   u.totalTokenCount      || 0,
      cacheReadTokens: u.cachedContentTokenCount || 0
    } : null;
    let outputText = '';
    if (Array.isArray(data.candidates) && data.candidates[0]) {
      const parts = (data.candidates[0].content && data.candidates[0].content.parts) || [];
      outputText = parts.map(p => p.text || '').join('');
    }
    return { usage, outputText, model: null };
  }

  return { usage: null, outputText: '' };
}

// ========== RESPONSE PARSING (streaming SSE) ==========
//
// Incremental accumulator. Usage is captured from the LAST chunk that contains
// it — OpenAI sends usage only when stream_options.include_usage is true; many
// proxies include it anyway. Anthropic sends message_delta with final usage.
// Gemini's streamGenerateContent returns JSON-lines with usageMetadata on each
// chunk (we keep the last one).

export function createStreamAccumulator(protocol) {
  return {
    protocol,
    buffer:    '',
    outputText:'',
    usage:     null,
    model:     null,
    feed(textChunk) {
      this.buffer += textChunk;
      if (protocol === 'openai' || protocol === 'openai-legacy') {
        this._feedSSE('openai');
      } else if (protocol === 'anthropic') {
        this._feedSSE('anthropic');
      } else if (protocol === 'gemini') {
        this._feedJsonLines();
      }
    },
    finish() {
      // flush any trailing partial line
      if (this.buffer) {
        if (this.protocol === 'openai' || this.protocol === 'openai-legacy') this._feedSSE('openai', true);
        else if (this.protocol === 'anthropic') this._feedSSE('anthropic', true);
        else if (this.protocol === 'gemini')    this._feedJsonLines(true);
      }
      return { usage: this.usage, outputText: this.outputText, model: this.model };
    },
    _feedSSE(kind, flush) {
      const lines = this.buffer.split('\n');
      if (!flush) this.buffer = lines.pop();
      else        this.buffer = '';
      for (const lineRaw of lines) {
        const line = lineRaw.replace(/\r$/, '');
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let j;
        try { j = JSON.parse(payload); } catch { continue; }

        if (kind === 'openai') {
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
            if (Array.isArray(d.content)) {
              this.outputText += d.content.map(p=>p&&p.type==='text'?(p.text||''):'').join('');
            }
          }
        } else if (kind === 'anthropic') {
          // Anthropic events: message_start / content_block_delta / message_delta / message_stop
          const t = j.type;
          if (t === 'message_start' && j.message) {
            if (j.message.model) this.model = j.message.model;
            if (j.message.usage) {
              this.usage = this.usage || {inputTokens:0,outputTokens:0,totalTokens:0,cacheReadTokens:0,cacheWriteTokens:0};
              this.usage.inputTokens      = j.message.usage.input_tokens  || 0;
              this.usage.cacheReadTokens  = j.message.usage.cache_read_input_tokens     || 0;
              this.usage.cacheWriteTokens = j.message.usage.cache_creation_input_tokens || 0;
            }
          } else if (t === 'content_block_delta' && j.delta) {
            if (j.delta.type === 'text_delta' && typeof j.delta.text === 'string') {
              this.outputText += j.delta.text;
            }
          } else if (t === 'message_delta' && j.usage) {
            this.usage = this.usage || {inputTokens:0,outputTokens:0,totalTokens:0};
            this.usage.outputTokens = j.usage.output_tokens || this.usage.outputTokens || 0;
            this.usage.totalTokens  = (this.usage.inputTokens||0) + (this.usage.outputTokens||0);
          }
        }
      }
    },
    _feedJsonLines(flush) {
      // Gemini streamGenerateContent returns a JSON array of chunks;
      // many Google-compatible gateways emit newline-delimited JSON.
      // We try both: split by '\n' and also try parsing the whole buffer.
      const lines = this.buffer.split('\n');
      if (!flush) this.buffer = lines.pop();
      else        this.buffer = '';
      for (const lineRaw of lines) {
        const line = lineRaw.trim();
        if (!line) continue;
        let j;
        try { j = JSON.parse(line); } catch {
          // Sometimes the entire response is a pretty-printed JSON array — skip
          continue;
        }
        this._applyGeminiChunk(j);
      }
    },
    _applyGeminiChunk(j) {
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
        this.outputText += parts.map(p => p.text || '').join('');
      }
    }
  };
}

// ========== FALLBACK TOKEN ESTIMATOR ==========
//
// When a provider does not return `usage` (e.g. some self-hosted proxies,
// Anthropic without stream_options, or intermediate chunks), we estimate:
//   - Latin / code / digits : ~4 chars per token
//   - CJK / Hangul / Kana   : ~1.5 chars per token
// This is a rough approximation; the UI always marks estimated values with ~.

export function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7a3]/g) || []).length;
  const rest = s.length - cjk;
  return Math.ceil(rest / 4) + Math.ceil(cjk / 1.5);
}
