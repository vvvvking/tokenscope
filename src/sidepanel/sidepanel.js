import { applyI18n, t, resolveLang, fmtAgo } from '../lib/i18n.js';
import { matchPricing, computeCost } from '../lib/storage.js';

function query(q, args = {}) {
  return new Promise((res, rej) => {
    chrome.runtime.sendMessage({ type: 'ts_query', q, args }, (r) => {
      if (chrome.runtime.lastError) return rej(chrome.runtime.lastError);
      if (!r || !r.ok) return rej(new Error(r && r.err || 'query failed'));
      res(r.data);
    });
  });
}

// ---- formatters ----
const fmtNum = (n) => {
  if (n == null || isNaN(n)) return '0';
  n = Math.round(Number(n));
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n/1000).toFixed(n<10_000?2:1) + 'K';
  return (n/1_000_000).toFixed(n<10_000_000?2:1) + 'M';
};
const fmtMoney = (n) => n==null||isNaN(n) ? '—' : (n<0.01 ? '<0.01' : n.toFixed(n<1?4:2));
const escapeHtml = (s) => String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// ---- state ----
let settings = null;
let liveRecs = new Map();
let recentCache = [];
let currentTab = 'live';
let currentTabId = null;

const lang = () => resolveLang(settings && settings.language);

// ---- tab switch ----
document.querySelectorAll('.tabs .tab').forEach(el => {
  el.addEventListener('click', () => {
    document.querySelectorAll('.tabs .tab').forEach(x => x.classList.toggle('active', x===el));
    document.querySelectorAll('.view').forEach(v => v.style.display = 'none');
    currentTab = el.dataset.tab;
    document.getElementById('view-' + currentTab).style.display = '';
    refreshCurrent();
  });
});

async function refreshCurrent() {
  if (currentTab === 'live')    return renderLive();
  if (currentTab === 'today')   return renderToday();
  if (currentTab === 'history') return renderHistory();
  if (currentTab === 'models')  return renderModels();
}

// ---- LIVE ----
async function renderLive() {
  const list = document.getElementById('live-list');
  const empty = document.getElementById('live-empty');
  const forTab = currentTabId != null
    ? await query('live_calls_for_tab', {tabId: currentTabId})
    : await query('live_calls');
  const arr = forTab.rows || [];
  if (!arr.length) {
    list.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';
  list.innerHTML = arr.map(r => {
    const elapsed = Math.max(0, Date.now() - r.startedAt);
    return `<div style="background:var(--accent-soft);padding:10px 12px;border-radius:6px;margin-bottom:6px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="spinner"></span>
        <b class="mono">${escapeHtml(r.model || '(unknown model)')}</b>
        <span class="dim mono" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(r.origin||'')}</span>
        <span class="mono">${(elapsed/1000).toFixed(1)}s</span>
      </div>
      <div class="dim" style="margin-top:3px;font-size:11px;">
        ${r.streaming ? t('streaming', lang()) : t('non_streaming', lang())}
        · input ≈ <b class="mono">${fmtNum(r.inputEstimate)}</b> tokens (${r.inputChars} chars)
      </div>
    </div>`;
  }).join('');
}

// ---- TODAY ----
async function renderToday() {
  const s = await query('today_summary');
  document.getElementById('t-calls').textContent = fmtNum(s.calls);
  document.getElementById('t-in').textContent    = fmtNum(s.inputTokens);
  document.getElementById('t-out').textContent   = fmtNum(s.outputTokens);
  const showCost = !!(settings && settings.showCost);
  document.getElementById('t-th-cost').style.display = showCost ? '' : 'none';

  const rows = (s.models || []).slice().sort((a,b) => b.totalTokens - a.totalTokens);
  document.getElementById('t-tbody').innerHTML = rows.map(r => {
    const p = matchPricing(settings.pricing, r.model);
    const c = p ? computeCost(p, r) : null;
    const costCell = showCost
      ? `<td class="num">${c ? (c.currency==='USD'?'$':'') + fmtMoney(c.total) : '<span class="dim">—</span>'}</td>`
      : '';
    return `<tr>
      <td class="mono">${escapeHtml(r.model)}${r.estimatedCalls>0?` <span class="badge est" title="${t('hint_estimated', lang())}">~${r.estimatedCalls}</span>`:''}</td>
      <td class="num">${r.calls}</td>
      <td class="num">${fmtNum(r.inputTokens)}</td>
      <td class="num">${fmtNum(r.outputTokens)}</td>
      <td class="num">${fmtNum(r.totalTokens)}</td>
      ${costCell}
    </tr>`;
  }).join('');
}

// ---- HISTORY ----
async function renderHistory() {
  const r = await query('recent_calls', {limit: 500});
  recentCache = r.rows || [];
  applyHistoryFilter();
}

function applyHistoryFilter() {
  const q = (document.getElementById('filter-q').value || '').trim().toLowerCase();
  const rows = recentCache.filter(r => !q ||
    (r.model && r.model.toLowerCase().includes(q)) ||
    (r.origin && r.origin.toLowerCase().includes(q)));
  const tbody = document.getElementById('h-tbody');
  const empty = document.getElementById('h-empty');
  if (!rows.length) { tbody.innerHTML = ''; empty.style.display = ''; return; }
  empty.style.display = 'none';
  tbody.innerHTML = rows.map(r => {
    const u = r.usage || {};
    const st = r.status === 'done' ? `<span class="badge done">${t('done', lang())}</span>`
             : r.status === 'error' ? `<span class="badge error">${t('error', lang())}</span>`
             : `<span class="badge active">${t('active', lang())}</span>`;
    return `<tr class="call-row" data-id="${r.callId}">
      <td class="dim">${fmtAgo(r.startedAt, lang())}</td>
      <td class="trunc dim mono" title="${escapeHtml(r.origin)}">${escapeHtml(r.origin||'')}</td>
      <td class="mono">${escapeHtml(r.model||'—')}${r.estimated?` <span class="badge est">~</span>`:''}</td>
      <td>${st}</td>
      <td class="num">${fmtNum(u.inputTokens)}</td>
      <td class="num">${fmtNum(u.outputTokens)}</td>
      <td class="num dim">${r.elapsedMs||0}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.call-row').forEach(row => {
    row.addEventListener('click', () => openDetail(row.dataset.id));
  });
}

document.getElementById('filter-q').addEventListener('input', applyHistoryFilter);

// ---- MODELS ----
async function renderModels() {
  const r = await query('range_agg', {days: 30});
  const agg = {};
  for (const row of (r.rows||[])) {
    const m = row.model || '(unknown)';
    agg[m] = agg[m] || {model:m, calls:0, inputTokens:0, outputTokens:0, totalTokens:0};
    agg[m].calls += row.calls;
    agg[m].inputTokens  += row.inputTokens;
    agg[m].outputTokens += row.outputTokens;
    agg[m].totalTokens  += row.totalTokens;
  }
  const rows = Object.values(agg).sort((a,b) => b.totalTokens - a.totalTokens);
  document.getElementById('m-tbody').innerHTML = rows.map(r => `<tr>
    <td class="mono">${escapeHtml(r.model)}</td>
    <td class="num">${r.calls}</td>
    <td class="num">${fmtNum(r.inputTokens)}</td>
    <td class="num">${fmtNum(r.outputTokens)}</td>
    <td class="num">${fmtNum(r.totalTokens)}</td>
  </tr>`).join('');
}

// ---- DETAIL MODAL ----
async function openDetail(callId) {
  const r = await query('call_detail', {callId});
  if (!r.row) return;
  const c = r.row;
  document.getElementById('dm-model').textContent = c.model || '(unknown model)';
  const st = c.status === 'error' ? `<span class="badge error">${t('error', lang())} ${c.httpStatus||''}</span>`
           : c.status === 'done'  ? `<span class="badge done">${t('done', lang())}</span>`
           : `<span class="badge active">${t('active', lang())}</span>`;
  document.getElementById('dm-status').outerHTML = st.replace('<span', '<span id="dm-status"');

  const u = c.usage || {};
  document.getElementById('dm-meta').innerHTML = `
    <span class="k">URL</span>         <span class="v">${escapeHtml(c.url||'')}</span>
    <span class="k">Protocol</span>    <span class="v">${escapeHtml(c.protocol||'')}</span>
    <span class="k">Streaming</span>   <span class="v">${c.streaming?'yes':'no'}</span>
    <span class="k">Started</span>     <span class="v">${new Date(c.startedAt||0).toLocaleString()}</span>
    <span class="k">Elapsed</span>     <span class="v">${c.elapsedMs||0} ms</span>
    <span class="k">HTTP</span>        <span class="v">${c.httpStatus||'—'}</span>
  `;

  const p = matchPricing(settings.pricing, c.model);
  const cost = p ? computeCost(p, u) : null;
  document.getElementById('dm-usage').innerHTML = `
    <span class="k">Input</span>       <span class="v">${fmtNum(u.inputTokens)} ${c.estimated?'<span class="badge est">~</span>':''}</span>
    <span class="k">Output</span>      <span class="v">${fmtNum(u.outputTokens)}</span>
    <span class="k">Total</span>       <span class="v">${fmtNum(u.totalTokens)}</span>
    ${u.cacheReadTokens ? `<span class="k">Cache read</span>  <span class="v">${fmtNum(u.cacheReadTokens)}</span>`:''}
    ${u.cacheWriteTokens? `<span class="k">Cache write</span> <span class="v">${fmtNum(u.cacheWriteTokens)}</span>`:''}
    ${cost ? `<span class="k">Cost</span>        <span class="v">${cost.currency==='USD'?'$':''}${fmtMoney(cost.total)} ${cost.currency}</span>`:''}
  `;
  document.getElementById('dm-in').textContent  = c.inputTextPreview  || '(no preview)';
  document.getElementById('dm-out').textContent = c.outputTextPreview || c.errText || '(no preview)';
  document.getElementById('detail-mask').classList.add('open');
}

// ---- LIVE broadcast listener ----
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'ts_live') return;
  if (msg.kind === 'start') liveRecs.set(msg.rec.callId, msg.rec);
  else if (msg.kind === 'end') liveRecs.delete(msg.rec.callId);
  if (currentTab === 'live')  renderLive();
  if (currentTab === 'today' && msg.kind === 'end') renderToday();
});

setInterval(() => { if (currentTab === 'live') renderLive(); }, 500);

// ---- init ----
document.getElementById('btn-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

document.getElementById('btn-export-csv-h').addEventListener('click', () => {
  const rows = recentCache;
  const header = ['startedAt','day','origin','model','protocol','streaming','status','elapsedMs','inputTokens','outputTokens','totalTokens','estimated'];
  const lines = [header.join(',')];
  const esc = s => (s==null?'':/[,"\n]/.test(String(s))?`"${String(s).replace(/"/g,'""')}"`:String(s));
  for (const r of rows) {
    const u = r.usage || {};
    lines.push([new Date(r.startedAt||0).toISOString(), r.day||'', esc(r.origin), esc(r.model), esc(r.protocol),
                r.streaming?'true':'false', r.status||'', r.elapsedMs||'',
                u.inputTokens||0, u.outputTokens||0, u.totalTokens||0, r.estimated?'true':'false'].join(','));
  }
  const blob = new Blob([lines.join('\n')], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download=`tokenscope-history-${Date.now()}.csv`; a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
});

(async () => {
  const r = await query('get_settings');
  settings = r.settings;
  applyI18n(document.body, lang());
  try {
    const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
    if (tab) currentTabId = tab.id;
  } catch {}
  refreshCurrent();
})();
