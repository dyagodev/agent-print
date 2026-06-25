'use strict';
const net  = require('node:net');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const WIDTH = 32;

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
  const r   = String(right);
  const l   = String(left).substring(0, w - r.length - 1);
  const pad = ' '.repeat(Math.max(0, w - l.length - r.length));
  return text(l + pad + r);
}

const dashes = () => text('-'.repeat(WIDTH));
const money  = (v) => 'R$' + Number(v).toFixed(2).replace('.', ',');

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
  const pay = PAYMENT[order.payment_method] ?? (order.payment_method || '');
  if (pay) add(col('Pagamento', pay), LF);
  add(dashes(), LF);

  (order.items || []).forEach(item => {
    add(col(`${item.qty}x ${item.name}`, money(item.subtotal)), LF);
    (item.selected_options || []).forEach(o => {
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

// Script PowerShell que usa WritePrinter API do Windows para envio raw sem precisar compartilhar a impressora
const PS_RAW_PRINT = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class RawPrint {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]
  public struct DOC_INFO_1 { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv",CharSet=CharSet.Unicode)] public static extern bool OpenPrinter(string n,out IntPtr h,IntPtr d);
  [DllImport("winspool.drv")] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv",CharSet=CharSet.Unicode)] public static extern int StartDocPrinter(IntPtr h,int l,ref DOC_INFO_1 di);
  [DllImport("winspool.drv")] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv")] public static extern bool WritePrinter(IntPtr h,byte[] b,int c,out int w);
  [DllImport("winspool.drv")] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv")] public static extern bool EndDocPrinter(IntPtr h);
}
"@
$name = $args[0]; $file = $args[1]
$bytes = [System.IO.File]::ReadAllBytes($file)
$hPrinter = [IntPtr]::Zero
if (-not [RawPrint]::OpenPrinter($name, [ref]$hPrinter, [IntPtr]::Zero)) { throw "Impressora '$name' nao encontrada" }
$di = New-Object RawPrint+DOC_INFO_1; $di.pDocName="KeroPedir"; $di.pDataType="RAW"
[RawPrint]::StartDocPrinter($hPrinter, 1, [ref]$di) | Out-Null
[RawPrint]::StartPagePrinter($hPrinter) | Out-Null
$written = 0
[RawPrint]::WritePrinter($hPrinter, $bytes, $bytes.Length, [ref]$written) | Out-Null
[RawPrint]::EndPagePrinter($hPrinter) | Out-Null
[RawPrint]::EndDocPrinter($hPrinter) | Out-Null
[RawPrint]::ClosePrinter($hPrinter) | Out-Null
Write-Host "OK: $written bytes enviados para $name"
`.trim();

async function sendUsb(printerName, data) {
  const tmpFile = path.join(os.tmpdir(), `kero-print-${Date.now()}.bin`);
  fs.writeFileSync(tmpFile, data);
  try {
    if (process.platform === 'win32') {
      const psFile = tmpFile + '.ps1';
      fs.writeFileSync(psFile, PS_RAW_PRINT, 'utf8');
      try {
        await execFileAsync('powershell', [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', psFile, printerName, tmpFile,
        ]);
      } finally {
        try { fs.unlinkSync(psFile); } catch {}
      }
    } else {
      await execFileAsync('lp', ['-d', printerName, '-o', 'raw', tmpFile]);
    }
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

module.exports = { buildEscPos, sendTcp, sendUsb };
