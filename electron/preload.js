'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kero', {
  getConfig:    ()    => ipcRenderer.invoke('get-config'),
  saveConfig:   (cfg) => ipcRenderer.invoke('save-config', cfg),
  getLogs:      ()    => ipcRenderer.invoke('get-logs'),
  getStatus:    ()    => ipcRenderer.invoke('get-status'),
  restart:      ()    => ipcRenderer.invoke('restart'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onLog:        (fn)  => ipcRenderer.on('log',     (_, v) => fn(v)),
  onStatus:     (fn)  => ipcRenderer.on('status',  (_, v) => fn(v)),
  onPreview:    (fn)  => ipcRenderer.on('preview', (_, v) => fn(v)),
  getPreviews:  ()    => ipcRenderer.invoke('get-previews'),
  getLogPath:   ()    => ipcRenderer.invoke('get-log-path'),
  openLog:      ()    => ipcRenderer.invoke('open-log'),

  // WhatsApp
  waGetStatus:    ()          => ipcRenderer.invoke('wa-get-status'),
  waGetTemplates: ()          => ipcRenderer.invoke('wa-get-templates'),
  waSaveTemplates:(templates) => ipcRenderer.invoke('wa-save-templates', templates),
  waShowWindow:   ()          => ipcRenderer.invoke('wa-show-window'),
  waHideWindow:   ()          => ipcRenderer.invoke('wa-hide-window'),
  waTestSend:     (args)      => ipcRenderer.invoke('wa-test-send', args),
  onWaStatus:     (fn)        => ipcRenderer.on('wa-status', (_, v) => fn(v)),

  // Auto-update
  onUpdateAvailable: (fn) => ipcRenderer.on('update-available', (_, v) => fn(v)),
  onUpdateDownloaded:(fn) => ipcRenderer.on('update-downloaded', (_, v) => fn(v)),
  updateInstallNow:  ()   => ipcRenderer.invoke('update-install-now'),
});
