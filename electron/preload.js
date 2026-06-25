'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kero', {
  getConfig:    ()    => ipcRenderer.invoke('get-config'),
  saveConfig:   (cfg) => ipcRenderer.invoke('save-config', cfg),
  getLogs:      ()    => ipcRenderer.invoke('get-logs'),
  getStatus:    ()    => ipcRenderer.invoke('get-status'),
  restart:      ()    => ipcRenderer.invoke('restart'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onLog:        (fn)  => ipcRenderer.on('log',    (_, v) => fn(v)),
  onStatus:     (fn)  => ipcRenderer.on('status', (_, v) => fn(v)),
  getLogPath:   ()    => ipcRenderer.invoke('get-log-path'),
  openLog:      ()    => ipcRenderer.invoke('open-log'),
});
