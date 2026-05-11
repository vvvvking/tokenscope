/**
 * TokenScope — content_bridge.js (ISOLATED world)
 *
 * Runs inside the page's isolated world. Responsibilities:
 *   1. Inject inject_hook.js into the page's MAIN world at document_start,
 *      so we can patch fetch / XHR before any user script runs.
 *   2. Relay window.postMessage events from the hook to the extension
 *      background service worker via chrome.runtime.sendMessage.
 *
 * No sensitive data crosses this boundary: the hook already strips keys.
 */

(function () {
  try {
    // 1) inject main-world hook
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('content/inject_hook.js');
    s.async = false;
    s.onload = function () { this.remove(); };
    (document.head || document.documentElement).prepend(s);
  } catch (e) {
    // injection may fail on some pages (e.g. chrome://) — that's fine
  }

  // 2) bridge postMessage -> background
  window.addEventListener('message', function (ev) {
    if (!ev || ev.source !== window) return;
    const d = ev.data;
    if (!d || !d.__tokenscope || !d.payload) return;
    try {
      chrome.runtime.sendMessage({ type: 'ts_event', payload: d.payload });
    } catch (err) {
      // extension context invalidated (e.g. reload) — safe to ignore
    }
  }, false);
})();
