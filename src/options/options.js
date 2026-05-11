import { applyI18n, t, resolveLang } from '../lib/i18n.js';

function query(q, args = {}) {
  return new Promise((res, rej) => {
    chrome.runtime.sendMessage({ type: 'ts_query', q, args }, (r) => {
      if (chrome.runtime.lastError) return rej(chrome.runtime.lastError);
      if (!r || !r.ok) return rej(new Error(r && r.err || 'query failed'));
      res(r.data);
    });
  });
}

let settings = null;
const lang = () => resolveLang(settings && settings.language);

function escapeHtml(s) {
  return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function renderPricing(list) {
  const tbody = document.getElementById('pricing-tbody');
  tbody.innerHTML = '';
  list.forEach((p, i) => tbody.appendChild(mkRow(p, i)));
  if (!list.length) tbody.appendChild(mkRow({pattern:'', inputPer1M:0, outputPer1M:0, currency:'USD'}, 0));
}

function mkRow(p, i) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text"   class="p-pat"  value="${escapeHtml(p.pattern||'')}" placeholder="gpt-4o*"></td>
    <td><input type="number" class="p-in"   value="${p.inputPer1M||0}" step="0.001" min="0"></td>
    <td><input type="number" class="p-out"  value="${p.outputPer1M||0}" step="0.001" min="0"></td>
    <td><input type="text"   class="p-ccy"  value="${escapeHtml(p.currency||'USD')}" maxlength="6"></td>
    <td><button class="p-del danger" style="padding:3px 8px;">✕</button></td>
  `;
  tr.querySelector('.p-del').addEventListener('click', () => tr.remove());
  return tr;
}

function readPricing() {
  return Array.from(document.querySelectorAll('#pricing-tbody tr')).map(tr => ({
    pattern:     (tr.querySelector('.p-pat').value || '').trim(),
    inputPer1M:  Number(tr.querySelector('.p-in').value)  || 0,
    outputPer1M: Number(tr.querySelector('.p-out').value) || 0,
    currency:   (tr.querySelector('.p-ccy').value || 'USD').trim() || 'USD'
  })).filter(p => p.pattern);
}

function readHosts() {
  const mode = document.querySelector('input[name="watch-mode"]:checked').value;
  if (mode === 'all') return null;
  return document.getElementById('opt-hosts').value.split('\n')
    .map(s => s.trim()).filter(Boolean);
}

function indicateSave(msg, ok=true) {
  const el = document.getElementById('save-indicator');
  el.textContent = msg;
  el.style.color = ok ? 'var(--green)' : 'var(--red)';
  setTimeout(() => { el.textContent = ''; }, 2000);
}

// ---- init ----

document.getElementById('btn-add-row').addEventListener('click', () => {
  document.getElementById('pricing-tbody').appendChild(
    mkRow({pattern:'', inputPer1M:0, outputPer1M:0, currency:'USD'}, -1)
  );
});

document.querySelectorAll('input[name="watch-mode"]').forEach(r => {
  r.addEventListener('change', () => {
    const list = document.getElementById('watch-list').checked;
    document.getElementById('opt-hosts').disabled = !list;
  });
});

document.getElementById('btn-save').addEventListener('click', async () => {
  const next = {
    language:        document.getElementById('opt-lang').value,
    showCost:        document.getElementById('opt-show-cost').checked,
    retentionCalls:  Math.max(100, Number(document.getElementById('opt-retention').value) || 5000),
    pricing:         readPricing(),
    watchedHosts:    readHosts(),
    proxyEnabled:    document.getElementById('opt-proxy-enabled').checked,
    proxyControlUrl: (document.getElementById('opt-proxy-url').value || 'ws://127.0.0.1:17667/ws').trim()
  };
  try {
    await query('save_settings', {settings: next});
    settings = next;
    applyI18n(document.body, lang());
    indicateSave(t('btn_saved', lang()), true);
  } catch (e) {
    indicateSave(String(e.message || e), false);
  }
});

document.getElementById('btn-clear').addEventListener('click', async () => {
  if (!confirm(t('confirm_clear', lang()))) return;
  try {
    await query('clear_all');
    indicateSave('✓', true);
  } catch (e) {
    indicateSave(String(e.message || e), false);
  }
});

(async () => {
  const r = await query('get_settings');
  settings = r.settings || {};
  document.getElementById('opt-lang').value        = settings.language || 'auto';
  document.getElementById('opt-show-cost').checked = settings.showCost !== false;
  document.getElementById('opt-retention').value   = settings.retentionCalls || 5000;
  document.getElementById('opt-proxy-enabled').checked = !!settings.proxyEnabled;
  document.getElementById('opt-proxy-url').value       = settings.proxyControlUrl || 'ws://127.0.0.1:17667/ws';
  renderPricing(settings.pricing || []);
  if (Array.isArray(settings.watchedHosts) && settings.watchedHosts.length) {
    document.getElementById('watch-list').checked = true;
    document.getElementById('opt-hosts').value = settings.watchedHosts.join('\n');
    document.getElementById('opt-hosts').disabled = false;
  } else {
    document.getElementById('watch-all').checked = true;
    document.getElementById('opt-hosts').disabled = true;
  }
  applyI18n(document.body, lang());
  refreshProxyStatus();
})();

// ---- proxy status widget ----
function paintProxyStatus(status) {
  const L = lang();
  const dot  = document.getElementById('proxy-status-dot');
  const text = document.getElementById('proxy-status-text');
  if (!status) {
    dot.style.background = 'var(--text-dim)';
    text.textContent = t('proxy_state_unknown', L);
    return;
  }
  const colorMap = { open:'var(--green)', connecting:'var(--amber)', error:'var(--red)', closed:'var(--text-dim)' };
  dot.style.background = colorMap[status.state] || 'var(--text-dim)';
  let body = t('proxy_state_' + status.state, L) || status.state;
  if (status.state === 'open' && status.info && status.info.version) {
    body += '  ·  v' + status.info.version;
    if (status.info.proxyPort) body += '  ·  proxy :' + status.info.proxyPort;
  }
  if (status.state === 'error' && status.lastError) body += '  ·  ' + status.lastError;
  text.textContent = body;
}

async function refreshProxyStatus() {
  try {
    const r = await query('proxy_status');
    paintProxyStatus(r.status);
  } catch (e) {
    paintProxyStatus(null);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'ts_proxy_status') paintProxyStatus(msg.status);
});

document.getElementById('btn-proxy-test').addEventListener('click', async () => {
  const L = lang();
  const url = (document.getElementById('opt-proxy-url').value || 'ws://127.0.0.1:17667/ws').trim();
  const txt = document.getElementById('proxy-status-text');
  const dot = document.getElementById('proxy-status-dot');
  dot.style.background = 'var(--amber)';
  txt.textContent = t('proxy_testing', L);
  try {
    const r = await query('proxy_probe', { url });
    if (r.probe && r.probe.ok) {
      dot.style.background = 'var(--green)';
      const v = r.probe.info && r.probe.info.version;
      const p = r.probe.info && r.probe.info.proxyPort;
      txt.textContent = t('proxy_test_ok', L) + (v ? '  ·  v' + v : '') + (p ? '  ·  proxy :' + p : '');
    } else {
      dot.style.background = 'var(--red)';
      txt.textContent = t('proxy_test_fail', L) + '  ·  ' + (r.probe && (r.probe.error || ('HTTP ' + r.probe.status)) || '');
    }
  } catch (e) {
    dot.style.background = 'var(--red)';
    txt.textContent = t('proxy_test_fail', L) + '  ·  ' + String(e.message || e);
  }
});

document.getElementById('opt-proxy-enabled').addEventListener('change', () => {
  // no-op: takes effect on Save
});
