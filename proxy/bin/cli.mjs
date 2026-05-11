#!/usr/bin/env node
/**
 * tokenscope-proxy CLI
 *
 * Usage:
 *   tokenscope-proxy                      (default ports 17666 / 17667)
 *   tokenscope-proxy --port 9999
 *   tokenscope-proxy --control-port 9998
 *   tokenscope-proxy --verbose
 *   tokenscope-proxy --host 0.0.0.0       (bind for remote agents — not recommended)
 */

import { start, VERSION } from '../src/index.mjs';

function parseArgs(argv) {
  const out = { verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--port' || a === '-p')        out.proxyPort   = Number(argv[++i]);
    else if (a === '--control-port')              out.controlPort = Number(argv[++i]);
    else if (a === '--host')                      out.host        = argv[++i];
    else if (a === '--retention')                 out.retention   = Number(argv[++i]);
    else if (a === '--version' || a === '-V')     { console.log(VERSION); process.exit(0); }
    else if (a === '--help' || a === '-h') {
      console.log(`tokenscope-proxy v${VERSION}

Usage: tokenscope-proxy [options]

Options:
  -p, --port <n>         Proxy port    (default 17666)
      --control-port <n> Control+WS    (default 17667)
      --host <addr>      Bind address  (default 127.0.0.1)
      --retention <n>    Max local records kept (default 5000)
  -v, --verbose          Log every call
  -V, --version          Print version
  -h, --help             Show this help

Environment:
  TOKENSCOPE_PROXY_PORT             override --port
  TOKENSCOPE_CONTROL_PORT           override --control-port
  TOKENSCOPE_UPSTREAM_OPENAI        default openai upstream (https://api.openai.com)
  TOKENSCOPE_UPSTREAM_ANTHROPIC     default anthropic upstream (https://api.anthropic.com)
  TOKENSCOPE_UPSTREAM_GEMINI        default gemini upstream
`);
      process.exit(0);
    }
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));

start(opts).then((srv) => {
  const shutdown = async () => {
    console.log('\n[TS-proxy] shutting down…');
    try { await srv.stop(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
}).catch(err => {
  console.error('[TS-proxy] fatal:', err);
  process.exit(1);
});
