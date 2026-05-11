/**
 * TokenScope proxy (embedded) — parser.mjs
 *
 * Mirror of tokenscope-proxy/src/parser.mjs.
 * Protocols: openai (+legacy), anthropic, gemini.
 */

export function detectProtocol(url) {
  if (/\/v1\/messages(\?|$)/i.test(url))                       return 'anthropic';
  if (/\/v1beta\/models\/[^/]+:(stream)?[Gg]enerateContent/i.test(url)) return 'gemini';
  if (/\/v1\/completions(\?|$)/i.test(url))                    return 'openai-legacy';
  if (/\/v1\/chat\/completions(\?|$)/i.test(url))              return 'openai';
  if (/\/chat\/completions(\?|$)/i.test(url))                  return 'openai';
  return null;
}

export function extractGeminiModel(url) {
  const m = url.match(/\/models\/([^:]+):/);
  return m ? m[1] : null;
}

function flattenMessageContent(msgs) {
  if (!Array.isArray(msgs)) return '';
  return msgs.map(m => {
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(p => p && p.type === 'text' ? (p.text||'') : '').join('\n');
    return '';
  }).join('\n');
}

export function parseRequest(protocol, bodyText) {
  if (!bodyText) return { model: null, inputText: '', streaming: false };
  let body;
  try { body = JSON.parse(bodyText); }
  catch { return { model: null, inputText: String(bodyText).slice(0, 2000), streaming: false }; }

  const streaming = body.stream === true;

  if (protocol === 'openai' || protocol === 'openai-legacy') {
    return {
      model: body.model || null,
      inputText: flattenMessageContent(body.messages) || String(body.prompt || ''),
      streaming
    };
  }
  if (protocol === 'anthropic') {
    return {
      model: body.model || null,
      inputText: (body.system || '') + '\n' + flattenMessageContent(body.messages),
      streaming
    };
  }
  if (protocol === 'gemini') {
    let t = '';
    if (Array.isArray(body.contents)) {
      t = body.contents.map(c => (c.parts || []).map(p => p.text || '').join('\n')).join('\n');
    }
    return { model: null, inputText: t, streaming };
  }
  return { model: null, inputText: '', streaming };
}

export function parseJsonUsage(protocol, data) {
  if (!data || typeof data !== 'object') return { usage: null, outputText: '', model: null };

  if (protocol === 'openai' || protocol === 'openai-legacy') {
    const u = data.usage;
    const usage = u ? {
      inputTokens:  u.prompt_tokens     || 0,
      outputTokens: u.completion_tokens || 0,
      totalTokens:  u.total_tokens      || (u.prompt_tokens||0) + (u.completion_tokens||0),
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
      inputTokens:  u.input_tokens  || 0,
      outputTokens: u.output_tokens || 0,
      totalTokens:  (u.input_tokens||0) + (u.output_tokens||0),
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
      outputText = parts.map(p => p.text || '').join('');
    }
    return { usage, outputText, model: null };
  }

  return { usage: null, outputText: '', model: null };
}

export function createStreamAccumulator(protocol) {
  return {
    protocol, buffer: '', outputText: '', usage: null, model: null,

    feed(textChunk) {
      this.buffer += textChunk;
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
      } else if (t === 'content_block_delta' && j.delta && j.delta.type === 'text_delta') {
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
        this.outputText += parts.map(p => p.text || '').join('');
      }
    }
  };
}

export function estimateTokens(text) {
  if (!text) return 0;
  const s = String(text);
  const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7a3]/g) || []).length;
  const rest = s.length - cjk;
  return Math.ceil(rest/4) + Math.ceil(cjk/1.5);
}
