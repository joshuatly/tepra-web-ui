// Wi-Fi / LAN path: packet format, job bytes, PNG decoding and a full print
// against the fake SR5900P in test/fake-sr5900p.mjs.
// Run: node test/network.test.mjs

import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { buildNetworkJobBytes, TapeCut } from '../app/protocol.js';
import { findPrinter } from '../app/models.js';
import { makePacket, parsePacket, parseNetworkStatus, NetworkPrinter, isBusy } from '../server/network.js';
import { parseEnvPrinters, normalizePrinter } from '../server/printers.js';
import { decodePng } from '../server/png.js';
import { imageToPage } from '../server/imageprint.js';
import { startFakePrinter, parseJob } from './fake-sr5900p.mjs';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}\n  ${err.stack || err}`);
  }
}
const hex = (b) => Buffer.from(b).toString('hex');

// ---- Packets ---------------------------------------------------------------

await test('status request header matches takonomura/hikalium', () => {
  assert.equal(hex(makePacket(0x01)),
    '54505254' + '00000000' + '00000001' + '00000020' + '00000001' + '00000000' + '00000000' + '00000000');
  assert.equal(hex(makePacket(0x0101).subarray(16, 20)), '00000101');
});

await test('parsePacket accepts lowercase response signature', () => {
  const msg = Buffer.concat([makePacket(1), Buffer.from([1, 2, 3])]);
  msg.write('tprt', 0);
  const p = parsePacket(msg);
  assert.equal(p.cmd, 1);
  assert.equal(hex(p.body), '010203');
  assert.equal(parsePacket(Buffer.from('nope')), null);
});

await test('status bodies captured by hikalium', () => {
  const idle = parseNetworkStatus(Buffer.from([20, 0, 0, 4, 0, 0, 0, 0, 64, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  assert.equal(idle.ST, 0);
  assert.equal(idle.ER, 0);
  assert.equal(idle.tapeWidthCode, 5); // TW 0x04 = 18mm
  assert.equal(isBusy(idle), false);
  const printing = parseNetworkStatus(Buffer.from([20, 2, 0, 4, 0, 0, 0, 0, 64, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  assert.equal(isBusy(printing), true);
  const done = parseNetworkStatus(Buffer.from([20, 0, 0, 4, 0, 0, 0, 0, 64, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
  assert.equal(done.PP, 1);
  const tapeEnd = parseNetworkStatus(Buffer.from([20, 0, 66, 4, 0, 0, 0, 0, 64, 0, 0, 64, 0, 0, 66, 0, 64, 0, 0, 0]));
  assert.equal(tapeEnd.ER, 66);
  assert.throws(() => parseNetworkStatus(Buffer.alloc(12)));
});

// ---- Job bytes ---------------------------------------------------------------

await test('network job header is byte-identical to the captured SR5900P stream', () => {
  const page = { lengthDots: 104, widthDots: 8, marginDots: 42, rows: [Uint8Array.from([0xff])] };
  const bytes = buildNetworkJobBytes([page], {
    copies: 1, tapeCut: TapeCut.EACH_LABEL, halfCut: 1, density: 0, commandLevel: 3,
  });
  // From hikalium/sr5900p gen_tcp_data() with td.width = 100
  const expected = [
    27, 123, 3, 64, 64, 125,
    27, 123, 7, 123, 0, 0, 83, 84, 34, 125,
    27, 123, 7, 67, 2, 2, 1, 1, 73, 125,
    27, 123, 4, 68, 5, 73, 125,
    27, 123, 3, 71, 71, 125,
    27, 123, 7, 76, 104, 0, 0, 0, (76 + 104) & 0xff, 125,
    27, 123, 5, 84, 42, 0, 126, 125,
    27, 123, 4, 72, 5, 77, 125,
    27, 123, 4, 115, 0, 115, 125,
    0x1b, 0x2e, 0, 0, 0, 1, 8, 0, 0xff,
    0x0c,
    27, 123, 3, 64, 64, 125,
  ];
  assert.equal(hex(bytes), hex(expected));
});

await test('half-cut continuous adds the X frame only when enabled', () => {
  const page = { lengthDots: 10, widthDots: 8, marginDots: 0, rows: [Uint8Array.from([0])] };
  const opts = { copies: 1, tapeCut: 0, halfCut: 0, density: 0, commandLevel: 3 };
  assert.ok(!parseJob(Buffer.from(buildNetworkJobBytes([page], opts))).frames.includes('X'));
  assert.ok(parseJob(Buffer.from(buildNetworkJobBytes([page], { ...opts, halfCutContinuous: true }))).frames.includes('X'));
});

await test('copies repeat every page', () => {
  const page = { lengthDots: 3, widthDots: 16, marginDots: 0, rows: [new Uint8Array(2), new Uint8Array(2), new Uint8Array(2)] };
  const job = parseJob(Buffer.from(buildNetworkJobBytes([page, page], { copies: 3, tapeCut: 0, halfCut: 0, density: 0, commandLevel: 3 })));
  assert.equal(job.pages.length, 6);
  assert.equal(job.pages[0].rows.length, 3);
});

// ---- Printers config ---------------------------------------------------------

await test('TEPRA_PRINTERS parsing', () => {
  const list = parseEnvPrinters('192.168.1.50, Garage=10.0.0.2:9101@SR5900C');
  assert.equal(list.length, 2);
  assert.deepEqual([list[0].host, list[0].port, list[0].model], ['192.168.1.50', 9100, 'TEPRA PRO SR5900P']);
  assert.deepEqual([list[1].name, list[1].host, list[1].port, list[1].model], ['Garage', '10.0.0.2', 9101, 'TEPRA PRO SR5900C']);
  assert.throws(() => normalizePrinter({ host: '' }));
  assert.throws(() => normalizePrinter({ host: 'bad host!' }));
  assert.throws(() => normalizePrinter({ host: '1.2.3.4', port: 70000 }));
});

// ---- PNG ---------------------------------------------------------------------

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(width, height, colorType, depth, rowsRaw, extra = []) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth; ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), ...extra,
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rowsRaw))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

await test('PNG: RGBA with alpha and Sub/Up filters', () => {
  // 2x2: black opaque, transparent; white, red
  const png = makePng(2, 2, 6, 8, [
    Buffer.from([0, 0, 0, 0, 255, 0, 0, 0, 0]),                  // filter none
    Buffer.from([2, 255, 255, 255, 1, 255, 0, 0, 255]),          // filter up (adds row above)
  ]);
  const img = decodePng(png);
  assert.equal(img.width, 2);
  assert.deepEqual([...img.gray], [0, 255, 255, Math.floor(255 * 0.299)]);
});

await test('PNG: 1-bit grayscale', () => {
  const img = decodePng(makePng(10, 1, 0, 1, [Buffer.from([0, 0b10100000, 0b01000000])]));
  assert.deepEqual([...img.gray], [255, 0, 255, 0, 0, 0, 0, 0, 0, 255]);
});

await test('PNG: palette with tRNS', () => {
  const plte = chunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255]));
  const trns = chunk('tRNS', Buffer.from([0]));
  const img = decodePng(makePng(2, 1, 3, 8, [Buffer.from([0, 0, 1])], [plte, trns]));
  assert.deepEqual([...img.gray], [255, 255]);
  assert.throws(() => decodePng(Buffer.from('GIF89a')));
});

await test('imageToPage centres small images and scales big ones', () => {
  const model = findPrinter('TEPRA PRO SR5900P');
  const small = { width: 10, height: 10, gray: new Uint8ClampedArray(100) };
  const p = imageToPage(small, { model, tapeCode: 4, paddingMm: 0 });
  assert.equal(p.widthDots, 144);
  assert.ok(p.lengthDots >= 10);
  const big = { width: 400, height: 400, gray: new Uint8ClampedArray(400 * 400).fill(255) };
  const q = imageToPage(big, { model, tapeCode: 4, paddingMm: 0 });
  assert.equal(q.widthDots, 144);
  assert.equal(q.lengthDots, 144);
});

// ---- End to end against the emulator ---------------------------------------

const PORT = 19100 + Math.floor(Math.random() * 500);

await test('full print session against the fake printer', async () => {
  const fake = await startFakePrinter({ port: PORT, tape: 4, quiet: true, printMs: 300 });
  try {
    const printer = new NetworkPrinter('127.0.0.1', { port: PORT });
    const phases = [];
    printer.on('progress', (p) => phases.push(p.phase));
    const s = await printer.status();
    assert.equal(s.tapeWidthCode, 4);
    fake.state.log.length = 0;

    const page = { lengthDots: 50, widthDots: 144, marginDots: 14, rows: Array.from({ length: 50 }, () => new Uint8Array(18).fill(0xaa)) };
    const bytes = buildNetworkJobBytes([page], { copies: 2, tapeCut: 0, halfCut: 0, density: 0, commandLevel: 3 });
    await printer.print(bytes, { pages: 2, tapeCode: 4 });

    assert.equal(fake.state.jobs.length, 1);
    assert.equal(fake.state.jobs[0].pages.length, 2);
    assert.equal(fake.state.jobs[0].bytes, bytes.length);
    assert.equal(fake.state.locked, false, 'printer must be unlocked afterwards');
    const cmds = fake.state.log.filter((l) => l.startsWith('UDP')).map((l) => l.slice(8, 14));
    assert.deepEqual(cmds.slice(0, 4), ['0x0001', '0x0002', '0x0101', '0x0100']);
    assert.equal(cmds.at(-1), '0x0003');
    assert.ok(phases.includes('Done'));
  } finally {
    await fake.close();
  }
});

await test('tape mismatch is refused before anything is sent', async () => {
  const fake = await startFakePrinter({ port: PORT + 1, tape: 5, quiet: true });
  try {
    const printer = new NetworkPrinter('127.0.0.1', { port: PORT + 1 });
    await assert.rejects(printer.print(new Uint8Array([0x0c]), { tapeCode: 4 }), /Loaded tape is 18mm/);
    assert.equal(fake.state.jobs.length, 0);
    assert.equal(fake.state.locked, false);
  } finally {
    await fake.close();
  }
});

await test('unreachable printer times out cleanly', async () => {
  const printer = new NetworkPrinter('127.0.0.1', { port: PORT + 2 });
  await assert.rejects(printer.status(), /UDP|timed out/);
});

console.log(failed ? `${failed} failed, ${passed} passed` : `All passed (${passed})`);
if (failed) process.exitCode = 1;
