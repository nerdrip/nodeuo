// Preload — exposes a tiny API to the renderer via contextBridge so we can
// keep the renderer sandboxed. No node.js access from the renderer side.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('uo', {
  defaults:     () => ipcRenderer.invoke('defaults'),
  listServices: () => ipcRenderer.invoke('list-services'),
  startService: (id, envOverride, options) => ipcRenderer.invoke('start-service', { id, envOverride, options }),
  stopService:  (id) => ipcRenderer.invoke('stop-service', { id }),
  stopAll:      () => ipcRenderer.invoke('stop-all'),
  killPort:     (port) => ipcRenderer.invoke('kill-port', { port }),
  openUrl:      (url) => ipcRenderer.invoke('open-url', { url }),
  chooseDirectory: (defaultPath) => ipcRenderer.invoke('choose-directory', { defaultPath }),
  onLog:        (cb) => ipcRenderer.on('service:log',   (_e, p) => cb(p)),
  onState:      (cb) => ipcRenderer.on('service:state', (_e, p) => cb(p)),
});
