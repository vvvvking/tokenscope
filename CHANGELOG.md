# Changelog

All notable changes to TokenScope will be documented in this file.

## [0.2.0] - 2026-05-11

### Added
- **Desktop agent capture via `tokenscope-proxy`** (new companion npm package).
  Run `npx tokenscope-proxy`, point any desktop LLM client (Claude Code,
  Cursor, Cline, OpenClaw, Python / Node SDKs, curl) at
  `http://127.0.0.1:17666`, and its traffic shows up in the extension
  alongside browser calls. Loopback-only, zero config, API keys are forwarded
  byte-for-byte and never stored.
- Extension service worker now maintains a resilient WebSocket link to the
  local proxy (auto-reconnect with exponential backoff, app-level keepalive).
- Settings page: new **Desktop Agent Proxy** section with an enable toggle,
  WebSocket URL field, **Test** button, and live connection status indicator.
- Records now carry a `source` field (`browser` / `proxy`) so desktop and web
  traffic can be distinguished in history and exports.

## [0.1.0] - 2026-05-06

### Added
- Initial public release.
- Real-time interception of LLM API calls via page-world `fetch` / `XMLHttpRequest` patching.
- SSE stream parsing for OpenAI-compatible, Anthropic, and Gemini protocols.
- Automatic token-count capture when providers return `usage` metadata.
- Heuristic fallback estimator for providers that omit `usage`.
- Popup UI with today's aggregates and live call indicator.
- Side Panel with Live / Today / History / Models tabs and per-call detail drawer.
- Options page with user-defined pricing table, host allowlist, retention limit, and language (EN / 中文 / auto).
- JSON and CSV export from both popup and side panel.
- 100% local storage (IndexedDB); no network or telemetry.
