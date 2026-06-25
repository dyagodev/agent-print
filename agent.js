#!/usr/bin/env node
/**
 * Kero Pedir — Agente Local de Impressão
 *
 * Faz polling na API e imprime automaticamente pedidos novos
 * nas estações configuradas (rede TCP ou USB via SO).
 *
 * Uso:
 *   node agent.js --url=https://seudomain.com --token=SEU_TOKEN
 *
 * Config salva em ~/.kero-print.json (gerada na primeira execução)
 */

import net  from 'node:net';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CONFIG_FILE   = path.join(os.homedir(), '.kero-print.json');
const POLL_MS       = 8000;   // polling a cada 8 segundos
const WIDTH         = 32;     // colunas ESC/POS

// ── Config ────────────────────────────────────────────────────
function loadConfig() {
  const args = Object.fromEntries(
    process.argv.slice(2)
      .filter(a => a.startsWith('--'))
      .map(a => { const [k, v] = a.slice(2).split('='); return [k, v]; })
  );

  let saved = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try { saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  }

  const cfg = { ...saved, ...args };

  if (!cfg.url || !cfg.token) {
    console.error('[kero-print] Faltam parâmetros. Exemplo:');
    console.error('  node agent.js --url=https://seusite.com --token=SEU_TOKEN');
    process.exit(1);
  }

  // Salvar para próximas execuções
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  return cfg;
}

// ── ESC/POS builder ────────────────────────────────────────────
const ESC  = 0x1b;
const GS   = 0x1d;
const buf  = (...bytes) => Buffer.from(bytes);
const text = (s) => Buffer.from(String(s), 'latin1');

const INIT    = buf(ESC, 0x40);
const BOLD_ON = buf(ESC, 0x45, 0x01);
const CENTER  = buf(ESC, 0x61, 0x01);
const LEFT    = buf(ESC, 0x61, 0x00);
const SMALL   = buf(ESC, 0x4d, 0x01);
const NORMAL  = buf(ESC, 0x4d, 0x00);
const CUT     = buf(GS,  0x56, 0x41, 0x05);
const LF      = buf(0x0a);

function col(left, right, w = WIDTH) {
  const r = String(right);
  const l = String(left).substring(0, w - r.length - 1);
  const pad = ' '.repeat(Math.max(0, w - l.length - r.length));
  return text(l + pad + r);
}

function dashes() { return text('-'.repeat(WIDTH)); }
function money(v) { return 'R$' + Number(v).toFixed(2).replace('.', ','); }

const ORDER_TYPE = { comanda: 'COMANDA', retirada: 'RETIRADA', delivery: 'DELIVERY' };
const PAYMENT    = { cash: 'Dinheiro', pix: 'PIX', card: 'Cartão' };

function buildEscPos(order, stationName) {
  const chunks = [];
  const add    = (...b) => chunks.push(...b);

  const typeLabel = ORDER_TYPE[order.order_type] ?? 'PEDIDO';
  const now       = new Date().toLocaleString('pt-BR');

  add(INIT, BOLD_ON);
  if (stationName) add(CENTER, text(stationName.toUpperCase()), LF);
  add(CENTER, text(`${typeLabel} #${order.id}`), LF);
  add(SMALL, text(now), NORMAL, LF);
  add(LEFT, dashes(), LF);

  if (order.customer_name) add(col('Cliente', order.customer_name), LF);
  const pay = PAYMENT[order.payment_method] ?? (order.payment_method ?? '');
  if (pay) add(col('Pagamento', pay), LF);
  add(dashes(), LF);

  (order.items ?? []).forEach(item => {
    add(col(`${item.qty}x ${item.name}`, money(item.subtotal)), LF);
    (item.selected_options ?? []).forEach(o => {
      add(SMALL, text(`  ${o.group_name}: ${o.option_name}`), NORMAL, LF);
    });
  });

  add(dashes(), LF);
  add(col('TOTAL', money(order.total)), LF);

  if (order.notes) {
    add(dashes(), LF);
    add(SMALL, text('OBS: ' + order.notes), NORMAL, LF);
  }

  add(CENTER, SMALL, text('Kero Pedir'), NORMAL, LF);
  add(buf(0x0a, 0x0a, 0x0a), CUT);

  return Buffer.concat(chunks);
}

// ── TCP printer ────────────────────────────────────────────────
function sendTcp(ip, port, data) {
  return new Promise((resolve, reject) => {
    const client = net.connect({ host: ip, port: parseInt(port) }, () => {
      client.write(data, () => {
        setTimeout(() => { client.destroy(); resolve(); }, 300);
      });
    });
    client.on('error', err => { client.destroy(); reject(err); });
    setTimeout(() => { client.destroy(); reject(new Error('Timeout TCP')); }, 6000);
  });
}

// ── USB printer (via OS) ───────────────────────────────────────
async function sendUsb(printerName, data) {
  const tmpFile = path.join(os.tmpdir(), `kero-print-${Date.now()}.bin`);
  fs.writeFileSync(tmpFile, data);

  try {
    if (process.platform === 'win32') {
      // Windows: copy /b file \\localhost\PrinterName
      await execFileAsync('cmd', ['/c', `copy /b "${tmpFile}" "\\\\localhost\\${printerName}"`]);
    } else {
      // Mac/Linux: lp -d PrinterName -o raw
      await execFileAsync('lp', ['-d', printerName, '-o', 'raw', tmpFile]);
    }
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ── API client ─────────────────────────────────────────────────
async function apiFetch(cfg, path, opts = {}) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(`${cfg.url.replace(/\/$/, '')}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.token}`,
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  return res.json();
}

// ── Main polling loop ──────────────────────────────────────────
async function main() {
  const cfg = loadConfig();
  console.log(`[kero-print] Iniciando agente → ${cfg.url}`);
  console.log(`[kero-print] Polling a cada ${POLL_MS / 1000}s`);

  let stations     = [];
  let catStationMap = {};  // item_category_id → station
  let lastStationsLoad = 0;

  async function loadStations() {
    try {
      const s = await apiFetch(cfg, '/api/lojista/pdv/print-stations');
      const c = await apiFetch(cfg, '/api/lojista/pdv/item-categories');
      stations      = s;
      catStationMap = {};
      c.forEach(cat => {
        if (cat.print_station_id) {
          const st = s.find(x => x.id === cat.print_station_id);
          if (st) catStationMap[cat.id] = st;
        }
      });
      lastStationsLoad = Date.now();
      console.log(`[kero-print] ${s.length} estação(ões) carregada(s)`);
    } catch (e) {
      console.error('[kero-print] Erro ao carregar estações:', e.message);
    }
  }

  // Recarregar estações a cada 5 minutos
  async function ensureStations() {
    if (!lastStationsLoad || Date.now() - lastStationsLoad > 5 * 60 * 1000) {
      await loadStations();
    }
  }

  const printed = new Set();  // IDs já impressos nesta sessão

  async function poll() {
    try {
      await ensureStations();
      if (!stations.length) return;

      const orders = await apiFetch(cfg, '/api/lojista/pdv/print-queue');
      if (!orders?.length) return;

      for (const order of orders) {
        if (printed.has(order.id)) continue;

        // Agrupar itens por estação
        const groups = {};
        (order.items ?? []).forEach(item => {
          const station = catStationMap[item.item_category_id];
          if (!station || !station.active) return;
          if (!groups[station.id]) groups[station.id] = { station, items: [] };
          groups[station.id].items.push(item);
        });

        let ok = true;
        for (const { station, items } of Object.values(groups)) {
          const subOrder = { ...order, items };
          const data     = buildEscPos(subOrder, station.name);
          try {
            if (station.type === 'network') {
              await sendTcp(station.printer_ip, station.printer_port, data);
              console.log(`[kero-print] Pedido #${order.id} → ${station.name} (${station.printer_ip}:${station.printer_port})`);
            } else {
              await sendUsb(station.printer_name_os, data);
              console.log(`[kero-print] Pedido #${order.id} → ${station.name} (USB: ${station.printer_name_os})`);
            }
          } catch (e) {
            console.error(`[kero-print] Erro na estação ${station.name}:`, e.message);
            ok = false;
          }
        }

        if (ok) {
          printed.add(order.id);
          // Marcar como impresso na API
          try {
            await apiFetch(cfg, `/api/lojista/pdv/print-queue/${order.id}/ack`, { method: 'POST' });
          } catch {}
        }
      }
    } catch (e) {
      if (!e.message.includes('404')) {
        console.error('[kero-print] Erro no poll:', e.message);
      }
    }
  }

  await poll();
  setInterval(poll, POLL_MS);
}

main().catch(e => { console.error(e); process.exit(1); });
