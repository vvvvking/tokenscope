import { applyI18n, t, resolveLang } from '../lib/i18n.js';
import { matchPricing, computeCost } from '../lib/storage.js';

// --- query helpers --------------------------------------------------------

function query(q, args = {}) {
  return new Promise((res, rej) => {
    chrome.runtime.sendMessage({ type: 'ts_query', q, args }, (r) => {
      if (chrome.runtime.lastError) return rej(chrome.runtime.lastError);
      if (!r || !r.ok) return rej(new Error(r && r.err || 'query failed'));
      res(r.data);
    });
  });
}

// --- formatters -----------------------------------------------------------

function fmtNum(n) {
  if (n == null || isNaN(n)) return '0';
  n = Math.round(Number(n));
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n/1000).toFixed(n < 10_000 ? 2 : 1) + 'K';
  return (n/1_000_000).toFixed(n < 10_000_000 ? 2 : 1) + 'M';
}
function fmtMoney(n, ccy='USD') {
  if (n == null || isNaN(n)) return '—';
  if (n < 0.01) return '< 0.01';
  return n.toFixed(n < 1 ? 4 : 2);
}

// --- state ----------------------------------------------------------------

let settings = null;
let todayData = null;
let liveRecs = new Map();

function currentLang() { return resolveLang(settings && settings.language); }

// --- render ---------------------------------------------------------------

function renderTodayStats(summary) {
  document.getElementById('stat-calls').textContent = fmtNum(summary.calls);
  document.getElementById('stat-in').textContent    = fmtNum(summary.inputTokens);
  document.getElementById('stat-out').textContent   = fmtNum(summary.outputTokens);
}

function renderTodayTable(rows) {
  const tbody = document.getElementById('today-tbody');
  const empty = document.getElementById('empty-today');
  const table = document.getElementById('today-table');
  const showCost = !!(settings && settings.showCost);
  document.getElementById('th-cost').style.display = showCost ? '' : 'none';

  rows = rows.slice().sort((a,b) => b.totalTokens - a.totalTokens);

  if (!rows.length) {
    tbody.innerHTML = '';
    table.style.display = 'none';
    empty.style.display = '';
    return;
  }
  table.style.display = '';
  empty.style.display = 'none';

  tbody.innerHTML = rows.map(r => {
    const p = matchPricing(settings.pricing, r.model);
    const cost = p ? computeCost(p, { inputTokens: r.inputTokens, outputTokens: r.outputTokens }) : null;
    const costCell = showCost
      ? `<td class="num">${cost ? (cost.currency==='USD'?'$':'') + fmtMoney(cost.total, cost.currency) : '<span class="dim">—</span>'}</td>`
      : '';
    const estTag = r.estimatedCalls > 0
      ? ` <span class="badge est" title="${t('hint_estimated', currentLang())}">~${r.estimatedCalls}</span>` : '';
    return `<tr>
      <td class="mono">${escapeHtml(r.model)}${estTag}</td>
      <td class="num">${r.calls}</td>
      <td class="num">${fmtNum(r.inputTokens)}</td>
      <td class="num">${fmtNum(r.outputTokens)}</td>
      ${costCell}
    </tr>`;
  }).join('');
}

function renderLiveBox() {
  const box = document.getElementById('live-box');
  const arr = Array.from(liveRecs.values());
  if (!arr.length) { box.innerHTML = ''; return; }
  box.innerHTML = arr.map(r => {
    const elapsed = Math.max(0, Date.now() - r.startedAt);
    return `<div style="display:flex;gap:8px;align-items:center;background:var(--accent-soft);padding:6px 10px;border-radius:6px;margin-bottom:4px;">
      <span class="spinner"></span>
      <span class="mono" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(r.model || r.origin || 'LLM call')}</span>
      <span class="mono dim">${(elapsed/1000).toFixed(1)}s</span>
    </div>`;
  }).join('');
}

function escapeHtml(s) {
  return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// --- load ----------------------------------------------------------------

async function reloadAll() {
  try {
    const r = await query('get_settings');
    settings = r.settings;
    applyI18n(document.body, currentLang());

    const s = await query('today_summary');
    todayData = s;
    renderTodayStats(s);
    renderTodayTable(s.models);

    const live = await query('live_calls');
    liveRecs.clear();
    for (const c of (live.rows || [])) liveRecs.set(c.callId, c);
    renderLiveBox();
  } catch (e) {
    // Fallback (e.g. sw just restarted) — show empty
    renderTodayStats({calls:0, inputTokens:0, outputTokens:0});
    renderTodayTable([]);
  }
}

// --- live events ---------------------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'ts_live') return;
  if (msg.kind === 'start') {
    liveRecs.set(msg.rec.callId, msg.rec);
    renderLiveBox();
  } else if (msg.kind === 'end') {
    liveRecs.delete(msg.rec.callId);
    renderLiveBox();
    reloadAll();   // update aggregates
  }
});

// Tick live elapsed every 500ms while popup is open
setInterval(() => { if (liveRecs.size) renderLiveBox(); }, 500);

// --- actions -------------------------------------------------------------

document.getElementById('btn-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById('btn-panel').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
    if (tab) await chrome.sidePanel.open({ tabId: tab.id });
    window.close();
  } catch (e) { alert(String(e.message || e)); }
});

document.getElementById('btn-export-json').addEventListener('click', async () => {
  const s = await query('today_summary');
  const recent = await query('recent_calls', {limit: 1000});
  const blob = new Blob([JSON.stringify({exportedAt: new Date().toISOString(), today: s, recent: recent.rows}, null, 2)],
                       {type:'application/json'});
  downloadBlob(blob, `tokenscope-${s.day}.json`);
});

document.getElementById('btn-export-csv').addEventListener('click', async () => {
  const recent = await query('recent_calls', {limit: 5000});
  const rows = recent.rows || [];
  const header = ['startedAt','day','origin','model','protocol','streaming','status','elapsedMs','inputTokens','outputTokens','totalTokens','estimated'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const u = r.usage || {};
    lines.push([
      new Date(r.startedAt||0).toISOString(),
      r.day || '',
      csvEsc(r.origin),
      csvEsc(r.model),
      csvEsc(r.protocol),
      r.streaming?'true':'false',
      r.status || '',
      r.elapsedMs || '',
      u.inputTokens||0, u.outputTokens||0, u.totalTokens||0,
      r.estimated?'true':'false'
    ].join(','));
  }
  const blob = new Blob([lines.join('\n')], {type:'text/csv'});
  downloadBlob(blob, `tokenscope-calls-${Date.now()}.csv`);
});

function csvEsc(s) {
  s = (s==null?'':String(s));
  if (/[,"\n]/.test(s)) return '"' + s.replace(/"/g,'""') + '"';
  return s;
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- go ------------------------------------------------------------------

reloadAll();
