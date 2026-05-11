/**
 * TokenScope — service_worker.js (MV3 background)
 *
 * Receives capture events from content scripts, persists them to IndexedDB,
 * broadcasts live events to listening UI pages (popup / side panel).
 *
 * Runtime model:
 *   - Incoming: chrome.runtime.onMessage  { type: 'ts_event', payload: <hook event> }
 *   - Outgoing broadcast via chrome.runtime.sendMessage for UI listeners
 *     and chrome.storage.session for a quick "live-tab snapshot".
 */

import {
  openDB, putCall, getCall, listRecentCalls, listCallsByDay, clearAllCalls,
  bumpDailyAgg, dayKey, aggByDay, aggRange, getSettings, saveSettings,
  enforceRetention
} from '../lib/storage.js';
import { ProxyClient, probeProxy, wsToHttp } from '../lib/proxy_client.js';

// ---- one-time side-panel binding ----
chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch (e) {}
  // Kick off the proxy link (if user already enabled it in a previous session)
  refreshProxyLink().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  refreshProxyLink().catch(() => {});
});

// ---- DB singleton per-worker lifecycle ----
let _db = null;
async function db() {
  if (_db) return _db;
  _db = await openDB();
  return _db;
}

// ---- in-memory live state (lost on worker sleep, rebuilt on demand) ----
const liveCalls = new Map();          // callId -> partial record
const tabToCalls = new Map();         // tabId  -> Set<callId>

function broadcast(msg) {
  try { chrome.runtime.sendMessage(msg); } catch {}
}

function attachTab(tabId, callId) {
  if (tabId == null) return;
  let s = tabToCalls.get(tabId);
  if (!s) { s = new Set(); tabToCalls.set(tabId, s); }
  s.add(callId);
}

// ---- proxy link (desktop agent capture) ------------------------------------
let proxyClient = null;
let proxyStatus = { state: 'closed', url: null, info: null, lastError: null, updatedAt: Date.now() };

async function refreshProxyLink() {
  try {
    const d = await db();
    const s = await getSettings(d);
    const wantOn  = !!s.proxyEnabled;
    const wantUrl = (s.proxyControlUrl || 'ws://127.0.0.1:17667/ws').trim();

    // If we already have the right link, nothing to do.
    if (proxyClient && proxyClient.url === wantUrl && !proxyClient.stopped && wantOn) return;

    if (proxyClient) {
      try { proxyClient.stop(); } catch {}
      proxyClient = null;
    }
    if (!wantOn) {
      proxyStatus = { state: 'closed', url: wantUrl, info: null, lastError: null, updatedAt: Date.now() };
      broadcast({ type: 'ts_proxy_status', status: proxyStatus });
      return;
    }
    proxyClient = new ProxyClient({
      url: wantUrl,
      onEvent: (payload) => {
        // Reuse the same handler the hook events go through.
        handleHookEvent(payload, /*sender*/ null).catch(e => console.warn('[TS] proxy handler', e));
      },
      onStatus: (state, info) => {
        proxyStatus = {
          state,
          url: wantUrl,
          info: (info && (info.version || info.proxyPort)) ? info : (proxyStatus.info || null),
          lastError: state === 'error' ? (info && info.error) || 'error' : proxyStatus.lastError,
          updatedAt: Date.now()
        };
        broadcast({ type: 'ts_proxy_status', status: proxyStatus });
      }
    });
    proxyClient.start();
  } catch (e) {
    console.warn('[TS] refreshProxyLink', e);
  }
}

// ---- main event handler ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  // Capture events from hook
  if (msg.type === 'ts_event') {
    handleHookEvent(msg.payload, sender).catch(e => console.warn('[TS] handler', e));
    return;  // no async response
  }

  // Queries from UI
  if (msg.type === 'ts_query') {
    handleQuery(msg.q, msg.args).then(r => sendResponse({ ok:true, data:r }),
                                      e => sendResponse({ ok:false, err:String(e&&e.message||e) }));
    return true;  // keep channel open for async
  }

  // UI tells us to open sidepanel for current tab
  if (msg.type === 'ts_open_sidepanel') {
    (async () => {
      try {
        const tab = sender && sender.tab;
        if (tab && tab.id != null) {
          await chrome.sidePanel.open({ tabId: tab.id });
          sendResponse({ ok:true });
        } else {
          const [active] = await chrome.tabs.query({active:true, currentWindow:true});
          if (active) await chrome.sidePanel.open({ tabId: active.id });
          sendResponse({ ok:true });
        }
      } catch (e) { sendResponse({ ok:false, err:String(e&&e.message||e) }); }
    })();
    return true;
  }
});

async function handleHookEvent(ev, sender) {
  if (!ev || !ev.type) return;
  const d = await db();
  const tabId = sender && sender.tab && sender.tab.id;
  const tabTitle = sender && sender.tab && sender.tab.title;

  // Respect host allowlist
  try {
    const settings = await getSettings(d);
    if (ev.origin && Array.isArray(settings.watchedHosts) && settings.watchedHosts.length) {
      const ok = settings.watchedHosts.some(h => ev.origin === h || ev.origin.endsWith('.' + h));
      if (!ok) return;
    }
  } catch {}

  if (ev.type === 'hook_ready') {
    return;  // informational
  }

  if (ev.type === 'call_start') {
    const rec = {
      callId:     ev.callId,
      url:        ev.url,
      origin:     ev.origin,
      protocol:   ev.protocol,
      model:      ev.model || null,
      streaming:  !!ev.streaming,
      inputChars: ev.inputChars || 0,
      inputEstimate: ev.inputEstimate || 0,
      status:     'active',
      startedAt:  ev.startedAt || Date.now(),
      day:        dayKey(ev.startedAt || Date.now()),
      source:     ev.source || 'browser',
      tabId, tabTitle
    };
    liveCalls.set(ev.callId, rec);
    attachTab(tabId, ev.callId);
    broadcast({ type: 'ts_live', kind: 'start', rec });
    return;
  }

  if (ev.type === 'call_end') {
    const prev = liveCalls.get(ev.callId) || {
      callId: ev.callId, startedAt: ev.endedAt - (ev.elapsedMs||0),
      day: dayKey(ev.endedAt || Date.now()), tabId, tabTitle
    };
    const usage = ev.usage || { inputTokens:0, outputTokens:0, totalTokens:0, cacheReadTokens:0, cacheWriteTokens:0 };
    const finalRec = {
      ...prev,
      model:       ev.model || prev.model || null,
      status:      (ev.status && ev.status >= 400) ? 'error' : 'done',
      httpStatus:  ev.status || null,
      errText:     ev.errText || null,
      usage,
      estimated:   !!ev.estimated,
      outputChars: ev.outputChars || 0,
      outputEstimate: ev.outputEstimate || 0,
      inputTextPreview:  (ev.inputText  || '').slice(0, 2000),
      outputTextPreview: (ev.outputText || '').slice(0, 2000),
      endedAt:     ev.endedAt || Date.now(),
      elapsedMs:   ev.elapsedMs || 0,
      source:      ev.source || prev.source || 'browser'
    };
    liveCalls.delete(ev.callId);

    // Persist
    try {
      await putCall(d, finalRec);
      if (finalRec.status === 'done' && finalRec.model) {
        await bumpDailyAgg(d, finalRec.day, finalRec.model, usage, finalRec.estimated);
      }
      // Opportunistic trim
      const settings = await getSettings(d);
      await enforceRetention(d, settings.retentionCalls || 5000);
    } catch (e) {
      console.warn('[TS] persist', e);
    }

    // Update badge
    try { await updateBadgeForTab(tabId); } catch {}

    broadcast({ type: 'ts_live', kind: 'end', rec: finalRec });
    return;
  }

  if (ev.type === 'call_error') {
    const prev = liveCalls.get(ev.callId);
    if (prev) {
      prev.status = 'error';
      prev.errText = ev.errMsg || 'error';
      prev.endedAt = ev.endedAt || Date.now();
      prev.elapsedMs = prev.endedAt - (prev.startedAt || prev.endedAt);
      liveCalls.delete(ev.callId);
      try { await putCall(d, prev); } catch {}
      broadcast({ type: 'ts_live', kind: 'end', rec: prev });
    }
  }
}

async function updateBadgeForTab(tabId) {
  if (tabId == null) return;
  const d = await db();
  const today = dayKey(Date.now());
  const rows = await listCallsByDay(d, today, 5000);
  const forTab = rows.filter(r => r.tabId === tabId);
  const n = forTab.length;
  const text = n === 0 ? '' : (n >= 1000 ? '999+' : String(n));
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#3b82f6' });
  } catch {}
}

// ---- query router (used by popup / side panel / options) ----
async function handleQuery(q, args) {
  const d = await db();
  switch (q) {
    case 'today_agg': {
      const day = dayKey(Date.now());
      const rows = await aggByDay(d, day);
      return { day, rows };
    }
    case 'range_agg': {
      const rows = await aggRange(d, (args && args.days) || 30);
      return { rows };
    }
    case 'recent_calls': {
      const rows = await listRecentCalls(d, (args && args.limit) || 200);
      return { rows };
    }
    case 'live_calls': {
      return { rows: Array.from(liveCalls.values()) };
    }
    case 'live_calls_for_tab': {
      const tabId = args && args.tabId;
      const set = tabToCalls.get(tabId);
      const rows = set ? Array.from(set).map(id => liveCalls.get(id)).filter(Boolean) : [];
      return { rows };
    }
    case 'call_detail': {
      const row = await getCall(d, args.callId);
      return { row };
    }
    case 'get_settings': {
      const s = await getSettings(d);
      return { settings: s };
    }
    case 'save_settings': {
      await saveSettings(d, args.settings || {});
      // Apply immediately in case proxy fields changed
      refreshProxyLink().catch(() => {});
      return { ok: true };
    }
    case 'proxy_status': {
      return { status: proxyStatus };
    }
    case 'proxy_probe': {
      const wsUrl = (args && args.url) || 'ws://127.0.0.1:17667/ws';
      const http = wsToHttp(wsUrl);
      const r = await probeProxy(http);
      return { probe: r, url: wsUrl, httpUrl: http };
    }
    case 'proxy_reconnect': {
      if (proxyClient) { try { proxyClient.stop(); } catch {} proxyClient = null; }
      await refreshProxyLink();
      return { ok: true, status: proxyStatus };
    }
    case 'clear_all': {
      await clearAllCalls(d);
      return { ok: true };
    }
    case 'today_summary': {
      const day = dayKey(Date.now());
      const rows = await aggByDay(d, day);
      let calls=0, inT=0, outT=0, totT=0;
      rows.forEach(r => { calls += r.calls; inT += r.inputTokens; outT += r.outputTokens; totT += r.totalTokens; });
      return { day, calls, inputTokens:inT, outputTokens:outT, totalTokens:totT, models: rows };
    }
    default:
      throw new Error('unknown query: ' + q);
  }
}

// ---- cleanup on tab close ----
chrome.tabs.onRemoved.addListener((tabId) => {
  const set = tabToCalls.get(tabId);
  if (set) {
    for (const id of set) liveCalls.delete(id);
    tabToCalls.delete(tabId);
  }
});
