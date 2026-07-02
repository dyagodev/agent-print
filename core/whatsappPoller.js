'use strict';

const POLL_MS = 12000;

// Variables available in templates:
//   {cliente}         → customer name
//   {pedido_id}       → order ID
//   {total}           → formatted total (R$X,XX)
//   {tipo}            → comanda | retirada | delivery
//   {endereco}        → delivery address
//   {tempo_estimado}  → estimated prep time in minutes
const DEFAULT_TEMPLATES = {
  order_accepted: {
    enabled: true,
    label: 'Pedido aceito',
    message: 'Olá {cliente}! Seu pedido #{pedido_id} foi aceito e está sendo preparado. 🍽️\nAguarde, logo ficará pronto!',
  },
  order_ready: {
    enabled: true,
    label: 'Pedido pronto',
    message: 'Seu pedido #{pedido_id} está pronto! 🎉\n' +
             'Em breve chegará até você.',
  },
  order_out_for_delivery: {
    enabled: true,
    label: 'Saiu para entrega',
    message: '🛵 Pedido #{pedido_id} saiu para entrega!\n' +
             'Endereço: {endereco}',
  },
  order_delivered: {
    enabled: true,
    label: 'Pedido entregue',
    message: '✅ Pedido #{pedido_id} entregue com sucesso!\n' +
             'Obrigado por pedir conosco. Até a próxima! 😊',
  },
  order_cancelled: {
    enabled: true,
    label: 'Pedido cancelado',
    message: 'Seu pedido #{pedido_id} foi cancelado.\n' +
             'Entre em contato se tiver dúvidas.',
  },
};

class WhatsAppPoller {
  constructor({ cfg, sender, templates, onLog }) {
    this.cfg        = cfg;
    this._sender    = sender;
    this._templates = { ...DEFAULT_TEMPLATES, ...(templates || {}) };
    this._log       = onLog || (() => {});
    this._running   = false;
    this._timer     = null;
    this._acked     = new Set();
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._tick();
  }

  stop() {
    this._running = false;
    clearTimeout(this._timer);
  }

  updateConfig(cfg) { this.cfg = cfg; }

  updateTemplates(templates) {
    this._templates = { ...DEFAULT_TEMPLATES, ...templates };
  }

  getTemplates() { return this._templates; }

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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  _render(template, order) {
    const total = order.total != null
      ? 'R$' + Number(order.total).toFixed(2).replace('.', ',')
      : '';

    return template
      .replace(/{cliente}/g,        order.customer_name   || 'Cliente')
      .replace(/{pedido_id}/g,      String(order.id       || ''))
      .replace(/{total}/g,          total)
      .replace(/{tipo}/g,           order.type            || '')
      .replace(/{endereco}/g,       order.address         || '')
      .replace(/{tempo_estimado}/g, String(order.estimated_time || '30'));
  }

  async _poll() {
    if (!this._sender.isReady()) return;

    let items;
    try {
      items = await this._fetch('/api/lojista/pdv/whatsapp-queue');
    } catch {
      return; // endpoint pode não existir ainda
    }

    if (!Array.isArray(items) || !items.length) return;

    for (const item of items) {
      if (this._acked.has(item.id)) continue;

      const phone = String(item.phone || item.order?.customer_phone || '').replace(/\D/g, '');
      const event = item.event;
      const order = item.order || item;

      const tpl = this._templates[event];

      // ACK mesmo se evento desativado — não queremos fila infinita
      this._acked.add(item.id);
      this._ack(item.id).catch(e =>
        this._log(`[WhatsApp] ERRO ack #${item.id}: ${e.message}`)
      );

      if (!tpl || !tpl.enabled) {
        this._log(`[WhatsApp] Evento "${event}" desativado — ignorado`);
        continue;
      }

      if (!phone) {
        this._log(`[WhatsApp] Sem telefone para notificação #${item.id}`);
        continue;
      }

      const message = this._render(tpl.message, order);
      this._sender.enqueue(phone, message, {
        orderId:  order.id,
        notifId:  item.id,
      });
    }
  }

  async _ack(id) {
    await this._fetch(`/api/lojista/pdv/whatsapp-queue/${id}/ack`, { method: 'POST' });
  }

  async _tick() {
    if (!this._running) return;
    await this._poll();
    this._timer = setTimeout(() => this._tick(), POLL_MS);
  }
}

module.exports = { WhatsAppPoller, DEFAULT_TEMPLATES };
