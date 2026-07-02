'use strict';
const http = require('node:http');
const { buildEscPos, buildPreview, sendTcp, sendUsb } = require('./printer');

const PORT = 7891;

function startLocalServer({ onLog, getStations, getCatMap = () => ({}), ensureStations = () => Promise.resolve(), onPreview }) {
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
          const payload = JSON.parse(body);
          const { order, isFullPrint = false, stationGroups } = payload;
          if (!order) throw new Error('Campo "order" ausente');

          // Garante que estações e catMap estejam carregados
          if (!getStations().length || !Object.keys(getCatMap()).length) {
            await ensureStations();
          }
          const stations = getStations();

          if (!stations.length) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, reason: 'no_stations' }));
            return;
          }

          const groups = {};

          if (stationGroups && stationGroups.length) {
            // PDV: roteamento pré-computado
            stationGroups.forEach(({ stationId, items }) => {
              const st = stations.find(s => s.id === stationId && s.active);
              if (st) groups[st.id] = { station: st, items: items || [] };
            });
          } else if (isFullPrint) {
            // Via do cliente: rotear para estações marcadas como "via cliente"
            stations.filter(s => s.is_customer_station && s.active).forEach(st => {
              groups[st.id] = { station: st, items: order.items || [] };
            });
          } else {
            // App (garçom/lojista): rotear por categoria igual ao poller
            const catMap = getCatMap();
            (order.items || []).forEach(item => {
              const stList = (catMap[item.item_category_id] || []).filter(s => s.active && !s.is_customer_station);
              stList.forEach(st => {
                if (!groups[st.id]) groups[st.id] = { station: st, items: [] };
                groups[st.id].items.push(item);
              });
            });

            // Itens sem estação configurada não precisam de impressão — não é erro
            if (!Object.keys(groups).length) {
              onLog(`App #${order.id} — nenhum item com estação de produção, ignorando`);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, reason: 'nothing_to_print' }));
              return;
            }
          }

          if (!Object.keys(groups).length) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, reason: 'no_routing' }));
            return;
          }

          const errors = [];
          await Promise.all(Object.values(groups).map(async ({ station, items }) => {
            const printOpts = { paperWidth: station.paper_width || 80, isFullPrint };
            try {
              const printName = isFullPrint ? null : station.name;
              if (station.type === 'virtual') {
                const preview = buildPreview({ ...order, items }, printName, printOpts);
                onLog(`PDV #${order.id} → ${station.name} (virtual)`);
                if (onPreview) onPreview({ station: station.name, text: preview, orderId: order.id, at: new Date().toISOString() });
              } else {
                const data = buildEscPos({ ...order, items }, printName, printOpts);
                if (station.type === 'network') {
                  await sendTcp(station.printer_ip, station.printer_port, data);
                  onLog(`PDV #${order.id} → ${station.name} (${station.printer_ip})`);
                } else {
                  await sendUsb(station.printer_name_os, data);
                  onLog(`PDV #${order.id} → ${station.name} (USB: ${station.printer_name_os})`);
                }
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

  server.listen(PORT, '0.0.0.0', () => {
    onLog(`Servidor local iniciado em http://127.0.0.1:${PORT}`);
  });

  server.on('error', e => {
    onLog(`Servidor local: ${e.message}`);
  });

  return server;
}

module.exports = { startLocalServer, PORT };
