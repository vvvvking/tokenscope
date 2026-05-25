<div align="center">

# 🔍 TokenScope

**Real-time, privacy-first monitoring of your LLM API usage**
**在你正常使用大模型时，实时看见每一次调用消耗的 token**

[English](#english) · [中文](#中文) · [MIT License](LICENSE)

<a href="https://www.producthunt.com/posts/tokenscope?utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-tokenscope" target="_blank"><img src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=tokenscope&theme=light" alt="TokenScope - Real-time, privacy-first monitoring of your LLM API usage" style="width: 250px; height: 54px;" width="250" height="54" /></a>

</div>

---

## English

TokenScope is a lightweight Chrome / Edge extension that quietly watches the LLM API calls made by any tab you're on — ChatGPT, Claude.ai, Gemini, Poe, Open WebUI, your own playground, anything that speaks the OpenAI / Anthropic / Gemini protocol — and shows you in real time exactly how many tokens went in and out, for which model, on which host.

Nothing ever leaves your browser. No account. No telemetry. No built-in price tables that go stale. You type your own rates if you want a cost column.

### ✨ Features

- **Zero configuration.** Install, open any LLM chat page, start talking. The popup lights up.
- **Protocol coverage.** OpenAI-compatible `/v1/chat/completions`, Anthropic `/v1/messages`, Google Gemini `generateContent` / `streamGenerateContent`. Works with virtually every proxy / gateway / self-hosted stack (LiteLLM, one-api, vLLM, Ollama-OpenAI, Together, Groq, OpenRouter, DeepSeek, Moonshot, Qwen, Doubao Ark, …).
- **Streams properly decoded.** SSE `data:` chunks are teed and parsed; usage is captured from the final chunk (when the provider emits it) without interfering with the page.
- **Your prices, or none.** No assumed pricing — you control the rate table. Enter once with glob patterns (`gpt-4o*`, `claude-*-sonnet-*`) and get a live cost column, or disable it entirely.
- **Detail that matters.** Click any history row for the full request URL, protocol, streaming flag, timings, HTTP status, and the first 2 KB of prompt / completion.
- **Live tab.** A spinner appears the moment a request is fired on the current page, estimated input tokens shown instantly.
- **Export everything.** JSON for full records, CSV for spreadsheets.
- **Bilingual UI.** English and 中文; auto-detects your browser language.
- **100% local.** All data lives in this browser's IndexedDB. Clear with one click anytime.

### 🚀 Install

#### From source (unpacked)

```bash
git clone https://github.com/YOUR-USERNAME/tokenscope
cd tokenscope
npm install
npm run icons          # generate PNG icons from SVG source
```

Then open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick the `src/` folder. Done.

#### From a packaged `.zip`

```bash
npm run build          # produces dist/tokenscope-<version>.zip
```

Or grab the latest zip from the [Releases](../../releases) page and drag it onto `chrome://extensions`.

### 🕶 How it works

1. A content script injects a tiny hook into every page's **main world** before any page script runs.
2. The hook monkey-patches `window.fetch` and `XMLHttpRequest`. For matching URLs it `tee()`'s the response stream so the page still gets its data byte-for-byte, while a mirror is parsed in the background.
3. The parser reads `usage` from the response JSON or from the last SSE chunk. If the provider doesn't supply `usage`, TokenScope marks the record as `~` (estimated) and counts characters as a fallback.
4. Records are forwarded to the service worker via `chrome.runtime.sendMessage`, persisted in IndexedDB, and broadcast to the popup and side panel.

**What is NOT touched:** request bodies are read for the `model` field and prompt preview; **Authorization headers and API keys are never read, logged, or stored.** The source is ~1500 lines of plain JavaScript — go read it.

### 💰 Costs (optional)

Go to **Settings** → **Pricing**. Add as many rows as you like:

| Model pattern  | Input $/1M | Output $/1M | Currency |
|----------------|-----------:|------------:|:--------:|
| `gpt-4o*`      |      2.50  |      10.00  |   USD    |
| `claude-*-sonnet-*` |  3.00 |       15.00 |   USD    |
| `deepseek-chat`|      0.14  |       0.28  |   USD    |

Patterns are glob: `*` matches anything. Longest-matching pattern wins.

### 🧩 Coverage matrix

| Kind | Protocol | Typical hosts |
|---|---|---|
| OpenAI-compat | `/v1/chat/completions` | ChatGPT, Azure OpenAI, DeepSeek, Moonshot, Qwen, Doubao Ark, Together, Groq, OpenRouter, your LiteLLM / one-api gateway |
| Anthropic     | `/v1/messages`         | Claude.ai, Claude API directly |
| Gemini        | `*:generateContent`, `*:streamGenerateContent` | Google AI Studio, Vertex AI |
| Legacy OpenAI | `/v1/completions`      | Older SDKs |

Open an issue if your favourite provider isn't detected — a single regex is usually all it takes.

### 🖥️ Desktop agents (Claude Code / Cursor / Cline / OpenClaw / SDKs)

Browser extensions can only see traffic that goes through the browser. Desktop
agents talk to providers directly from their own process, so we ship a
companion: [`tokenscope-proxy`](proxy/README.md) — a tiny local HTTP proxy
you run once:

```bash
npx tokenscope-proxy
```

Point your agent / SDK at `http://127.0.0.1:17666` (e.g.
`ANTHROPIC_BASE_URL` for Claude Code, `OPENAI_BASE_URL` for any OpenAI SDK,
base URL for Cursor / Cline / Continue) and everything it does shows up in
the extension alongside your browser traffic — same Live view, same
history, same exports. Loopback-only, zero config, API keys are forwarded
byte-for-byte and never stored. See [proxy/README.md](proxy/README.md) for the
full guide.

### 🛠 Project layout

```
src/
├── manifest.json
├── background/service_worker.js    # persistence, live broadcast
├── content/
│   ├── content_bridge.js           # ISOLATED world — injection + relay
│   └── inject_hook.js              # MAIN world — fetch/XHR patch + SSE parser
├── lib/
│   ├── providers.js                # shared parsing helpers
│   ├── storage.js                  # IndexedDB wrapper
│   └── i18n.js                     # EN + 中文 strings
├── popup/      popup.html + popup.js
├── sidepanel/  sidepanel.html + sidepanel.js
├── options/    options.html + options.js
├── ui/theme.css
└── icons/icon.svg
scripts/
├── gen-icons.mjs    # SVG → PNG
└── build.mjs        # produce a Chrome Web Store zip
```

### 🤝 Contributing

Issues, PRs, protocol additions — all welcome. Keep it small, keep it private-by-default.

### 📄 License

[MIT](LICENSE) © TokenScope contributors

---

### 🌐 Powered by NovAI

TokenScope is proudly built by the [NovAI](https://aiapi-pro.com) team.

**NovAI** provides a unified AI API gateway — one key, all major models (GPT-4o, Claude, Gemini, DeepSeek, Qwen, and more), with a generous free tier and transparent pay-as-you-go pricing.

👉 **[Try NovAI Free →](https://aiapi-pro.com)**

---

## 中文

TokenScope 是一个轻量级的 Chrome / Edge 浏览器扩展。它在后台静静监听你打开的任何网页发起的大模型 API 调用 —— ChatGPT、Claude.ai、Gemini、Poe、Open WebUI、你自部署的 playground，只要符合 OpenAI / Anthropic / Gemini 协议，全都能看到 —— 并实时告诉你每次调用消耗了多少 token、用的哪个模型、来自哪个站点。

**数据永远不离开你的浏览器。** 无需登录、无上报、无内置价格表（那种东西一个月就过期）。如果你想看费用，自己在设置里填入单价，一切尽在掌控。

### ✨ 功能

- **零配置。** 装上，打开任意大模型网页，正常聊天，图标上的小气泡就亮了。
- **协议覆盖全。** OpenAI 兼容 `/v1/chat/completions`、Anthropic `/v1/messages`、Google Gemini `generateContent` / `streamGenerateContent`。几乎覆盖所有主流代理和自部署方案（LiteLLM、one-api、vLLM、Ollama-OpenAI、Together、Groq、OpenRouter、DeepSeek、Moonshot、Qwen、豆包 Ark……）。
- **流式响应正确解析。** 把 SSE 响应体做 `tee()` 分叉，页面依然逐字节拿到数据，我们在镜像侧解析 usage chunk，不影响原站点。
- **要成本自己填。** 绝不假设任何价格。你自己填模式（支持通配符 `gpt-4o*`、`claude-*-sonnet-*`），费用列即刻出现；不想看就关掉。
- **详情都给你。** 历史列表点任何一行，查看完整请求 URL、协议、流式标记、耗时、HTTP 状态、以及 prompt / completion 的前 2 KB 预览。
- **实时指示。** 当前页面一发起调用，小转圈就出现，输入 token 估算值立即显示。
- **一键导出。** JSON 保留全部字段，CSV 可直接用 Excel 打开。
- **中英双语。** 中文 / English / 自动（跟随浏览器）。
- **100% 本地。** 所有数据都在 IndexedDB 里，任何时候都能一键清空。

### 🚀 安装

#### 从源码加载

```bash
git clone https://github.com/YOUR-USERNAME/tokenscope
cd tokenscope
npm install
npm run icons          # 从 SVG 源生成 PNG 图标
```

打开 `chrome://extensions` → 打开**开发者模式** → **加载已解压的扩展程序** → 选择 `src/` 目录，完成。

#### 打包 `.zip`

```bash
npm run build          # 产物：dist/tokenscope-<version>.zip
```

或从 [Releases](../../releases) 页面直接下载最新 zip，拖入 `chrome://extensions` 即可。

### 🕶 工作原理

1. Content script 在页面脚本之前，把一个极小的 hook 注入到每个页面的 **main world**。
2. Hook 劫持 `window.fetch` 与 `XMLHttpRequest`。匹配到 LLM URL 时，对响应流做 `tee()` 分叉：主流原样送给页面，镜像交给后台解析。
3. 解析器从 JSON 响应或 SSE 最后一个 chunk 读 `usage`。若供应商没给，TokenScope 给记录打上 `~`（估算）标记，按字符数退化估算。
4. 记录通过 `chrome.runtime.sendMessage` 发给 service worker，持久化到 IndexedDB，同时广播给 popup 和 side panel。

**什么不会被读取：** 我们从请求体里读 `model` 字段和 prompt 预览；**Authorization 头和 API key 从不被读取、记录或存储。** 源码只有约 1500 行纯 JavaScript — 欢迎审查。

### 💰 费用（可选）

**设置** → **单价**。想加多少行就加多少行：

| 模型匹配模式 | 输入 $/1M | 输出 $/1M | 币种 |
|---|---:|---:|:-:|
| `gpt-4o*`           | 2.50 | 10.00 | USD |
| `claude-*-sonnet-*` | 3.00 | 15.00 | USD |
| `deepseek-chat`     | 0.14 |  0.28 | USD |

模式支持通配符 `*`，匹配最长者胜出。

### 🧩 协议覆盖

| 类别 | 协议 | 典型站点 |
|---|---|---|
| OpenAI 兼容 | `/v1/chat/completions` | ChatGPT、Azure OpenAI、DeepSeek、Moonshot、Qwen、豆包 Ark、Together、Groq、OpenRouter、自部署 LiteLLM / one-api 网关 |
| Anthropic | `/v1/messages` | Claude.ai、Claude API 直连 |
| Gemini | `*:generateContent`、`*:streamGenerateContent` | Google AI Studio、Vertex AI |
| OpenAI Legacy | `/v1/completions` | 老 SDK |

如果你常用的供应商没被识别，提个 issue —— 通常只需要加一条正则。

### 🖥️ 桌面端 Agent（Claude Code / Cursor / Cline / OpenClaw / SDK）

浏览器扩展只能看到走浏览器的流量。桌面端 Agent 是从自己进程直连大模型服务商的，所以我们额外提供一个小伙伴：
[`tokenscope-proxy`](proxy/README.md) — 一个本地 HTTP 代理，一句命令跑起来：

```bash
npx tokenscope-proxy
```

把你的 Agent / SDK 的 BASE URL 改成 `http://127.0.0.1:17666`（例如
Claude Code 设 `ANTHROPIC_BASE_URL`、OpenAI SDK 设 `OPENAI_BASE_URL`、
Cursor / Cline / Continue 在界面里改 Base URL），所有调用就会和浏览器流量一起出现在扩展里——同一个 实时 视图、同一份历史、同一键导出。仅监听本机，零配置，API Key 逐字节透传不落地。详见 [proxy/README.md](proxy/README.md)。

### 🤝 贡献

Issues、PR、新协议支持，都欢迎。原则：保持小巧，默认隐私优先。

### 📄 许可

[MIT](LICENSE) © TokenScope contributors

---

### 🌐 由 NovAI 驱动

TokenScope 由 [NovAI](https://aiapi-pro.com) 团队倾力打造。

**NovAI** 提供统一 AI API 网关 —— 一个 Key 调用所有主流大模型（GPT-4o、Claude、Gemini、DeepSeek、通义千问等），拥有慷慨免费额度和透明的按量计费。

👉 **[免费体验 NovAI →](https://aiapi-pro.com)**
