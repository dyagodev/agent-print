'use strict';
// electron é carregado lazy dentro de _createWindow() — não pode ser importado
// no topo do módulo antes do app.whenReady()

const WA_BASE       = 'https://web.whatsapp.com';
const SEND_TIMEOUT  = 30000;
const SEND_COOLDOWN = 2000;

// Detecta estado do WhatsApp Web (QR, pronto, carregando)
const LOGGED_IN_CHECK = `
  (function() {
    if (document.querySelector('canvas[aria-label], [data-ref]')) return 'qr';
    var readySelectors = [
      '[data-testid="chat-list-search"]',
      '[data-testid="default-user"]',
      '[aria-label="Lista de conversas"]',
      '[aria-label="Chat list"]',
      'div[role="grid"]',
      '#app header',
    ];
    if (readySelectors.some(function(s){ return !!document.querySelector(s); })) return 'ready';
    var app = document.querySelector('#app');
    if (app && app.innerHTML.length > 5000) return 'ready';
    return 'loading';
  })()
`;

// Aguarda botão de envio — ignora QR momentâneo durante reload da sessão
const POLL_SEND_SCRIPT = `
  new Promise(function(resolve) {
    var t0 = Date.now();
    var logged = false;
    var check = function() {
      // Botão de envio pronto
      if (document.querySelector('[data-testid="send"]')
       || document.querySelector('button[aria-label="Enviar"]')
       || document.querySelector('button[aria-label="Send"]')) return resolve('ready');

      // Log dos botões visíveis (só uma vez, após 4s) para diagnóstico
      if (!logged && Date.now() - t0 > 4000) {
        logged = true;
        var allBtns = Array.from(document.querySelectorAll('button, [role="button"], a[role]'))
          .map(function(b){ return (b.textContent||'').trim().slice(0,40); })
          .filter(function(t){ return t; });
        console.log('WA_POLL_BUTTONS:' + JSON.stringify(allBtns));
        console.log('WA_POLL_URL:' + location.href);
      }

      // Botão de confirmação apenas dentro de um diálogo (nunca ícones da sidebar)
      var dlg = document.querySelector('[role="dialog"]')
             || document.querySelector('[data-animate-modal-backdrop]')
             || document.querySelector('[data-testid="popup-contents"]');
      if (dlg) {
        var dlgBtns = Array.from(dlg.querySelectorAll('button, [role="button"]'));
        var cont = dlgBtns.find(function(b) {
          var t = (b.textContent || '').toLowerCase().trim();
          if (!t) return false;
          var isBad = t.includes('cancel') || t.includes('fechar') || t.includes('close')
                   || t === 'x' || t === '×';
          return !isBad && (
            t.includes('continuar') || t.includes('continue')
            || t.includes('iniciar') || t.includes('start')
            || t.includes('abrir') || t.includes('open') || t === 'ok'
          );
        });
        if (cont) {
          console.log('WA_POLL_CLICK:' + (cont.textContent||'').trim());
          cont.click();
        }
      }

      // Conta restringida pelo WhatsApp (anti-spam)
      if (document.body && document.body.innerText.includes('restringida')) {
        return resolve('account_restricted');
      }

      // Número inválido só detecta após 10s
      if (Date.now() - t0 > 10000 && document.querySelector('[data-testid="invalid-phone"]')) {
        return resolve('invalid_phone');
      }

      if (Date.now() - t0 > ${SEND_TIMEOUT}) return resolve('timeout');
      setTimeout(check, 500);
    };
    setTimeout(check, 1000); // 1s de graça — o _send já esperou 4s antes de chamar
  })
`;

const CLICK_SEND_SCRIPT = `
  (function() {
    var btn = document.querySelector('[data-testid="send"]')
           || document.querySelector('button[aria-label="Enviar"]')
           || document.querySelector('button[aria-label="Send"]')
           || (document.querySelector('span[data-icon="send"]')
              && document.querySelector('span[data-icon="send"]').closest('button'));
    if (btn) {
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      btn.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }));
      btn.click();
      return 'clicked';
    }
    var input = document.querySelector('[contenteditable="true"][data-tab]')
             || document.querySelector('[data-testid="conversation-compose-box-input"]');
    if (input) {
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      return 'enter';
    }
    return 'not_found';
  })()
`;

class WhatsAppSender {
  constructor({ onLog, onStatus }) {
    this._log      = onLog    || (() => {});
    this._status   = onStatus || (() => {});
    this._win      = null;
    this._queue    = [];
    this._busy     = false;
    this._ready    = false;
    this._initDone = false;
  }

  init() {
    if (this._initDone) return;
    this._initDone = true;
    this._createWindow();
  }

  _createWindow() {
    if (this._win && !this._win.isDestroyed()) return;

    const { BrowserWindow, session } = require('electron');
    const ses = session.fromPartition('persist:whatsapp');

    // WhatsApp Web rejeita o user-agent padrão do Electron
    ses.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/125.0.0.0 Safari/537.36'
    );

    this._win = new BrowserWindow({
      width: 1100, height: 780,
      show: false,
      title: 'WhatsApp Web — Kero Pedir',
      webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true },
    });

    this._win.setMenu(null);

    // Repassa console.log do renderer para o log principal (diagnóstico)
    this._win.webContents.on('console-message', (_, level, msg) => {
      if (msg.startsWith('WA_POLL_')) this._log(`[WhatsApp] ${msg}`);
    });

    this._win.webContents.on('did-finish-load', () => this._onPageLoad());
    this._win.on('close',  e => { e.preventDefault(); this._win.hide(); });
    this._win.on('closed', () => { this._win = null; this._ready = false; });

    this._win.loadURL(WA_BASE);
    this._log('[WhatsApp] Iniciando sessão...');
    this._status('wa_loading');
  }

  async _onPageLoad() {
    if (!this._win || this._win.isDestroyed()) return;

    const url = this._win.webContents.getURL();
    if (!url.startsWith(WA_BASE)) return;

    // Durante envio, o send já controla a navegação — não interferir
    if (this._busy) return;

    // URL de envio: quem controla é o _send()
    if (url.includes('/send')) return;

    await this._sleep(2500);
    if (!this._win || this._win.isDestroyed() || this._busy) return;

    let state;
    try { state = await this._win.webContents.executeJavaScript(LOGGED_IN_CHECK); }
    catch { return; }

    if (state === 'ready') {
      if (!this._ready) {
        this._ready = true;
        this._status('wa_ready');
        this._log('[WhatsApp] Conectado.');
        this._win.hide();
        this._flush();
      }
    } else if (state === 'qr') {
      // Só mostra QR e marca como não pronto se não estava conectado antes
      if (!this._ready) {
        this._status('wa_qr');
        this._log('[WhatsApp] Aguardando QR code...');
        this._win.show();
      } else {
        // Estava conectado, QR pode ser temporário — aguarda e re-testa
        await this._sleep(4000);
        this._onPageLoad();
      }
    } else {
      await this._sleep(3000);
      if (!this._busy) this._onPageLoad();
    }
  }

  showWindow() {
    if (!this._win || this._win.isDestroyed()) this._createWindow();
    this._win.show();
    this._win.focus();
  }

  hideWindow() {
    if (this._win && !this._win.isDestroyed()) this._win.hide();
  }

  isReady() { return this._ready; }

  enqueue(phone, message, meta = {}) {
    this._queue.push({ phone, message, meta, attempts: 0 });
    if (this._ready) this._flush();
  }

  async _flush() {
    if (this._busy || !this._ready || !this._queue.length) return;
    this._busy = true;

    while (this._queue.length) {
      const item = this._queue[0];
      try {
        await this._send(item.phone, item.message);
        this._queue.shift();
        const tag = item.meta.orderId ? ` (pedido #${item.meta.orderId})` : '';
        this._log(`[WhatsApp] ✓ Enviado para ${item.phone}${tag}`);
      } catch (e) {
        item.attempts++;
        this._log(`[WhatsApp] ERRO ${item.phone}: ${e.message}`);
        if (item.attempts >= 2) this._queue.shift();
        else await this._sleep(4000);
        if (!this._ready) break;
      }
      if (this._queue.length) await this._sleep(SEND_COOLDOWN);
    }

    this._busy = false;
  }

  async _send(phone, message) {
    if (!this._win || this._win.isDestroyed()) throw new Error('Janela não inicializada');

    const digits = String(phone).replace(/\D/g, '');
    if (digits.length < 10) throw new Error('Número muito curto');

    const sendUrl = `${WA_BASE}/send?phone=${digits}&text=${encodeURIComponent(message)}&app_absent=0`;

    try {
      // Navega e aguarda did-finish-load
      await this._navigate(sendUrl);

      // O React router do WA processa a rota DEPOIS do did-finish-load.
      // Para contatos não salvos, o router ignora /send e redireciona para home.
      // Espera 4s para o router terminar e só então verifica a URL real.
      await this._sleep(4000);
      const landedUrl = this._win.webContents.getURL();

      if (landedUrl === `${WA_BASE}/` || landedUrl === WA_BASE) {
        // Contato não salvo — usa fluxo Nova Conversa
        this._log(`[WhatsApp] Contato não salvo (${digits}) — abrindo Nova Conversa`);
        const ncResult = await this._win.webContents.executeJavaScript(
          this._buildNewChatScript(digits, message)
        );
        this._log(`[WhatsApp] Nova Conversa: ${ncResult}`);
        if (ncResult.startsWith('timeout') || ncResult === 'no_btn') {
          throw new Error(`Falha ao abrir Nova Conversa: ${ncResult}`);
        }
        // Mensagem já foi digitada pelo script — só precisa clicar enviar
      }
      // Para contatos salvos: mensagem já está pré-preenchida pela URL /send

      // Aguarda botão de envio aparecer e clica
      const state = await this._win.webContents.executeJavaScript(POLL_SEND_SCRIPT);
      if (state === 'account_restricted') throw new Error('Conta restringida pelo WhatsApp — verifique o celular');
      if (state === 'invalid_phone') throw new Error('Número não está no WhatsApp');
      if (state === 'timeout')       throw new Error('Timeout aguardando botão de envio');

      const clickResult = await this._win.webContents.executeJavaScript(CLICK_SEND_SCRIPT);
      this._log(`[WhatsApp] click: ${clickResult}`);

      await this._sleep(2000);

    } finally {
      // Sempre volta pra home e esconde, com ou sem erro
      try { await this._navigate(WA_BASE); } catch {}
      if (this._win && !this._win.isDestroyed()) this._win.hide();
    }
  }

  _buildNewChatScript(digits, message) {
    return `new Promise(function(resolve) {
      var t0 = Date.now();
      var step = 0;

      function typeInto(el, text) {
        el.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      }

      function tick() {
        // Step 0: clicar no botão Nova Conversa
        if (step === 0) {
          var icon = document.querySelector('[data-icon="new-chat-outline"]');
          var btn = icon ? icon.closest('button, [role="button"]') : null;
          if (!btn) btn = document.querySelector('[data-testid="new-chat-btn"]');
          if (!btn) btn = Array.from(document.querySelectorAll('button, [role="button"]')).find(function(b) {
            var label = (b.getAttribute('aria-label') || b.getAttribute('title') || '').toLowerCase();
            return label.includes('nova') || label.includes('new chat');
          });
          if (btn) { btn.click(); step = 1; console.log('WA_NC:btn_clicked'); }
          else if (Date.now() - t0 > 5000) return resolve('no_btn');
        }
        // Step 1: digitar número na busca do painel Nova Conversa
        else if (step === 1) {
          var all = Array.from(document.querySelectorAll('[contenteditable="true"]'));
          // Busca o campo de pesquisa: contenteditable sem data-tab (não é a caixa de mensagens)
          var searchEl = all.find(function(el) {
            return !el.hasAttribute('data-tab') && el.textContent.trim() === '';
          });
          if (!searchEl) searchEl = document.querySelector('input[type="text"]');
          if (searchEl) {
            typeInto(searchEl, ${JSON.stringify(digits)});
            step = 2;
            console.log('WA_NC:number_typed');
          }
        }
        // Step 2: clicar no primeiro resultado (número de telefone)
        else if (step === 2) {
          var cells = document.querySelectorAll('[data-testid="cell-frame-container"]');
          if (cells.length > 0) {
            cells[0].click();
            step = 3;
            console.log('WA_NC:result_clicked:' + (cells[0].textContent || '').slice(0, 40));
          }
        }
        // Step 3: aguardar caixa de mensagem e digitar o texto
        else if (step === 3) {
          var compose = document.querySelector('[data-testid="conversation-compose-box-input"]')
                     || document.querySelector('[contenteditable="true"][data-tab]');
          if (compose) {
            typeInto(compose, ${JSON.stringify(message)});
            console.log('WA_NC:message_typed');
            return resolve('ready');
          }
        }

        if (Date.now() - t0 > 18000) return resolve('timeout:step' + step);
        setTimeout(tick, 500);
      }

      tick();
    })`;
  }

  // Navega e aguarda did-finish-load (com timeout de segurança)
  _navigate(url) {
    return new Promise((resolve, reject) => {
      if (!this._win || this._win.isDestroyed()) return reject(new Error('Janela destruída'));

      const timer = setTimeout(() => {
        this._win.webContents.removeListener('did-finish-load', onLoad);
        resolve(); // timeout não é fatal — continua mesmo assim
      }, 12000);

      const onLoad = () => {
        clearTimeout(timer);
        resolve();
      };

      this._win.webContents.once('did-finish-load', onLoad);
      this._win.loadURL(url);
    });
  }

  destroy() {
    if (this._win && !this._win.isDestroyed()) {
      this._win.removeAllListeners('close');
      this._win.close();
    }
    this._win      = null;
    this._ready    = false;
    this._queue    = [];
    this._initDone = false;
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = { WhatsAppSender };
