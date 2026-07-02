'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell } = require('electron');
const path    = require('node:path');
const fs      = require('node:fs');
const os      = require('node:os');
const { autoUpdater } = require('electron-updater');
const { Poller }           = require('../core/poller');
const { startLocalServer } = require('../core/localServer');
const { WhatsAppSender }   = require('../core/whatsappSender');
const { WhatsAppPoller, DEFAULT_TEMPLATES } = require('../core/whatsappPoller');

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

let tray          = null;
let win           = null;
let poller        = null;
let waSender      = null;
let waPoller      = null;
const logs        = [];
const previews    = [];

// ── WhatsApp helpers ─────────────────────────────────────────────────────────
function loadWaTemplates() {
  const cfg = loadConfig();
  return cfg.waTemplates ? { ...DEFAULT_TEMPLATES, ...cfg.waTemplates } : { ...DEFAULT_TEMPLATES };
}

function saveWaTemplates(templates) {
  const cfg = loadConfig();
  cfg.waTemplates = templates;
  saveConfig(cfg);
}

function sendWaStatus(s) {
  if (win && !win.isDestroyed()) win.webContents.send('wa-status', s);
}

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

function isAutoLaunchEnabled() {
  return app.getLoginItemSettings().openAtLogin;
}

function setAutoLaunch(enabled) {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true, // inicia minimizado na bandeja
  });
}

function updateTrayMenu(statusLabel) {
  if (!tray) return;
  const autoLaunch = isAutoLaunchEnabled();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Kero Pedir Print', enabled: false },
    { label: statusLabel || '–', enabled: false },
    { type: 'separator' },
    { label: 'Abrir', click: openWindow },
    { label: 'Abrir arquivo de log', click: () => shell.openPath(LOG_FILE) },
    { type: 'separator' },
    {
      label: 'Iniciar com o sistema',
      type: 'checkbox',
      checked: autoLaunch,
      click: (menuItem) => {
        setAutoLaunch(menuItem.checked);
        updateTrayMenu(statusLabel);
      },
    },
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
    width: 560, height: 1020,
    resizable: true,
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

ipcMain.handle('get-log-path',  () => LOG_FILE);
ipcMain.handle('open-log',      () => shell.openPath(LOG_FILE));
ipcMain.handle('get-config',    () => loadConfig());
ipcMain.handle('get-logs',      () => logs);
ipcMain.handle('get-status',    () => (poller && poller._running) ? 'running' : 'stopped');
ipcMain.handle('get-previews',  () => previews);

ipcMain.handle('save-config', (_, cfg) => {
  saveConfig(cfg);
  if (poller) {
    poller.updateConfig(cfg);
    if (!poller._running) poller.start();
  } else {
    startPoller(cfg);
  }
  // Iniciar waPoller se ainda não existia e agora temos config
  if (waSender && !waPoller && cfg.url && cfg.token) {
    waPoller = new WhatsAppPoller({
      cfg,
      sender:    waSender,
      templates: loadWaTemplates(),
      onLog:     addLog,
    });
    waPoller.start();
  } else if (waPoller) {
    waPoller.updateConfig(cfg);
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

// ── WhatsApp IPC ─────────────────────────────────────────────────────────────
ipcMain.handle('wa-get-status',    () => waSender ? (waSender.isReady() ? 'wa_ready' : 'wa_loading') : 'wa_off');
ipcMain.handle('wa-get-templates', () => loadWaTemplates());

ipcMain.handle('wa-save-templates', (_, templates) => {
  saveWaTemplates(templates);
  if (waPoller) waPoller.updateTemplates(templates);
  return { ok: true };
});

ipcMain.handle('wa-show-window', () => {
  if (!waSender) initWhatsApp();
  waSender.showWindow();
  return { ok: true };
});

ipcMain.handle('wa-hide-window', () => {
  waSender && waSender.hideWindow();
  return { ok: true };
});

ipcMain.handle('wa-test-send', (_, { phone, event }) => {
  if (!waSender || !waSender.isReady()) return { ok: false, reason: 'not_ready' };
  const templates = loadWaTemplates();
  const tpl = templates[event];
  if (!tpl || !tpl.enabled) return { ok: false, reason: 'template_disabled' };
  const fakeOrder = { id: '0', customer_name: 'Teste', total: '0', address: 'Endereço de teste', type: 'delivery' };
  const message   = waPoller ? waPoller._render(tpl.message, fakeOrder) : tpl.message;
  waSender.enqueue(phone, message, {});
  return { ok: true };
});

let localServer = null;

// ── Auto-update ───────────────────────────────────────────────────────────────
function initAutoUpdater() {
  // Não verifica atualizações em desenvolvimento (sem instalador)
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    addLog(`[Update] Nova versão disponível: ${info.version}`);
    if (win && !win.isDestroyed()) {
      win.webContents.send('update-available', { version: info.version });
    }
  });

  autoUpdater.on('update-downloaded', (info) => {
    addLog(`[Update] v${info.version} baixada — será instalada ao fechar`);
    if (win && !win.isDestroyed()) {
      win.webContents.send('update-downloaded', { version: info.version });
    }
  });

  autoUpdater.on('error', (err) => {
    addLog(`[Update] Erro: ${err.message}`);
  });

  // Verifica ao iniciar e depois a cada 4 horas
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}

ipcMain.handle('update-install-now', () => {
  autoUpdater.quitAndInstall(false, true);
});

function initWhatsApp() {
  if (waSender) return;
  const cfg = loadConfig();
  waSender = new WhatsAppSender({
    onLog:    addLog,
    onStatus: (s) => sendWaStatus(s),
  });
  waSender.init();

  if (cfg.url && cfg.token) {
    waPoller = new WhatsAppPoller({
      cfg,
      sender:    waSender,
      templates: loadWaTemplates(),
      onLog:     addLog,
    });
    waPoller.start();
  }
}

function startPoller(cfg) {
  if (!cfg.url || !cfg.token) {
    addLog('Configure URL e Token para iniciar.');
    setStatus('stopped');
    return;
  }
  const handlePreview = (p) => {
    previews.unshift(p);
    if (previews.length > 50) previews.pop();
    if (win && !win.isDestroyed()) win.webContents.send('preview', p);
  };

  poller = new Poller({ cfg, onLog: addLog, onStatus: setStatus, onPreview: handlePreview });
  poller.start();

  // Servidor local para o PDV imprimir diretamente (sem QZ Tray)
  if (!localServer) {
    localServer = startLocalServer({
      onLog:          addLog,
      getStations:    () => poller._stations || [],
      getCatMap:      () => poller._catMap   || {},
      ensureStations: () => poller._ensureStations(),
      onPreview:      handlePreview,
    });
  }
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.keropedir.print-agent');

  // Esconde do Dock no macOS — app vive só na bandeja
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  // Procura ícone em vários formatos/locais
  const iconCandidates = [
    path.join(__dirname, 'assets', 'icon.png'),
    path.join(__dirname, 'assets', 'icon.ico'),
    path.join(__dirname, '..', 'assets', 'agent-print.ico'),
  ];
  const iconPath = iconCandidates.find(p => fs.existsSync(p));
  const icon     = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip('Kero Pedir Print — clique para abrir');
  tray.on('click', openWindow);
  tray.on('double-click', openWindow);
  updateTrayMenu('● Iniciando...');

  const cfg = loadConfig();
  const hasConfig = !!(cfg.url && cfg.token);

  // Na primeira execução (sem config) abre a janela; depois inicia minimizado na bandeja
  if (!hasConfig) {
    addLog('Bem-vindo! Configure URL e Token para começar.');
    setStatus('stopped');
  } else {
    startPoller(cfg);
    addLog('Agente iniciado.');
  }

  openWindow();

  // WhatsApp inicia sempre (sessão é persistida — carrega em background)
  initWhatsApp();

  // Verifica atualizações (só no instalador, ignorado em npm start)
  initAutoUpdater();
});

app.on('window-all-closed', () => { /* manter na bandeja */ });
app.on('activate', openWindow); // macOS: clique no Dock (quando visível) reabre
