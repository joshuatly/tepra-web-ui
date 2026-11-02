// A small SR5900P emulator: answers the UDP 9100 control protocol and accepts
// jobs on TCP 9100, then "prints" them (validates the command stream and
// optionally writes each label as a PGM image).
//
//   node test/fake-sr5900p.mjs [--port 9100] [--host 0.0.0.0] [--tape 4] [--dump ./out]
//
// --tape is the TEPRA tape width code reported in the status (4 = 12mm, 5 = 18mm, ...).
// It is also importable from tests: startFakePrinter({ port, tape, ... }); see the options
// of startFakePrinter for the failure cases it can play.
//
// Like the real printer, it does not need the TCP connection to close: a job is taken as
// soon as its end (FF followed by the '@' frame) has arrived.

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
  const need = (n) => { if (i + n > buf.length) throw new Error(`Truncated job at ${i}`); };
  while (i < buf.length) {
    if (buf[i] === 0x1b && buf[i + 1] === 0x7b) {
      need(3);
      const len = buf[i + 2];
      need(3 + len);
      const body = buf.subarray(i + 3, i + 3 + len);
      if (body[len - 1] !== 0x7d) throw new Error(`Bad frame terminator at ${i}`);
      let sum = 0;
      for (let k = 0; k < len - 2; k++) sum += body[k];
      if ((sum & 0xff) !== body[len - 2]) throw new Error(`Bad checksum at ${i}`);
      frames.push(String.fromCharCode(body[0]));
      i += 3 + len;
    } else if (buf[i] === 0x1b && buf[i + 1] === 0x2e) {
      need(8);
      width = buf[i + 6] | (buf[i + 7] << 8);
      const bytes = (width + 7) >> 3;
      need(8 + bytes);
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

/** A 32-byte "tprt" reply header echoing `cmd` */
export function makeReplyHeader(cmd, bodyLength) {
  const h = Buffer.alloc(32);
  h.write('tprt', 0, 'ascii');
  h.writeUInt32BE(0x01, 8);
  h.writeUInt32BE(0x20, 12);
  h.writeUInt32BE(cmd, 16);
  h.writeUInt32BE(bodyLength, 20);
  return h;
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

/** The end of a job: FF, then the '@' frame */
const JOB_END = Buffer.from([0x0c, 0x1b, 0x7b, 0x03, 0x40, 0x40, 0x7d]);

/**
 * @param {object} [o]
 * @param {number[]} [o.silent]     commands whose requests take effect but are never answered
 *                                  (the reply is lost on the network)
 * @param {number} [o.er2]          byte 14 (ER2) of the status body, with ER left at 0
 * @param {(cmd:number, rinfo:object, reply:(cmd:number, body:Buffer)=>void)=>void} [o.beforeReply]
 *                                  called before each reply; `reply` sends an extra reply
 *                                  (e.g. one to another command) to the requester
 */
export function startFakePrinter({
  port = 9100, host = '127.0.0.1', tape = 4, dump = null, printMs = 600, quiet = false,
  silent = [], er2 = 0, beforeReply = null,
} = {}) {
  // events: { t, ev } in arrival order, for checking the order and the pauses between steps
  const state = { ST: 0, ER: 0, ER2: er2, PP: 0, locked: false, jobs: [], log: [], events: [], tcpOpen: 0 };
  const say = (m) => { state.log.push(m); if (!quiet) console.log(`[fake] ${m}`); };
  const event = (ev) => state.events.push({ t: Date.now(), ev });

  const statusBody = () => {
    const b = Buffer.alloc(20);
    b[0] = 0x14; b[1] = state.ST; b[2] = state.ER; b[3] = TW_BY_CODE[tape] ?? 0; b[8] = 0x40;
    b.writeUInt16BE(state.PP & 0xffff, 12);
    b[14] = state.ER2;
    return b;
  };

  const udp = dgram.createSocket('udp4');
  const send = (cmd, body, rinfo) => {
    const header = makeReplyHeader(cmd, body.length);
    udp.send(Buffer.concat([header, body]), rinfo.port, rinfo.address);
  };
  udp.on('message', (msg, rinfo) => {
    if (msg.length < 32 || msg.subarray(0, 4).toString() !== 'TPRT') return;
    const cmd = msg.readUInt32BE(16);
    event(`udp 0x${cmd.toString(16).padStart(4, '0')}`);
    let body;
    switch (cmd) {
      case 0x0001: body = statusBody(); break;
      case 0x0002:
        // a repeated start is answered like the first (seen on an SR5900P by uzuna/sr5900p)
        body = Buffer.from([0x02, 0x00, 0x00]);
        if (!state.locked) state.PP = 0;
        state.locked = true;
        break;
      case 0x0003:
        state.locked = false;
        state.tcpOpenAtUnlock = state.tcpOpen > 0;
        body = Buffer.from([0x03, 0x00, 0x00]);
        break;
      case 0x0101: body = Buffer.alloc(0); break;
      case 0x0100: body = Buffer.from([0x10]); break;
      default: body = Buffer.alloc(0);
    }
    if (silent.includes(cmd)) {
      say(`UDP cmd 0x${cmd.toString(16).padStart(4, '0')} → (reply lost)`);
      return;
    }
    say(`UDP cmd 0x${cmd.toString(16).padStart(4, '0')} → ${body.toString('hex') || '(empty)'}`);
    if (beforeReply) beforeReply(cmd, rinfo, (c, b) => send(c, b, rinfo));
    send(cmd, body, rinfo);
  });

  const tcp = net.createServer((sock) => {
    let chunks = [];
    state.tcpOpen++;
    event('tcp connect');
    sock.on('data', (c) => {
      if (!chunks.length) event('tcp data');
      chunks.push(c);
      // the client keeps the connection open until the session ends, so take the job
      // as soon as all of it has arrived
      const buf = Buffer.concat(chunks);
      if (buf.length > JOB_END.length && buf.subarray(-JOB_END.length).equals(JOB_END)) {
        let job;
        try { job = parseJob(buf); } catch { return; } // the marker was inside raster data
        chunks = [];
        takeJob(job, buf);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      state.tcpOpen--;
      event('tcp close');
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
      takeJob(job, buf);
    });
  });

  function takeJob(job, buf) {
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
  }

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
