'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell } = require('electron');
const path    = require('node:path');
const fs      = require('node:fs');
const os      = require('node:os');
const { Poller } = require('../core/poller');
const { startLocalServer } = require('../core/localServer');

const CONFIG_FILE = path.join(os.homedir(), '.kero-print.json');
const LOG_FILE    = path.join(os.homedir(), '.kero-print.log');

function writeLogFile(line) {
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  // Manter no máximo 500 linhas
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
    if (lines.length > 500) fs.writeFileSync(LOG_FILE, lines.slice(-400).join('\n'));
  } catch {}
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

let tray   = null;
let win    = null;
let poller = null;
const logs = [];

function addLog(msg) {
  const line = `[${new Date().toLocaleTimeString('pt-BR')}] ${msg}`;
  logs.unshift(line);
  if (logs.length > 200) logs.pop();
  writeLogFile(line);
  if (win && !win.isDestroyed()) win.webContents.send('log', line);
}

function setStatus(status) {
  const labels = { running: '● Rodando', stopped: '■ Parado', error: '✕ Erro' };
  updateTrayMenu(labels[status] || status);
  if (win && !win.isDestroyed()) win.webContents.send('status', status);
}

function updateTrayMenu(statusLabel) {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Kero Pedir Print', enabled: false },
    { label: statusLabel || '–', enabled: false },
    { type: 'separator' },
    { label: 'Abrir', click: openWindow },
    { label: 'Configurações', click: openWindow },
    { label: 'Abrir arquivo de log', click: () => shell.openPath(LOG_FILE) },
    { type: 'separator' },
    { label: 'Sair', click: () => { poller && poller.stop(); app.quit(); } },
  ]));
}

function openWindow() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }

  const preloadPath = path.join(__dirname, 'preload.js');
  const htmlPath    = path.join(__dirname, 'ui', 'index.html');

  win = new BrowserWindow({
    width: 560, height: 580,
    resizable: false,
    center: true,
    title: 'Kero Pedir Print',
    show: false,   // aguarda 'ready-to-show' para evitar flash branco
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setMenu(null);

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  win.webContents.on('did-fail-load', (_, code, desc) => {
    addLog(`Erro ao carregar janela: ${desc} (${code})`);
    // Fallback: tentar carregar via URL de arquivo
    win.loadURL('file://' + htmlPath.replace(/\\/g, '/'));
  });

  win.webContents.on('before-input-event', (_, input) => {
    if (input.control && input.shift && input.key === 'I') {
      win.webContents.isDevToolsOpened() ? win.webContents.closeDevTools() : win.webContents.openDevTools();
    }
  });

  win.on('close', e => { e.preventDefault(); win.hide(); });
  win.on('closed', () => { win = null; });

  win.loadFile(htmlPath).catch(err => {
    addLog(`loadFile falhou: ${err.message}`);
  });
}

ipcMain.handle('get-log-path', () => LOG_FILE);
ipcMain.handle('open-log',    () => shell.openPath(LOG_FILE));
ipcMain.handle('get-config',  () => loadConfig());
ipcMain.handle('get-logs',   () => logs);
ipcMain.handle('get-status', () => (poller && poller._running) ? 'running' : 'stopped');

ipcMain.handle('save-config', (_, cfg) => {
  saveConfig(cfg);
  if (poller) {
    poller.updateConfig(cfg);
    if (!poller._running) poller.start();
  } else {
    startPoller(cfg);
  }
  return { ok: true };
});

ipcMain.handle('restart', () => {
  const cfg = loadConfig();
  if (poller) { poller.stop(); poller = null; }
  startPoller(cfg);
  return { ok: true };
});

ipcMain.handle('open-external', (_, url) => shell.openExternal(url));

let localServer = null;

function startPoller(cfg) {
  if (!cfg.url || !cfg.token) {
    addLog('Configure URL e Token para iniciar.');
    setStatus('stopped');
    return;
  }
  poller = new Poller({ cfg, onLog: addLog, onStatus: setStatus });
  poller.start();

  // Servidor local para o PDV imprimir diretamente (sem QZ Tray)
  if (!localServer) {
    localServer = startLocalServer({
      onLog:       addLog,
      getStations: () => poller._stations || [],
      getCatMap:   () => poller._catMap   || {},
    });
  }
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.keropedir.print-agent');

  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  const icon     = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip('Kero Pedir Print — clique para abrir');
  tray.on('click', openWindow);
  tray.on('double-click', openWindow);
  updateTrayMenu('● Iniciando...');

  const cfg = loadConfig();
  openWindow();
  if (!cfg.url || !cfg.token) {
    addLog('Bem-vindo! Configure URL e Token para começar.');
    setStatus('stopped');
  } else {
    startPoller(cfg);
  }
});

app.on('window-all-closed', () => { /* manter na bandeja */ });
app.on('activate', openWindow);
