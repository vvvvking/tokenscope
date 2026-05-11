/**
 * TokenScope Desktop — Electron main process.
 *
 * Runs a tray-resident app that:
 *   • embeds the TokenScope proxy (proxy-embed/index.mjs) in-process
 *   • shows a dashboard window on demand
 *   • exposes IPC so the renderer can read records / settings live
 *
 * No external Node.js required: Electron ships its own runtime.
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, dialog } =
  require('electron');
const path = require('node:path');
const fs   = require('node:fs');
const { pathToFileURL } = require('node:url');

// ─── single-instance lock ───────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ─── paths & settings ───────────────────────────────────────────────────────
const USER_DIR      = app.getPath('userData');
const SETTINGS_FILE = path.join(USER_DIR, 'settings.json');
const RECORDS_DIR   = path.join(USER_DIR, 'records');  // proxy NDJSON lives here

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {
      proxyPort:   17666,
      controlPort: 17667,
      retention:   5000,
      autoStart:   true,      // auto-start proxy on app launch
      launchAtLogin: false,
      defaultUpstream: 'openai',  // preset key for the OpenAI protocol
      firstRunDone:  false
    };
  }
}
function saveSettings(patch) {
  const cur = loadSettings();
  const next = { ...cur, ...patch };
  fs.mkdirSync(USER_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}

// ─── tray icon (16×16 PNG encoded inline so we don't need a binary asset) ───
// A tiny dark-blue square — good enough as a placeholder on all platforms.
const TRAY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAQklEQVR42mNkQAX/GfAAJgYi' +
  'wagGRjQFjMQowKuIEd0EnAqJdQIRCokOByJCAbuTiFFAdDCShgY1EOuEUQ2MxKgBAMhZBaS7' +
  'KcLMAAAAAElFTkSuQmCC';

function buildTrayIcon() {
  try {
    return nativeImage.createFromBuffer(Buffer.from(TRAY_PNG_BASE64, 'base64'));
  } catch {
    return nativeImage.createEmpty();
  }
}

// ─── embedded proxy lifecycle ───────────────────────────────────────────────
let proxyHandle = null;          // whatever proxy-embed/index.mjs:start() resolves to
let proxyState  = 'stopped';     // 'stopped' | 'starting' | 'running' | 'error'
let proxyError  = null;
const proxyListeners = new Set();  // renderer webContents to push live events to

function emitStatus() {
  const payload = getStatusSync();
  for (const wc of proxyListeners) {
    if (!wc.isDestroyed()) {
      try { wc.send('ts:status', payload); } catch {}
    }
  }
}

function getStatusSync() {
  const s = loadSettings();
  return {
    state: proxyState,
    error: proxyError,
    proxyPort:   proxyHandle ? proxyHandle.proxyPort   : s.proxyPort,
    controlPort: proxyHandle ? proxyHandle.controlPort : s.controlPort,
    host:        proxyHandle ? proxyHandle.host        : '127.0.0.1',
    recordsFile: proxyHandle ? proxyHandle.store.file  : null,
    version:     app.getVersion()
  };
}

async function startProxy() {
  if (proxyState === 'running' || proxyState === 'starting') return getStatusSync();
  proxyState = 'starting';
  proxyError = null;
  emitStatus();
  try {
    const modUrl = pathToFileURL(path.join(__dirname, 'proxy-embed', 'index.mjs')).href;
    const mod = await import(modUrl);
    const s = loadSettings();
    fs.mkdirSync(RECORDS_DIR, { recursive: true });
    proxyHandle = await mod.start({
      proxyPort:   s.proxyPort,
      controlPort: s.controlPort,
      retention:   s.retention,
      storeDir:    RECORDS_DIR,
      upstreams:   { openai: s.defaultUpstream || 'openai' },
      verbose:     !!process.env.TOKENSCOPE_VERBOSE
    });
    // forward proxy events to all subscribed renderers
    proxyHandle.onRecord((kind, rec) => {
      for (const wc of proxyListeners) {
        if (!wc.isDestroyed()) {
          try { wc.send('ts:record', { kind, rec }); } catch {}
        }
      }
    });
    proxyState = 'running';
    proxyError = null;
  } catch (e) {
    proxyState = 'error';
    proxyError = String(e && e.message || e);
    proxyHandle = null;
  }
  emitStatus();
  rebuildTrayMenu();
  return getStatusSync();
}

async function stopProxy() {
  if (!proxyHandle) { proxyState = 'stopped'; emitStatus(); return getStatusSync(); }
  try { await proxyHandle.stop(); } catch {}
  proxyHandle = null;
  proxyState  = 'stopped';
  proxyError  = null;
  emitStatus();
  rebuildTrayMenu();
  return getStatusSync();
}

// ─── main window (dashboard) ────────────────────────────────────────────────
let mainWin = null;

function createMainWindow() {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.show();
    mainWin.focus();
    return mainWin;
  }
  mainWin = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth:  900,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: 'TokenScope',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox: false        // preload uses `require`
    }
  });
  Menu.setApplicationMenu(null);
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWin.once('ready-to-show', () => mainWin.show());

  // Close button → hide to tray (don't quit)
  mainWin.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      mainWin.hide();
    }
  });

  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  return mainWin;
}

// ─── tray ───────────────────────────────────────────────────────────────────
let tray = null;

function rebuildTrayMenu() {
  if (!tray) return;
  const running = proxyState === 'running';
  const s = loadSettings();
  const menu = Menu.buildFromTemplate([
    { label: `TokenScope v${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: running ? `● 代理运行中  :${proxyHandle.proxyPort}` : '○ 代理未运行',
      enabled: false },
    { label: running ? '停止代理' : '启动代理',
      click: () => running ? stopProxy() : startProxy() },
    { type: 'separator' },
    { label: '打开主界面', click: () => createMainWindow() },
    { label: '打开数据目录', click: () => shell.openPath(USER_DIR) },
    { type: 'separator' },
    { label: '开机自启',
      type: 'checkbox',
      checked: !!s.launchAtLogin,
      click: (item) => {
        saveSettings({ launchAtLogin: item.checked });
        app.setLoginItemSettings({ openAtLogin: item.checked });
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuiting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(running
    ? `TokenScope — 监听 http://127.0.0.1:${proxyHandle.proxyPort}`
    : 'TokenScope — 代理未运行');
}

function createTray() {
  tray = new Tray(buildTrayIcon());
  tray.on('click', () => createMainWindow());
  tray.on('double-click', () => createMainWindow());
  rebuildTrayMenu();
}

// ─── IPC ────────────────────────────────────────────────────────────────────
ipcMain.handle('ts:getStatus',    () => getStatusSync());
ipcMain.handle('ts:getSettings',  () => loadSettings());
ipcMain.handle('ts:saveSettings', (_e, patch) => {
  const next = saveSettings(patch);
  if (typeof patch.launchAtLogin === 'boolean') {
    app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin });
  }
  // Hot-swap upstream without restarting the proxy
  if (typeof patch.defaultUpstream === 'string' && proxyHandle && proxyHandle.setUpstream) {
    try { proxyHandle.setUpstream('openai', patch.defaultUpstream); } catch {}
  }
  return next;
});

// Expose the upstream preset catalogue to the renderer (lazy-loaded once).
let _presetsCache = null;
ipcMain.handle('ts:getUpstreamPresets', async () => {
  if (_presetsCache) return _presetsCache;
  try {
    const modUrl = pathToFileURL(path.join(__dirname, 'proxy-embed', 'server.mjs')).href;
    const m = await import(modUrl);
    _presetsCache = m.UPSTREAM_PRESETS || {};
  } catch (e) {
    _presetsCache = {};
  }
  return _presetsCache;
});
ipcMain.handle('ts:startProxy',  () => startProxy());
ipcMain.handle('ts:stopProxy',   () => stopProxy());
ipcMain.handle('ts:getRecords',  async (_e, limit = 500) => {
  if (proxyHandle && proxyHandle.store) {
    return await proxyHandle.store.list(limit);
  }
  return [];
});
ipcMain.handle('ts:clearRecords', async () => {
  if (proxyHandle && proxyHandle.store) await proxyHandle.store.clear();
  return true;
});
ipcMain.handle('ts:openExternal', (_e, url) => shell.openExternal(url));
ipcMain.handle('ts:openDataDir',  () => shell.openPath(USER_DIR));
ipcMain.handle('ts:quit',         () => { app.isQuiting = true; app.quit(); });

// Renderer-side subscription (so we push call events live)
ipcMain.on('ts:subscribe', (e) => {
  const wc = e.sender;
  proxyListeners.add(wc);
  wc.on('destroyed', () => proxyListeners.delete(wc));
});

// ─── app lifecycle ──────────────────────────────────────────────────────────
app.on('second-instance', () => createMainWindow());

app.whenReady().then(async () => {
  // Reflect persisted autoLaunch on every boot
  const s = loadSettings();
  app.setLoginItemSettings({ openAtLogin: !!s.launchAtLogin });

  createTray();

  if (s.autoStart) {
    // Fire and forget — renderer will see status via IPC when ready.
    startProxy();
  }

  // On first run, open the window so the user sees the wizard.
  if (!s.firstRunDone) {
    createMainWindow();
  } else if (process.argv.includes('--show')) {
    createMainWindow();
  }
});

app.on('window-all-closed', (e) => {
  // Don't quit when last window closes — we live in the tray.
  e.preventDefault();
});

app.on('before-quit', async () => {
  app.isQuiting = true;
  if (proxyHandle) { try { await proxyHandle.stop(); } catch {} }
});
