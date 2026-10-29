// A small SR5900P emulator: answers the UDP 9100 control protocol and accepts
// jobs on TCP 9100, then "prints" them (validates the command stream and
// optionally writes each label as a PGM image).
//
//   node test/fake-sr5900p.mjs [--port 9100] [--host 0.0.0.0] [--tape 4] [--dump ./out]
//
// --tape is the TEPRA tape width code reported in the status (4 = 12mm, 5 = 18mm, ...).
// It is also importable from tests: startFakePrinter({ port, tape }).

import dgram from 'node:dgram';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Status TW byte for each TEPRA tape width code */
const TW_BY_CODE = { 1: 0x0b, 2: 0x01, 3: 0x02, 4: 0x03, 5: 0x04, 6: 0x05, 7: 0x06 };

/** Walks a job and returns its pages; throws on anything malformed. */
export function parseJob(buf) {
  const pages = [];
  const frames = [];
  let rows = [];
  let width = 0;
  let i = 0;
  while (i < buf.length) {
    if (buf[i] === 0x1b && buf[i + 1] === 0x7b) {
      const len = buf[i + 2];
      const body = buf.subarray(i + 3, i + 3 + len);
      if (body[len - 1] !== 0x7d) throw new Error(`Bad frame terminator at ${i}`);
      let sum = 0;
      for (let k = 0; k < len - 2; k++) sum += body[k];
      if ((sum & 0xff) !== body[len - 2]) throw new Error(`Bad checksum at ${i}`);
      frames.push(String.fromCharCode(body[0]));
      i += 3 + len;
    } else if (buf[i] === 0x1b && buf[i + 1] === 0x2e) {
      width = buf[i + 6] | (buf[i + 7] << 8);
      const bytes = (width + 7) >> 3;
      rows.push(buf.subarray(i + 8, i + 8 + bytes));
      i += 8 + bytes;
    } else if (buf[i] === 0x0c) {
      pages.push({ width, rows });
      rows = [];
      frames.push('FF');
      i += 1;
    } else {
      throw new Error(`Unexpected byte 0x${buf[i].toString(16)} at ${i}`);
    }
  }
  return { pages, frames };
}

function writePgm(file, page) {
  // One raster row per output column, dot 0 (MSB) at the bottom: the label as it reads
  const w = page.rows.length;
  const h = page.width;
  const img = Buffer.alloc(w * h, 255);
  page.rows.forEach((row, x) => {
    for (let d = 0; d < h; d++) {
      if (row[d >> 3] & (0x80 >> (d & 7))) img[(h - 1 - d) * w + x] = 0;
    }
  });
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`), img]));
}

export function startFakePrinter({ port = 9100, host = '127.0.0.1', tape = 4, dump = null, printMs = 600, quiet = false } = {}) {
  const state = { ST: 0, ER: 0, PP: 0, locked: false, jobs: [], log: [] };
  const say = (m) => { state.log.push(m); if (!quiet) console.log(`[fake] ${m}`); };

  const statusBody = () => {
    const b = Buffer.alloc(20);
    b[0] = 0x14; b[1] = state.ST; b[2] = state.ER; b[3] = TW_BY_CODE[tape] ?? 0; b[8] = 0x40;
    b.writeUInt16BE(state.PP & 0xffff, 12);
    return b;
  };

  const udp = dgram.createSocket('udp4');
  udp.on('message', (msg, rinfo) => {
    if (msg.length < 32 || msg.subarray(0, 4).toString() !== 'TPRT') return;
    const cmd = msg.readUInt32BE(16);
    let body;
    switch (cmd) {
      case 0x0001: body = statusBody(); break;
      case 0x0002:
        body = Buffer.from(state.locked ? [0x02, 0x01, 0x00] : [0x02, 0x00, 0x00]);
        state.locked = true;
        state.PP = 0;
        break;
      case 0x0003: state.locked = false; body = Buffer.from([0x03, 0x00, 0x00]); break;
      case 0x0101: body = Buffer.alloc(0); break;
      case 0x0100: body = Buffer.from([0x10]); break;
      default: body = Buffer.alloc(0);
    }
    say(`UDP cmd 0x${cmd.toString(16).padStart(4, '0')} → ${body.toString('hex') || '(empty)'}`);
    const header = Buffer.from(msg.subarray(0, 32));
    header.write('tprt', 0);
    header.writeUInt32BE(body.length, 20);
    udp.send(Buffer.concat([header, body]), rinfo.port, rinfo.address);
  });

  const tcp = net.createServer((sock) => {
    const chunks = [];
    sock.on('data', (c) => chunks.push(c));
    sock.on('error', () => {});
    sock.on('close', () => {
      const buf = Buffer.concat(chunks);
      if (!buf.length) return;
      let job;
      try {
        job = parseJob(buf);
      } catch (err) {
        say(`Rejected job: ${err.message}`);
        state.jobs.push({ error: err.message, bytes: buf.length });
        return;
      }
      state.jobs.push({ ...job, bytes: buf.length, data: buf });
      say(`Job: ${buf.length} bytes, ${job.pages.length} page(s), frames ${job.frames.join(' ')}`);
      if (dump) {
        fs.mkdirSync(dump, { recursive: true });
        const stamp = Date.now();
        fs.writeFileSync(path.join(dump, `job-${stamp}.bin`), buf);
        job.pages.forEach((p, n) => writePgm(path.join(dump, `job-${stamp}-${n + 1}.pgm`), p));
      }
      state.ST = 2;
      setTimeout(() => { state.ST = 0; state.PP += job.pages.length; }, printMs);
    });
  });

  return new Promise((resolve) => {
    udp.bind(port, host, () => {
      tcp.listen(port, host, () => {
        resolve({
          state,
          close: () => new Promise((r) => { udp.close(); tcp.close(() => r()); }),
        });
      });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? def : process.argv[i + 1];
  };
  const opts = {
    port: Number(arg('port', 9100)),
    host: arg('host', '0.0.0.0'),
    tape: Number(arg('tape', 4)),
    dump: arg('dump', null),
  };
  await startFakePrinter(opts);
  console.log(`Fake SR5900P on ${opts.host}:${opts.port} (UDP+TCP), tape code ${opts.tape}`);
}
