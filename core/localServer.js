'use strict';
const http = require('node:http');
const { buildEscPos, sendTcp, sendUsb } = require('./printer');

const PORT = 7891;

function startLocalServer({ onLog, getStations, getCatMap }) {
  const server = http.createServer(async (req, res) => {
    // CORS — PDV rodando em qualquer origem local pode chamar
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // GET /health — PDV verifica se agente está online
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: '1.0.0' }));
      return;
    }

    // POST /print — PDV envia pedido para impressão imediata
    if (req.method === 'POST' && req.url === '/print') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { order } = JSON.parse(body);
          if (!order) throw new Error('Campo "order" ausente');

          const stations  = getStations();
          const catMap    = getCatMap();

          if (!stations.length) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, reason: 'no_stations' }));
            return;
          }

          // Agrupar itens por estação (fallback para primeira estação ativa se sem roteamento)
          const fallback = stations.find(s => s.active) || null;
          const groups = {};
          (order.items || []).forEach(item => {
            const st = catMap[item.item_category_id] || fallback;
            if (!st || !st.active) return;
            if (!groups[st.id]) groups[st.id] = { station: st, items: [] };
            groups[st.id].items.push(item);
          });

          if (!Object.keys(groups).length) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, reason: 'no_routing' }));
            return;
          }

          const errors = [];
          await Promise.all(Object.values(groups).map(async ({ station, items }) => {
            const data = buildEscPos({ ...order, items }, station.name);
            try {
              if (station.type === 'network') {
                await sendTcp(station.printer_ip, station.printer_port, data);
                onLog(`PDV #${order.id} → ${station.name} (${station.printer_ip})`);
              } else {
                await sendUsb(station.printer_name_os, data);
                onLog(`PDV #${order.id} → ${station.name} (USB: ${station.printer_name_os})`);
              }
            } catch (e) {
              errors.push(`${station.name}: ${e.message}`);
              onLog(`ERRO estacao ${station.name}: ${e.message}`);
            }
          }));

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: errors.length === 0, errors }));
        } catch (e) {
          onLog(`ERRO servidor local: ${e.message}`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404); res.end();
  });

  server.listen(PORT, '127.0.0.1', () => {
    onLog(`Servidor local iniciado em http://127.0.0.1:${PORT}`);
  });

  server.on('error', e => {
    onLog(`Servidor local: ${e.message}`);
  });

  return server;
}

module.exports = { startLocalServer, PORT };
