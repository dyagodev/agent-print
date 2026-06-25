'use strict';
const { buildEscPos, sendTcp, sendUsb } = require('./printer');

const POLL_MS = 8000;

class Poller {
  constructor({ cfg, onLog, onStatus }) {
    this.cfg       = cfg;
    this.onLog     = onLog    || (() => {});
    this.onStatus  = onStatus || (() => {});
    this._stations = [];
    this._catMap   = {};
    this._lastLoad = 0;
    this._printed  = new Set();
    this._timer    = null;
    this._running  = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.onStatus('running');
    this._tick();
  }

  stop() {
    this._running = false;
    clearTimeout(this._timer);
    this.onStatus('stopped');
  }

  updateConfig(cfg) {
    this.cfg       = cfg;
    this._lastLoad = 0;
  }

  async _fetch(urlPath, opts = {}) {
    const base = this.cfg.url.replace(/\/$/, '');
    const res  = await fetch(`${base}${urlPath}`, {
      ...opts,
      headers: {
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        'Authorization': `Bearer ${this.cfg.token}`,
        ...(opts.headers || {}),
      },
    });

    if (!res.ok) {
      const ct   = res.headers.get('content-type') || '';
      const body = ct.includes('json') ? JSON.stringify(await res.json().catch(() => ({}))) : await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} — ${body.slice(0, 120)}`);
    }

    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) {
      const text = await res.text();
      throw new Error(`Resposta não-JSON (${res.status}): ${text.slice(0, 80)}`);
    }

    return res.json();
  }

  async _loadStations() {
    const [stations, cats] = await Promise.all([
      this._fetch('/api/lojista/pdv/print-stations'),
      this._fetch('/api/lojista/pdv/item-categories'),
    ]);
    this._stations = stations;
    this._catMap   = {};
    cats.forEach(c => {
      if (c.print_station_id) {
        const st = stations.find(s => s.id === c.print_station_id);
        if (st) this._catMap[c.id] = st;
      }
    });
    this._lastLoad = Date.now();
    const mapEntries = Object.keys(this._catMap).length;
    this.onLog(`${stations.length} estação(ões) carregada(s), ${mapEntries} categoria(s) com roteamento`);
  }

  async _ensureStations() {
    if (!this._lastLoad || Date.now() - this._lastLoad > 5 * 60 * 1000) {
      await this._loadStations();
    }
  }

  async _poll() {
    try {
      await this._ensureStations();
      if (!this._stations.length) {
        this.onLog('Nenhuma estação configurada — aguardando...');
        return;
      }

      const orders = await this._fetch('/api/lojista/pdv/print-queue');
      if (!orders || !orders.length) return;

      this.onLog(`Fila: ${orders.length} pedido(s) pendente(s)`);

      for (const order of orders) {
        if (this._printed.has(order.id)) continue;

        const items = order.items || [];
        this.onLog(`Pedido #${order.id} — ${items.length} item(s) | catMap keys: [${Object.keys(this._catMap).join(',')}]`);

        const fallbackStation = this._stations.find(s => s.active) || null;
        const groups = {};
        items.forEach(item => {
          const catId = item.item_category_id;
          const st    = this._catMap[catId];
          if (!st) {
            if (fallbackStation) {
              this.onLog(`  "${item.name}" sem roteamento — fallback para "${fallbackStation.name}"`);
              if (!groups[fallbackStation.id]) groups[fallbackStation.id] = { station: fallbackStation, items: [] };
              groups[fallbackStation.id].items.push(item);
            } else {
              this.onLog(`  "${item.name}" sem roteamento e sem estação fallback`);
            }
            return;
          }
          if (!st.active) {
            this.onLog(`  "${item.name}" → estação "${st.name}" inativa`);
            return;
          }
          if (!groups[st.id]) groups[st.id] = { station: st, items: [] };
          groups[st.id].items.push(item);
        });

        if (!Object.keys(groups).length) {
          this.onLog(`  Nenhum item com estação — marcar impresso sem enviar`);
          const totalNow = (order.printed_items_count || 0) + items.length;
          try {
            await this._fetch(`/api/lojista/pdv/print-queue/${order.id}/ack`, {
              method: 'POST',
              body: JSON.stringify({ total_items: totalNow }),
            });
          } catch {}
          continue;
        }

        let ok = true;
        for (const { station, items: stItems } of Object.values(groups)) {
          const data = buildEscPos({ ...order, items: stItems }, station.name);
          try {
            if (station.type === 'network') {
              await sendTcp(station.printer_ip, station.printer_port, data);
              this.onLog(`  OK #${order.id} → ${station.name} (${station.printer_ip}:${station.printer_port})`);
            } else {
              await sendUsb(station.printer_name_os, data);
              this.onLog(`  OK #${order.id} → ${station.name} (USB: ${station.printer_name_os})`);
            }
          } catch (e) {
            this.onLog(`  ERRO estacao ${station.name}: ${e.message}`);
            ok = false;
          }
        }

        if (ok) {
          // Remove do cache para detectar novos itens futuros nesta comanda
          this._printed.delete(order.id);
          const totalNow = (order.printed_items_count || 0) + items.length;
          try {
            await this._fetch(`/api/lojista/pdv/print-queue/${order.id}/ack`, {
              method: 'POST',
              body: JSON.stringify({ total_items: totalNow }),
            });
          } catch {}
        }
      }
    } catch (e) {
      if (!e.message.includes('404')) this.onLog(`Erro no poll: ${e.message}`);
    }
  }

  async _tick() {
    if (!this._running) return;
    await this._poll();
    this._timer = setTimeout(() => this._tick(), POLL_MS);
  }
}

module.exports = { Poller };
