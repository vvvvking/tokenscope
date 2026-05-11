<div align="center">

# 🔍 tokenscope-proxy

**Local HTTP proxy that captures LLM token usage from any desktop agent**
**用一条 npx 命令，把本机任何 Agent / SDK 的 token 用量接入 TokenScope**

[English](#english) · [中文](#中文) · [MIT License](../LICENSE)

</div>

---

## English

`tokenscope-proxy` is a tiny Node.js program that sits between your **desktop** LLM client (Claude Code, Cursor, Cline, OpenClaw, Continue, Aider, any Python / Node SDK, curl, …) and the upstream provider. It transparently forwards every request, parses the response (including SSE streams) for token usage, stores a local history, and broadcasts live events to the TokenScope browser extension over WebSocket.

Nothing leaves your machine. The proxy listens on `127.0.0.1` only by default.

### Install & run

```bash
# one-shot
npx tokenscope-proxy

# or install globally
npm i -g tokenscope-proxy
tokenscope-proxy --verbose
```

You'll see:

```
  🔍 TokenScope Proxy
  └─ proxy   http://127.0.0.1:17666
  └─ control http://127.0.0.1:17667   ws://127.0.0.1:17667/ws
  └─ store   ~/.tokenscope/records.ndjson
```

### Point your tool at the proxy

| Tool | Environment variable |
|---|---|
| **Claude Code** | `export ANTHROPIC_BASE_URL=http://127.0.0.1:17666` |
| **Cursor / Cline / Continue** (OpenAI-compat) | set **Base URL** to `http://127.0.0.1:17666/v1` |
| **OpenAI Python/Node SDK** | `export OPENAI_BASE_URL=http://127.0.0.1:17666/v1` |
| **Anthropic SDK** | `export ANTHROPIC_BASE_URL=http://127.0.0.1:17666` |
| **Google Gemini SDK** | set `baseUrl` to `http://127.0.0.1:17666/v1beta` |
| **curl** | just swap the host: `curl http://127.0.0.1:17666/v1/chat/completions ...` |

Your API key header is forwarded untouched to the real upstream — the proxy never inspects or logs it.

### Pair with the browser extension

1. Install **TokenScope** (Chrome / Edge — see [../README.md](../README.md))
2. Open its **Settings** → scroll to **Desktop Agent Proxy**
3. Tick **Connect to local tokenscope-proxy** → click **Save**
4. The status dot turns green. Every subsequent call from your agent appears in the extension's **Live** / **Today** views alongside browser traffic.

### What it captures

| Protocol | URL pattern | Usage fields |
|---|---|---|
| OpenAI-compatible | `/v1/chat/completions`, `/v1/completions`, `/v1/responses` | `prompt_tokens`, `completion_tokens`, `total_tokens`, `prompt_tokens_details.cached_tokens` |
| Anthropic (native) | `/v1/messages` | `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` |
| Google Gemini | `/v1beta/models/*:*generateContent` | `promptTokenCount`, `candidatesTokenCount`, `totalTokenCount` |

If upstream omits `usage` (rare — only happens with a few self-hosted gateways), TokenScope falls back to a length-based heuristic and marks the record with `estimated:true`.

### CLI reference

```
Usage: tokenscope-proxy [options]

Options:
  -p, --port <n>         Proxy port    (default 17666)
      --control-port <n> Control+WS    (default 17667)
      --host <addr>      Bind address  (default 127.0.0.1)
      --retention <n>    Max local records kept (default 5000)
  -v, --verbose          Log every call
  -V, --version          Print version
  -h, --help             Show this help
```

Environment overrides:

- `TOKENSCOPE_PROXY_PORT`, `TOKENSCOPE_CONTROL_PORT`
- `TOKENSCOPE_UPSTREAM_OPENAI`  (default `https://api.openai.com`)
- `TOKENSCOPE_UPSTREAM_ANTHROPIC` (default `https://api.anthropic.com`)
- `TOKENSCOPE_UPSTREAM_GEMINI` (default `https://generativelanguage.googleapis.com`)

### Control HTTP API (used by the extension, also useful for scripting)

```
GET  http://127.0.0.1:17667/info      { ok, service, version, proxyPort, records:{count, firstAt, lastAt} }
GET  http://127.0.0.1:17667/records?limit=500
POST http://127.0.0.1:17667/clear
WS   ws://127.0.0.1:17667/ws          live {kind:'start'|'end', rec:...}
```

### Storage

- Path: `~/.tokenscope/records.ndjson` (one JSON record per line)
- Ring-buffered to `--retention` entries
- No indexes, no DB — just jq-friendly text

```bash
# count your calls per model
jq -r '.model' ~/.tokenscope/records.ndjson | sort | uniq -c | sort -rn
```

### Privacy & security

- Loopback only. Never bind to `0.0.0.0` unless you fully trust your LAN.
- API keys are forwarded byte-for-byte. They're **never** stored in the local history.
- Request/response **text previews** (first 2 KB of each) **are** stored so you can audit which prompt / model you used. Delete at any time from the extension or by removing the NDJSON file.
- No telemetry. The proxy makes no outbound connections other than to the upstream providers you direct it to.

### Requirements

- Node.js ≥ 18.17 (native `fetch` + `ReadableStream`)

---

## 中文

`tokenscope-proxy` 是一个运行在你本机的小型 Node.js 代理。它位于你的 **桌面 LLM 客户端**（Claude Code、Cursor、Cline、OpenClaw、Continue、Aider，或任何 Python / Node SDK、curl…）和真正的大模型服务商之间：

- 透明转发每一次请求（连 API Key 都不看一眼就原样传过去）
- 解析响应（包括 SSE 流式）提取 token 用量
- 本地 NDJSON 保存历史
- 通过 WebSocket 推送实时事件给 TokenScope 浏览器扩展

所有数据都留在本机，默认只监听 `127.0.0.1`。

### 安装运行

```bash
# 随用随跑
npx tokenscope-proxy

# 或全局安装
npm i -g tokenscope-proxy
tokenscope-proxy --verbose
```

启动后输出：

```
  🔍 TokenScope Proxy
  └─ proxy   http://127.0.0.1:17666
  └─ control http://127.0.0.1:17667   ws://127.0.0.1:17667/ws
  └─ store   ~/.tokenscope/records.ndjson
```

### 把你的工具指向代理

| 工具 | 环境变量 |
|---|---|
| **Claude Code** | `export ANTHROPIC_BASE_URL=http://127.0.0.1:17666` |
| **Cursor / Cline / Continue**（OpenAI 兼容） | 设置 **Base URL** 为 `http://127.0.0.1:17666/v1` |
| **OpenAI Python/Node SDK** | `export OPENAI_BASE_URL=http://127.0.0.1:17666/v1` |
| **Anthropic SDK** | `export ANTHROPIC_BASE_URL=http://127.0.0.1:17666` |
| **Google Gemini SDK** | 把 `baseUrl` 改为 `http://127.0.0.1:17666/v1beta` |
| **curl** | 直接把 host 改掉：`curl http://127.0.0.1:17666/v1/chat/completions ...` |

API Key 仍然由你自己的工具头部携带，代理只负责原样转发，不读取、不存储。

### 配合浏览器扩展使用

1. 安装 **TokenScope**（Chrome / Edge，详见 [../README.md](../README.md)）
2. 打开扩展设置 → 拉到 **桌面端 Agent 代理** 这一节
3. 勾选 **连接到本地 tokenscope-proxy** → 点 **保存**
4. 状态灯变绿，此后你本机 Agent 的每一次调用都会和浏览器流量一起出现在扩展的 **实时 / 今日** 视图里

### 能捕获哪些协议

| 协议 | URL 模式 | 关键字段 |
|---|---|---|
| OpenAI 兼容 | `/v1/chat/completions`、`/v1/completions`、`/v1/responses` | `prompt_tokens` / `completion_tokens` / `total_tokens` / `prompt_tokens_details.cached_tokens` |
| Anthropic 原生 | `/v1/messages` | `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` |
| Google Gemini | `/v1beta/models/*:*generateContent` | `promptTokenCount` / `candidatesTokenCount` / `totalTokenCount` |

遇到极少数不返回 `usage` 的自部署网关，会用长度估算兜底，记录上标记 `estimated:true`，不虚报。

### 命令行参数

```
用法: tokenscope-proxy [options]

选项:
  -p, --port <n>         转发端口        (默认 17666)
      --control-port <n> 控制+WS 端口    (默认 17667)
      --host <addr>      绑定地址        (默认 127.0.0.1)
      --retention <n>    本地最多保留条数 (默认 5000)
  -v, --verbose          打印每次调用
  -V, --version          打印版本
  -h, --help             帮助
```

环境变量同名可覆盖，另外三个上游端点也可替换：

- `TOKENSCOPE_UPSTREAM_OPENAI`（默认 `https://api.openai.com`）
- `TOKENSCOPE_UPSTREAM_ANTHROPIC`（默认 `https://api.anthropic.com`）
- `TOKENSCOPE_UPSTREAM_GEMINI`（默认 `https://generativelanguage.googleapis.com`）

### 控制接口（给扩展用，也方便你脚本化）

```
GET  http://127.0.0.1:17667/info
GET  http://127.0.0.1:17667/records?limit=500
POST http://127.0.0.1:17667/clear
WS   ws://127.0.0.1:17667/ws
```

### 本地存储

- 路径：`~/.tokenscope/records.ndjson`（每行一条 JSON）
- 环形缓冲，超过 `--retention` 自动丢掉最老的
- 没有任何数据库，`jq` 直接能查：

```bash
# 按模型统计调用次数
jq -r '.model' ~/.tokenscope/records.ndjson | sort | uniq -c | sort -rn
```

### 隐私与安全

- 默认仅绑定 loopback；除非你完全信任局域网，否则不要 `--host 0.0.0.0`
- API Key 字节不落地：只做转发，永不写入历史
- 每次调用的请求/响应会保存前 2 KB 文本预览（便于你事后审计用了什么 prompt / 模型），可一键清空
- 零遥测，代理只会连接你显式指定的上游大模型服务商

### 环境要求

- Node.js ≥ 18.17（需要原生 `fetch` 与 `ReadableStream`）
