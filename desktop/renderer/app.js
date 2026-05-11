/**
 * TokenScope Desktop — renderer app.js
 *
 * Pure vanilla JS. Talks to main via the `window.ts` contextBridge API.
 */

'use strict';

// ─── state ──────────────────────────────────────────────────────────────
const state = {
  settings: null,
  status:   null,
  records:  [],          // newest first
  filter:   '',
  platform: detectPlatform(),   // 'win' | 'mac' | 'linux'
  selectedTool: 'claude-code',
  wizardTool:   null,
  upstreamPresets: {}    // key → {label, url, protocol, region?, stripPrefix?}
};

function detectPlatform() {
  const ua = (navigator.userAgent || '').toLowerCase();
  if (ua.includes('win'))  return 'win';
  if (ua.includes('mac'))  return 'mac';
  return 'linux';
}

// ─── tool presets ───────────────────────────────────────────────────────
// Each preset returns { title, snippet, note } given current proxy host:port.
const TOOL_PRESETS = [
  {
    id: 'claude-code', label: 'Claude Code', sub: 'Anthropic CLI agent',
    build: ({host, port, platform}) => ({
      title: '把这段加到你的终端/配置里',
      snippet: platform === 'win'
        ? `# Windows PowerShell\n$env:ANTHROPIC_BASE_URL = "http://${host}:${port}"\n$env:ANTHROPIC_API_KEY  = "你的-anthropic-key"\nclaude   # 或者你平时启动 Claude Code 的命令`
        : `# macOS / Linux\nexport ANTHROPIC_BASE_URL="http://${host}:${port}"\nexport ANTHROPIC_API_KEY="你的-anthropic-key"\nclaude   # 或者你平时启动 Claude Code 的命令`,
      note: 'Claude Code 会读取 ANTHROPIC_BASE_URL，我们透明转发到 api.anthropic.com。'
    })
  },
  {
    id: 'cursor', label: 'Cursor', sub: 'OpenAI-compatible',
    build: ({host, port}) => ({
      title: 'Cursor 设置（Settings → Models）',
      snippet:
`Override OpenAI Base URL:
  http://${host}:${port}/v1

API Key:
  你的-openai-key
Model:
  gpt-4o-mini   （任何 OpenAI 模型名）`,
      note: '在 Cursor 的 Models 页打开「Override OpenAI Base URL」，填上上面的地址即可。'
    })
  },
  {
    id: 'cline', label: 'Cline / Continue', sub: 'VSCode agents',
    build: ({host, port}) => ({
      title: 'Cline / Continue 选择 OpenAI Compatible',
      snippet:
`Provider:   OpenAI Compatible
Base URL:   http://${host}:${port}/v1
API Key:    你的-openai-key
Model ID:   gpt-4o-mini  (or any OpenAI / compatible model)`,
      note: '这些 VSCode agent 都支持自定义 Base URL，填上即可被 TokenScope 看到每一次调用。'
    })
  },
  {
    id: 'openai-sdk', label: 'OpenAI SDK', sub: 'Python / Node / LangChain',
    build: ({host, port, platform}) => ({
      title: 'OpenAI 官方 SDK（Python 示例）',
      snippet:
`from openai import OpenAI

client = OpenAI(
    base_url="http://${host}:${port}/v1",
    api_key="你的-openai-key"
)
print(client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role":"user","content":"hello"}]
).choices[0].message.content)`,
      note: 'Node SDK 把 baseURL 设为同样的地址即可。LangChain 设 OPENAI_API_BASE。'
    })
  },
  {
    id: 'anthropic-sdk', label: 'Anthropic SDK', sub: 'Python / Node',
    build: ({host, port}) => ({
      title: 'Anthropic SDK（Python 示例）',
      snippet:
`from anthropic import Anthropic

client = Anthropic(
    base_url="http://${host}:${port}",
    api_key="你的-anthropic-key"
)
msg = client.messages.create(
    model="claude-3-5-sonnet-latest",
    max_tokens=256,
    messages=[{"role":"user","content":"hello"}]
)
print(msg.content[0].text)`,
      note: 'SDK 会直连 /v1/messages，TokenScope 透明转发到 api.anthropic.com。'
    })
  },
  {
    id: 'gemini', label: 'Gemini SDK', sub: 'Google AI',
    build: ({host, port}) => ({
      title: 'Gemini 需要自定义 transport/endpoint',
      snippet:
`# Python google-generativeai:
import google.generativeai as genai
genai.configure(
    api_key="你的-gemini-key",
    client_options={"api_endpoint": "${host}:${port}"},
    transport="rest"
)
print(genai.GenerativeModel("gemini-1.5-flash").generate_content("hello").text)`,
      note: 'REST transport + api_endpoint 才会走本地代理；默认 gRPC 不经过 HTTP 代理。'
    })
  },
  {
    id: 'curl', label: 'curl 快速测试', sub: '不装 SDK 也能验证',
    build: ({host, port, platform}) => ({
      title: 'curl 测试（任何终端）',
      snippet:
`curl -s http://${host}:${port}/v1/chat/completions \\
  -H "Authorization: Bearer 你的-openai-key" \\
  -H "Content-Type: application/json" \\
  -d "{\\"model\\":\\"gpt-4o-mini\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"hi\\"}]}"`,
      note: '即使没有真实 Key，返回 401 也能在「实时」Tab 里看到整条调用链路，说明代理已经通了。'
    })
  }
];

// ─── 国产模型 tool presets ───────────────────────────────────────────────
const CN_TOOL_PRESETS = [
  { id: 'cn-deepseek',    upstreamKey: 'deepseek',    label: 'DeepSeek',            sub: 'deepseek-chat / deepseek-coder',  exampleModel: 'deepseek-chat',                apiKeyName: 'deepseek' },
  { id: 'cn-moonshot',    upstreamKey: 'moonshot',    label: 'Moonshot Kimi',       sub: 'moonshot-v1-8k/32k/128k',         exampleModel: 'moonshot-v1-8k',               apiKeyName: 'moonshot' },
  { id: 'cn-zhipu',       upstreamKey: 'zhipu',       label: '智谱 GLM',             sub: 'glm-4 / glm-4.5 / glm-5.1',      exampleModel: 'glm-4-flash',                  apiKeyName: 'zhipu' },
  { id: 'cn-doubao',      upstreamKey: 'doubao',      label: '火山方舟 豆包',       sub: 'doubao-seed 等',                exampleModel: 'doubao-seed-1-6',              apiKeyName: '火山方舟' },
  { id: 'cn-qwen',        upstreamKey: 'qwen',        label: '阿里通义千问',       sub: 'qwen-max/plus/turbo',             exampleModel: 'qwen-plus',                    apiKeyName: 'dashscope' },
  { id: 'cn-yi',          upstreamKey: 'yi',          label: '零一万物 Yi',         sub: 'yi-lightning 等',               exampleModel: 'yi-lightning',                 apiKeyName: 'lingyiwanwu' },
  { id: 'cn-minimax',     upstreamKey: 'minimax',     label: 'MiniMax',             sub: 'abab 系列',                  exampleModel: 'abab6.5s-chat',                apiKeyName: 'minimax' },
  { id: 'cn-siliconflow', upstreamKey: 'siliconflow', label: '硅基流动',           sub: '聚合几十家模型',              exampleModel: 'Qwen/Qwen2.5-7B-Instruct',    apiKeyName: 'siliconflow' }
];

function buildCnPreset(cn, {host, port}) {
  return {
    title: `${cn.label} — OpenAI SDK (Python)`,
    snippet:
`# ① 在 TokenScope 设置里把「默认上游」选为【${cn.label}】
# ② 然后执行以下代码（或任何 OpenAI SDK 兼容的代码）

from openai import OpenAI

client = OpenAI(
    base_url="http://${host}:${port}/v1",
    api_key="你的-${cn.apiKeyName}-key"
)
print(client.chat.completions.create(
    model="${cn.exampleModel}",
    messages=[{"role":"user","content":"hello"}]
).choices[0].message.content)`,
    note: `也可以用 curl / Node SDK / 任何 OpenAI 兼容客户端。只要 base_url 指向本地代理即可。`
  };
}

// ─── helpers ────────────────────────────────────────────────────────────
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}
function fmtNum(n) { return (n|0).toLocaleString(); }
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function statusTag(rec) {
  if (rec.status === 'active') return '<span class="tag run">运行中</span>';
  if (rec.status === 'error')  return `<span class="tag err">${rec.httpStatus||'ERR'}</span>`;
  return `<span class="tag ok">${rec.httpStatus||'OK'}</span>` +
         (rec.estimated ? ' <span class="tag estim">~</span>' : '');
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

// ─── renderers ──────────────────────────────────────────────────────────
function renderStatus() {
  const st = state.status || { state: 'stopped', proxyPort: '?' };
  const pill = $('#statusPill'); pill.classList.remove('running','error','starting');
  if (st.state === 'running')  pill.classList.add('running');
  if (st.state === 'starting') pill.classList.add('starting');
  if (st.state === 'error')    pill.classList.add('error');
  $('#statusText').textContent =
    st.state === 'running'  ? `运行中 :${st.proxyPort}` :
    st.state === 'starting' ? '启动中…' :
    st.state === 'error'    ? '错误' :
                              '已停止';
  $('#toggleProxyBtn').textContent = st.state === 'running' ? '停止代理' : '启动代理';
  $('#statRecordsFile').textContent  = st.recordsFile || '—';
  $('#settingsRecordsFile').textContent = st.recordsFile || '—';
}

function renderStats() {
  const today = todayKey();
  let n=0, nOk=0, nErr=0, inTok=0, outTok=0;
  for (const r of state.records) {
    if (r.day !== today) continue;
    if (r.status === 'active') continue;
    n++;
    if (r.status === 'error') nErr++; else nOk++;
    if (r.usage) { inTok += r.usage.inputTokens|0; outTok += r.usage.outputTokens|0; }
  }
  $('#statToday').textContent    = fmtNum(n);
  $('#statTodayOk').textContent  = nOk;
  $('#statTodayErr').textContent = nErr;
  $('#statTodayIn').textContent  = fmtNum(inTok);
  $('#statTodayOut').textContent = fmtNum(outTok);
  $('#statTotal').textContent    = fmtNum(state.records.length);
}

function rowHtml(r, fullCols = false) {
  const u = r.usage || {};
  const inT  = u.inputTokens  || 0;
  const outT = u.outputTokens || 0;
  const tot  = u.totalTokens  || (inT + outT);
  const ms   = r.elapsedMs ? `${r.elapsedMs}ms` : (r.status === 'active' ? '…' : '—');
  const base = `
    <td>${fmtTime(r.startedAt)}</td>
    <td><span class="tag">${r.protocol || '?'}</span></td>
    <td>${r.model || '—'}</td>
    <td>${statusTag(r)}</td>
    <td class="num">${fmtNum(inT)}</td>
    <td class="num">${fmtNum(outT)}</td>`;
  if (fullCols) return base + `<td class="num">${fmtNum(tot)}</td><td class="num">${ms}</td>`;
  return base + `<td class="num">${ms}</td>`;
}

function renderLive() {
  const rows = state.records.slice(0, 100);
  const tbody = $('#liveRows');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">等待调用…</td></tr>'; }
  else tbody.innerHTML = rows.map(r => `<tr>${rowHtml(r, false)}</tr>`).join('');
  $('#liveCount').textContent = `${rows.length} 条`;
}

function renderHistory() {
  const f = state.filter.trim().toLowerCase();
  const rows = f
    ? state.records.filter(r =>
        (r.model    || '').toLowerCase().includes(f) ||
        (r.protocol || '').toLowerCase().includes(f) ||
        (r.errText  || '').toLowerCase().includes(f))
    : state.records;
  const tbody = $('#historyRows');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="8" class="empty">没有记录。启动代理后触发一次调用即可看到。</td></tr>'; }
  else tbody.innerHTML = rows.slice(0, 1000).map(r => `<tr>${rowHtml(r, true)}</tr>`).join('');
  $('#historyCount').textContent = `${rows.length} 条`;
}

function renderTools() {
  const host = (state.status && state.status.host) || '127.0.0.1';
  const port = (state.status && state.status.proxyPort) || (state.settings && state.settings.proxyPort) || 17666;
  const tabs = $('#toolsTabs');

  // Build combined presets: original + CN
  const allPresets = [
    ...TOOL_PRESETS.map(p => ({ id: p.id, label: p.label, isCn: false })),
    { id: '__cn_sep__', label: '🇨🇳 国产模型', isSep: true },
    ...CN_TOOL_PRESETS.map(p => ({ id: p.id, label: p.label, isCn: true }))
  ];

  tabs.innerHTML = allPresets.map(p => {
    if (p.isSep) return `<span class="tool-sep">${p.label}</span>`;
    return `<button class="tool-tab${p.id===state.selectedTool?' active':''}${p.isCn?' cn':''}" data-tool="${p.id}">${p.label}</button>`;
  }).join('');

  $$('#toolsTabs .tool-tab').forEach(b => {
    b.addEventListener('click', () => { state.selectedTool = b.dataset.tool; renderTools(); });
  });

  // Find the right preset and build snippet
  let built;
  const intl = TOOL_PRESETS.find(p => p.id === state.selectedTool);
  if (intl) {
    built = intl.build({ host, port, platform: state.platform });
  } else {
    const cn = CN_TOOL_PRESETS.find(p => p.id === state.selectedTool);
    if (cn) built = buildCnPreset(cn, { host, port });
    else built = TOOL_PRESETS[0].build({ host, port, platform: state.platform });
  }

  $('#toolsSnippetTitle').textContent = built.title;
  $('#toolsSnippet').textContent      = built.snippet;
  $('#toolsNote').textContent         = built.note;
}

function renderSettings() {
  const s = state.settings; if (!s) return;
  $('#setProxyPort').value    = s.proxyPort;
  $('#setControlPort').value  = s.controlPort;
  $('#setRetention').value    = s.retention;
  $('#setAutoStart').checked  = !!s.autoStart;
  $('#setLaunchAtLogin').checked = !!s.launchAtLogin;

  // Populate upstream select
  const sel = $('#setDefaultUpstream');
  if (sel && !sel.childElementCount) {
    const presets = state.upstreamPresets;
    // Group: international first, then CN
    const intlKeys = Object.keys(presets).filter(k => !presets[k].region);
    const cnKeys   = Object.keys(presets).filter(k => presets[k].region === 'CN');
    sel.innerHTML = '';
    if (intlKeys.length) {
      const og1 = document.createElement('optgroup');
      og1.label = '国际';
      for (const k of intlKeys) { const o = document.createElement('option'); o.value = k; o.textContent = presets[k].label; og1.appendChild(o); }
      sel.appendChild(og1);
    }
    if (cnKeys.length) {
      const og2 = document.createElement('optgroup');
      og2.label = '🇨🇳 国产';
      for (const k of cnKeys) { const o = document.createElement('option'); o.value = k; o.textContent = presets[k].label; og2.appendChild(o); }
      sel.appendChild(og2);
    }
  }
  if (sel) sel.value = s.defaultUpstream || 'openai';
}

// ─── wizard ─────────────────────────────────────────────────────────────
function openWizard() {
  const wiz = $('#wizard'); wiz.classList.remove('hidden');
  const grid = $('#wizardToolGrid');
  const allTools = [
    ...TOOL_PRESETS,
    ...CN_TOOL_PRESETS.map(cn => ({ id: cn.id, label: cn.label, sub: cn.sub }))
  ];
  grid.innerHTML = allTools.map(p =>
    `<button data-tool="${p.id}"><div class="tool-title">${p.label}</div><div class="tool-sub">${p.sub}</div></button>`
  ).join('');
  $$('#wizardToolGrid button').forEach(b => {
    b.addEventListener('click', () => {
      $$('#wizardToolGrid button').forEach(x => x.classList.remove('selected'));
      b.classList.add('selected');
      state.wizardTool = b.dataset.tool;
      $('#wizardPickNext').disabled = false;
    });
  });
  showWizardStep('welcome');
}
function showWizardStep(step) {
  $$('.wizard-step').forEach(el => el.classList.toggle('hidden', el.dataset.step !== step));
  if (step === 'done') {
    const host = (state.status && state.status.host) || '127.0.0.1';
    const port = (state.status && state.status.proxyPort) || (state.settings && state.settings.proxyPort) || 17666;
    const tool = TOOL_PRESETS.find(p => p.id === state.wizardTool);
    let built;
    if (tool) {
      built = tool.build({ host, port, platform: state.platform });
    } else {
      const cn = CN_TOOL_PRESETS.find(p => p.id === state.wizardTool);
      built = cn ? buildCnPreset(cn, { host, port }) : TOOL_PRESETS[0].build({ host, port, platform: state.platform });
    }
    $('#wizardProxyAddr').textContent = `http://${host}:${port}`;
    $('#wizardToolName').textContent  = tool ? tool.label : (CN_TOOL_PRESETS.find(p => p.id === state.wizardTool) || {}).label || 'Unknown';
    $('#wizardSnippet').textContent   = built.snippet;
  }
}
async function finishWizard() {
  await window.ts.saveSettings({ firstRunDone: true });
  if (state.wizardTool) state.selectedTool = state.wizardTool;
  $('#wizard').classList.add('hidden');
  renderTools();
}

// ─── wiring ─────────────────────────────────────────────────────────────
function switchTab(name) {
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach(s       => s.classList.toggle('active', s.dataset.tab === name));
  if (name === 'history') renderHistory();
  if (name === 'live')    renderLive();
  if (name === 'home')    { renderStats(); renderTools(); }
  if (name === 'settings') renderSettings();
}

function applyRecordEvent(kind, rec) {
  const idx = state.records.findIndex(r => r.callId === rec.callId);
  if (idx >= 0) state.records[idx] = rec;
  else          state.records.unshift(rec);
  // cap in-memory buffer
  if (state.records.length > 5000) state.records.length = 5000;
  renderStats();
  renderLive();
  if ($('.tab[data-tab="history"]').classList.contains('active')) renderHistory();
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-action], [data-tab]');
  if (!t) return;

  if (t.dataset.tab) { switchTab(t.dataset.tab); return; }

  const a = t.dataset.action;
  if (a === 'wizard-next') {
    showWizardStep(t.dataset.next);
  } else if (a === 'wizard-finish') {
    finishWizard();
  } else if (a === 'copy-snippet') {
    copyText($('#wizardSnippet').textContent).then(ok => { if (ok) t.textContent = '已复制 ✓'; });
  } else if (a === 'copy-tools-snippet') {
    copyText($('#toolsSnippet').textContent).then(ok => {
      $('#toolsCopyHint').textContent = ok ? '已复制到剪贴板 ✓' : '复制失败';
      setTimeout(() => $('#toolsCopyHint').textContent = '', 2000);
    });
  } else if (a === 'refresh-history') {
    await reloadRecords(); renderHistory();
  } else if (a === 'clear-records') {
    if (!confirm('清空所有历史记录？此操作不可撤销。')) return;
    await window.ts.clearRecords();
    state.records = []; renderStats(); renderLive(); renderHistory();
  } else if (a === 'clear-live') {
    // just visual — keep records
    $('#liveRows').innerHTML = '<tr><td colspan="7" class="empty">已清空视图。新的调用会继续进来。</td></tr>';
    $('#liveCount').textContent = '0 条';
  } else if (a === 'save-settings') {
    await window.ts.saveSettings({
      proxyPort:       Number($('#setProxyPort').value)   || 17666,
      controlPort:     Number($('#setControlPort').value) || 17667,
      retention:       Number($('#setRetention').value)   || 5000,
      autoStart:       $('#setAutoStart').checked,
      launchAtLogin:   $('#setLaunchAtLogin').checked,
      defaultUpstream: $('#setDefaultUpstream') ? $('#setDefaultUpstream').value : undefined
    });
    state.settings = await window.ts.getSettings();
    $('#settingsSaveHint').textContent = '已保存（端口改动需重启代理，上游切换实时生效）';
    setTimeout(() => $('#settingsSaveHint').textContent = '', 3000);
  } else if (a === 'open-data-dir') {
    await window.ts.openDataDir();
  } else if (a === 'quit') {
    if (confirm('退出 TokenScope？代理也会一并停止。')) await window.ts.quit();
  }
});

$('#toggleProxyBtn').addEventListener('click', async () => {
  if (state.status && state.status.state === 'running') await window.ts.stopProxy();
  else                                                   await window.ts.startProxy();
  state.status = await window.ts.getStatus();
  renderStatus(); renderTools();
});

$('#historyFilter').addEventListener('input', (e) => { state.filter = e.target.value; renderHistory(); });

// ─── bootstrap ──────────────────────────────────────────────────────────
async function reloadRecords() {
  try { state.records = await window.ts.getRecords(5000) || []; }
  catch { state.records = []; }
}

(async function init() {
  state.settings = await window.ts.getSettings();
  state.status   = await window.ts.getStatus();
  state.upstreamPresets = await window.ts.getUpstreamPresets() || {};
  $('#brandVer').textContent = 'v' + (state.status.version || '0.3.0');

  window.ts.subscribe(
    (msg) => applyRecordEvent(msg.kind, msg.rec),
    (st)  => { state.status = st; renderStatus(); renderTools(); }
  );

  renderStatus();
  renderSettings();

  await reloadRecords();
  renderStats();
  renderLive();
  renderTools();

  if (!state.settings.firstRunDone) openWizard();
})();
