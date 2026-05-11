/**
 * TokenScope Desktop — preload.
 * Exposes a tiny, typed API to the renderer via contextBridge.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ts', {
  // status + control
  getStatus:    () => ipcRenderer.invoke('ts:getStatus'),
  startProxy:   () => ipcRenderer.invoke('ts:startProxy'),
  stopProxy:    () => ipcRenderer.invoke('ts:stopProxy'),

  // settings
  getSettings:  () => ipcRenderer.invoke('ts:getSettings'),
  saveSettings: (patch) => ipcRenderer.invoke('ts:saveSettings', patch),
  getUpstreamPresets: () => ipcRenderer.invoke('ts:getUpstreamPresets'),

  // records
  getRecords:   (limit) => ipcRenderer.invoke('ts:getRecords', limit),
  clearRecords: () => ipcRenderer.invoke('ts:clearRecords'),

  // misc
  openExternal: (url) => ipcRenderer.invoke('ts:openExternal', url),
  openDataDir:  () => ipcRenderer.invoke('ts:openDataDir'),
  quit:         () => ipcRenderer.invoke('ts:quit'),

  // live subscriptions
  subscribe: (onRecord, onStatus) => {
    ipcRenderer.send('ts:subscribe');
    const r = (_e, msg) => { try { onRecord && onRecord(msg); } catch {} };
    const s = (_e, msg) => { try { onStatus && onStatus(msg); } catch {} };
    ipcRenderer.on('ts:record', r);
    ipcRenderer.on('ts:status', s);
    return () => {
      ipcRenderer.removeListener('ts:record', r);
      ipcRenderer.removeListener('ts:status', s);
    };
  }
});
