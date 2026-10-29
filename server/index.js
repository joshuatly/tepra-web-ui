// TEPRA Web backend.
//   - Serves the web UI
//   - Wi-Fi / LAN printing (SR5900P family) over UDP+TCP 9100, see server/network.js
//   - Bluetooth Classic (RFCOMM) bridge for SR-R2500P / SR-MK1 / SR-R7900P, see server/rfcomm.js
//   - Server-Sent Events for status, progress and logs
//
//   node server/index.js [--port 8765] [--host 127.0.0.1]
//
// Environment (all optional):
//   PORT, HOST          listen address (CLI flags win)
//   DATA_DIR            where printers.json is kept (default ./data)
//   TEPRA_PRINTERS      pre-configured network printers, e.g. "Label=192.168.1.50"
//   TEPRA_BLUETOOTH=0   disable the Bluetooth bridge entirely

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPrinter, tapeWidthLabel } from '../app/models.js';
import { buildNetworkJobBytes, TapeCut } from '../app/protocol.js';
import { NetworkPrinter, discover, describeStatus, DEFAULT_PORT } from './network.js';
import { PrinterStore, resolveModel } from './printers.js';
import { decodePng } from './png.js';
import { imageToPage } from './imageprint.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
const BLUETOOTH_ENABLED = !/^(0|false|no|off)$/i.test(process.env.TEPRA_BLUETOOTH || '');

// The Bluetooth bridge is optional: in Docker there is usually no Bluetooth stack.
const bt = BLUETOOTH_ENABLED
  ? await import('./rfcomm.js').catch((err) => ({ loadError: err }))
  : { loadError: new Error('disabled with TEPRA_BLUETOOTH=0') };

async function bluetoothUnavailableReason() {
  if (bt.loadError) return `Bluetooth is unavailable: ${bt.loadError.message}`;
  return bt.rfcommUnavailableReason();
}

function parseArgs(argv) {
  const args = {
    port: Number(process.env.PORT) || 8765,
    host: process.env.HOST || '127.0.0.1',
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--host') args.host = argv[++i];
  }
  return args;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

/** Only these paths are served; everything else (package.json, data/, server/) stays private. */
const PUBLIC = [/^index\.html$/, /^favicon\.svg$/, /^manifest\.webmanifest$/, /^PROTOCOL\.md$/,
  /^app\/[\w.-]+\.(js|css)$/, /^test\/[\w.-]+\.html$/];

// ---- State ----------------------------------------------------------------

const clients = new Set();
const store = new PrinterStore(path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data')),
  process.env.TEPRA_PRINTERS);
await store.load();

function broadcast(type, payload) {
  const line = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
  for (const res of clients) {
    try { res.write(line); } catch { clients.delete(res); }
  }
}

function log(message, kind = 'info') {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`[${stamp}] ${message}`);
  broadcast('log', { message, kind });
}

// ---- Network printers ------------------------------------------------------

/** host:port → NetworkPrinter (keeps the per-printer busy flag) */
const netPrinters = new Map();

function netPrinter(host, port = DEFAULT_PORT) {
  const key = `${host}:${port}`;
  let p = netPrinters.get(key);
  if (!p) {
    p = new NetworkPrinter(host, { port });
    p.on('log', ({ message, kind }) => log(`[${key}] ${message}`, kind));
    p.on('progress', (prog) => broadcast('net-progress', { host, port, ...prog }));
    p.on('status', (status) => broadcast('net-status', { host, port, status }));
    netPrinters.set(key, p);
  }
  return p;
}

/** Resolves ?printer=<id|host> or ?host=&port= into {host, port, model}. */
function targetFrom(url) {
  const q = url.searchParams;
  // printer = saved id, name or host; host = an address that need not be saved
  const ref = q.get('printer') || q.get('host');
  if (!ref) {
    const all = store.list();
    if (all.length === 1) return all[0];
    throw httpError(400, 'Specify ?printer=<id or host>');
  }
  const saved = store.find(ref);
  if (saved && !q.get('port')) return saved;
  const port = Number(q.get('port')) || saved?.port || DEFAULT_PORT;
  if (!/^[A-Za-z0-9.:\-[\]]+$/.test(ref)) throw httpError(400, 'Invalid printer host');
  return { host: ref, port, model: resolveModel(q.get('model') || saved?.model) };
}

// ---- Bluetooth -------------------------------------------------------------

let transport = null;
let device = null;

function attach(t) {
  t.on('log', ({ message, kind }) => log(message, kind));
  t.on('status', (status) => broadcast('status', { status }));
  t.on('closed', () => {
    if (transport === t) {
      transport = null;
      device = null;
      log('Lost the connection to the printer', 'warn');
      broadcast('disconnected', {});
    }
  });
}

async function connect({ id, model, channel = null }) {
  const reason = await bluetoothUnavailableReason();
  if (reason) throw new Error(reason);
  if (transport) await disconnect();

  const printer = findPrinter(model);
  const t = new bt.RfcommTransport(id, { channel });
  t.statusLength = printer.statusLength;
  // Only the first-generation Bluetooth model (SR5500P) answers with ASCII status
  t.asciiStatus = printer.statusLength === 8;
  attach(t);
  await t.open();

  transport = t;
  device = {
    transport: 'rfcomm',
    id,
    model: printer.model,
    statusLength: printer.statusLength,
    channel: t.channel ?? null,
  };
  log(`Connected to ${printer.model} on RFCOMM ch${t.channel} (${id})`, 'ok');
  broadcast('connected', { device });
  return device;
}

/** AccessManager*.resetRequestStatus(): turn automatic status notifications off */
const RESET_REQUEST_STATUS = Uint8Array.from([0x1b, 0x7b, 0x05, 0x49, 0x00, 0x00, 0x49, 0x7d]);

async function disconnect() {
  if (!transport) return;
  const t = transport;
  transport = null;
  device = null;
  // Safety net in case the tab closed before the browser sent endSession().
  // Without it the printer stays in notification mode and ignores the next connection.
  await t.write(RESET_REQUEST_STATUS, 3000).catch(() => {});
  await new Promise((r) => setTimeout(r, 150));
  await t.close().catch(() => {});
  log('Disconnected');
  broadcast('disconnected', {});
}

// ---- HTTP ------------------------------------------------------------------

function httpError(code, message) {
  return Object.assign(new Error(message), { status: code });
}

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(httpError(413, 'Request body is too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = (await readBody(req, 1024 * 1024)).toString('utf8');
  try { return JSON.parse(text || '{}'); } catch { throw httpError(400, 'Invalid JSON body'); }
}

async function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html'; } catch { rel = ''; }
  if (!PUBLIC.some((re) => re.test(rel))) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  try {
    const data = await fs.readFile(path.join(ROOT, rel));
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

/** Runs a network job and reports the outcome. Shared by the UI and the image API. */
async function runNetworkJob(target, bytes, { pages, tapeCode }) {
  const p = netPrinter(target.host, target.port);
  if (p.busy) throw httpError(409, 'The printer is busy with another job');
  log(`[${p.address}] Printing ${pages} label(s), ${bytes.length.toLocaleString()} bytes`);
  try {
    await p.print(bytes, { pages, tapeCode });
  } catch (err) {
    if (err.name === 'PrintCancelled') {
      log(`[${p.address}] Print cancelled`, 'warn');
      throw httpError(499, 'Cancelled');
    }
    log(`[${p.address}] Print failed: ${err.message}`, 'err');
    throw httpError(502, err.message);
  }
  log(`[${p.address}] Print finished`, 'ok');
}

const ROUTES = {
  'GET /events': (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    res.write(`data: ${JSON.stringify({ type: 'hello', device })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* noop */ } }, 20000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
  },

  'GET /state': async (req, res) => {
    const rfcommError = await bluetoothUnavailableReason();
    json(res, 200, {
      version: VERSION,
      connected: !!transport,
      device,
      rfcomm: !rfcommError,
      rfcommError,
      network: true,
      printers: store.list(),
      platform: process.platform,
    });
  },

  // -- Network printers --

  'GET /printers': (req, res) => json(res, 200, { printers: store.list() }),

  'POST /printers': async (req, res) => {
    try {
      const p = await store.add(await readJson(req));
      log(`Saved printer ${p.name} (${p.host}:${p.port})`, 'ok');
      json(res, 200, { printer: p, printers: store.list() });
    } catch (err) {
      json(res, err.status || 400, { error: err.message });
    }
  },

  'DELETE /printers': async (req, res, url) => {
    try {
      await store.remove(url.searchParams.get('id'));
      json(res, 200, { printers: store.list() });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
  },

  'GET /net/discover': async (req, res) => {
    const found = await discover();
    json(res, 200, { printers: found });
  },

  'GET /net/status': async (req, res, url) => {
    const target = targetFrom(url);
    try {
      const status = await netPrinter(target.host, target.port).status();
      json(res, 200, { host: target.host, port: target.port, status, summary: describeStatus(status) });
    } catch (err) {
      json(res, 504, { error: err.message });
    }
  },

  /** Body: application/octet-stream from buildNetworkJobBytes(). Query: printer|host, port, pages, tape */
  'POST /net/print': async (req, res, url) => {
    const target = targetFrom(url);
    const bytes = await readBody(req);
    if (!bytes.length) throw httpError(400, 'Empty print job');
    const pages = Math.max(1, Number(url.searchParams.get('pages')) || 1);
    const tapeCode = Number(url.searchParams.get('tape')) || null;
    await runNetworkJob(target, new Uint8Array(bytes), { pages, tapeCode });
    json(res, 200, { ok: true });
  },

  'POST /net/cancel': (req, res, url) => {
    const target = targetFrom(url);
    const cancelled = netPrinter(target.host, target.port).cancel();
    json(res, 200, { cancelled });
  },

  /**
   * Print a PNG without the browser, e.g.
   *   curl --data-binary @label.png -H 'Content-Type: image/png' \
   *        'http://tepra:8765/api/print/image?printer=192.168.1.50&copies=2'
   * Query: printer|host, copies (1-99), cut (each|end|none), halfcut (0|1), density (-5..5),
   *        tape (code, default: loaded tape), fit (contain|fill), rotate (0|1), invert (0|1),
   *        padding (mm, default 2), margin (mm, default 1)
   */
  'POST /print/image': async (req, res, url) => {
    const q = url.searchParams;
    const target = targetFrom(url);
    const model = findPrinter(target.model);
    let img;
    try { img = decodePng(await readBody(req, 32 * 1024 * 1024)); } catch (err) { throw httpError(400, err.message); }

    let tapeCode = Number(q.get('tape')) || null;
    if (!tapeCode) {
      let status;
      try { status = await netPrinter(target.host, target.port).status(); } catch (err) { throw httpError(504, err.message); }
      tapeCode = status.tapeWidthCode;
      if (tapeCode <= 0) throw httpError(409, `Cannot detect the tape (${tapeWidthLabel(tapeCode)})`);
    }

    let page;
    try {
      page = imageToPage(img, {
        model, tapeCode,
        fit: q.get('fit') === 'fill' ? 'fill' : 'contain',
        rotate: q.get('rotate') === '1',
        invert: q.get('invert') === '1',
        paddingMm: q.has('padding') ? Number(q.get('padding')) : undefined,
        marginMm: q.has('margin') ? Number(q.get('margin')) : undefined,
      });
    } catch (err) {
      throw httpError(400, err.message);
    }

    const cut = { each: TapeCut.EACH_LABEL, end: TapeCut.AFTER_JOB, none: TapeCut.NONE }[q.get('cut') || 'each'];
    const copies = Math.max(1, Math.min(99, Number(q.get('copies')) || 1));
    const bytes = buildNetworkJobBytes([page], {
      copies,
      tapeCut: cut ?? TapeCut.EACH_LABEL,
      halfCut: q.get('halfcut') === '1' ? 1 : 0,
      density: Math.max(-5, Math.min(5, Number(q.get('density')) || 0)),
      commandLevel: model.commandLevel,
    });
    await runNetworkJob(target, bytes, { pages: copies, tapeCode });
    json(res, 200, { ok: true, tape: tapeWidthLabel(tapeCode), lengthDots: page.lengthDots, copies });
  },

  // -- Bluetooth --

  'GET /devices': async (req, res) => {
    const reason = await bluetoothUnavailableReason();
    if (reason) { json(res, 200, { devices: [], error: reason }); return; }
    try {
      json(res, 200, { devices: await bt.RfcommTransport.list() });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  },

  'POST /connect': async (req, res) => {
    try {
      json(res, 200, { device: await connect(await readJson(req)) });
    } catch (err) {
      log(`Connection failed: ${err.message}`, 'err');
      json(res, 500, { error: err.message });
    }
  },

  'POST /disconnect': async (req, res) => {
    await disconnect();
    json(res, 200, { ok: true });
  },

  'POST /send': async (req, res) => {
    if (!transport) { json(res, 409, { error: 'Not connected to a printer' }); return; }
    try {
      const body = await readBody(req);
      const written = await transport.write(new Uint8Array(body));
      json(res, 200, { written });
    } catch (err) {
      log(`Send failed: ${err.message}`, 'err');
      json(res, 500, { error: err.message });
    }
  },
};

async function handleApi(req, res, url) {
  const route = ROUTES[`${req.method} ${url.pathname.slice('/api'.length)}`];
  if (!route) { json(res, 404, { error: 'unknown endpoint' }); return; }
  try {
    await route(req, res, url);
  } catch (err) {
    if (!res.headersSent) json(res, err.status || 500, { error: err.message });
    else res.end();
  }
}

const args = parseArgs(process.argv.slice(2));
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/healthz') { json(res, 200, { ok: true, version: VERSION }); return; }
  if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
  else await serveStatic(req, res, url.pathname);
});
// Long jobs keep the /net/print request open until the printer finishes
server.requestTimeout = 0;

server.listen(args.port, args.host, async () => {
  const btError = await bluetoothUnavailableReason();
  console.log(`TEPRA Web ${VERSION}  http://${args.host}:${args.port}/`);
  console.log(`  Wi-Fi / LAN (UDP+TCP 9100): enabled, ${store.list().length} saved printer(s)`);
  console.log(`  Bluetooth (RFCOMM): ${btError || 'available'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    for (const p of netPrinters.values()) p.cancel();
    await disconnect().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}
