// Wi-Fi / LAN diagnostics for SR5900P-class printers.
//
//   npm run netprobe -- 192.168.1.50            status only (prints nothing)
//   npm run netprobe -- 192.168.1.50 --test     also prints a short test pattern
//        --lead cut      cut the leading blank off instead of half-cutting it (default: half)
//        --halfcut       half cut between labels (with --copies > 1)
//        --copies N      print N copies in one job
//        --t-margin      send the leading margin in 'T' (as the official software does)
//                        instead of as blank rows
//   npm run netprobe -- --discover              broadcast for printers on the LAN
//   npm run netprobe -- 192.168.1.50 --port 9100 --model SR5900C

import { NetworkPrinter, discover, describeStatus, DEFAULT_PORT } from './network.js';
import { buildNetworkJobBytes, TapeCut } from '../app/protocol.js';
import { findPrinter, printableDots, tapeWidthLabel } from '../app/models.js';
import { toRasterRows } from '../app/raster.js';
import { resolveModel } from './printers.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? def : argv[i + 1];
};
const host = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.match(/^--(port|model|lead|copies)$/));

if (flag('discover') || !host) {
  console.log('Broadcasting a status request on UDP 9100…');
  const found = await discover();
  if (!found.length) {
    console.log('No printer answered. Make sure this machine is on the same LAN/VLAN as the printer.');
    if (!host) console.log('\nUsage: npm run netprobe -- <printer-ip> [--test]');
  }
  for (const f of found) console.log(`  ${f.host}  ${f.summary}`);
  if (!host) process.exit(found.length ? 0 : 1);
}

const port = Number(opt('port', DEFAULT_PORT));
const model = findPrinter(resolveModel(opt('model')));
const printer = new NetworkPrinter(host, { port });
printer.on('log', ({ message, kind }) => console.log(`  ${kind === 'info' ? '·' : kind === 'ok' ? '✓' : '!'} ${message}`));
printer.on('progress', ({ phase, done, total }) => process.stdout.write(`\r  ${phase} ${Math.round((done / total) * 100)}%   `));

console.log(`Printer ${host}:${port} (${model.model}, ${model.resolution} dpi)`);
let status;
try {
  status = await printer.status();
} catch (err) {
  console.log(`✗ ${err.message}`);
  console.log('  Check the IP address, that the printer is on and that UDP 9100 is not blocked.');
  process.exit(1);
}
console.log(`✓ ${describeStatus(status)}`);
console.log(`  raw status: ${status.raw}`);

if (!flag('test')) process.exit(0);

// A test pattern the width of the loaded tape: border, diagonal and a checker strip
const tapeCode = status.tapeWidthCode;
const dots = printableDots(tapeCode, model.resolution, model.modelNumber);
if (!dots) {
  console.log(`✗ Cannot print on ${tapeWidthLabel(tapeCode)} with ${model.model}`);
  process.exit(1);
}
const length = Math.round((30 / 25.4) * model.resolution);
const gray = new Uint8ClampedArray(length * dots).fill(255);
for (let y = 0; y < dots; y++) {
  for (let x = 0; x < length; x++) {
    const border = x < 4 || y < 4 || x >= length - 4 || y >= dots - 4;
    const diag = Math.abs(Math.round((x * dots) / length) - y) < 3;
    const checker = x > length * 0.6 && ((x >> 3) + (y >> 3)) % 2 === 0;
    if (border || diag || checker) gray[y * length + x] = 0;
  }
}
const { rows, widthDots, lengthDots } = toRasterRows({ width: length, height: dots, gray });
const copies = Math.max(1, Math.min(10, Number(opt('copies', 1)) || 1));
const jobOpts = {
  copies,
  tapeCut: TapeCut.EACH_LABEL,
  halfCut: flag('halfcut') ? 1 : 0,
  leadingHalfCut: model.halfcut ? opt('lead', 'half') !== 'cut' : undefined,
  density: 0,
  commandLevel: model.commandLevel,
  marginAsRows: !flag('t-margin'),
};
const bytes = buildNetworkJobBytes([{ rows, widthDots, lengthDots, marginDots: 14 }], jobOpts);
const cutFrame = [...bytes.subarray(16, 26)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
console.log(`Printing ${copies} × 30 mm test pattern on ${tapeWidthLabel(tapeCode)} (${bytes.length} bytes)…`);
console.log(`  cut frame: ${cutFrame}   leading margin: ${jobOpts.marginAsRows ? 'blank rows, T=0' : "'T' command"}`);
try {
  await printer.print(bytes, { pages: copies, tapeCode });
  console.log('\n✓ Done');
} catch (err) {
  console.log(`\n✗ ${err.message}`);
  process.exit(1);
}
