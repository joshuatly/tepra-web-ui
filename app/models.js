// 機種 / テープのテーブル。すべて TEPRA LINK 2 1.3.0 の
// TepraPrintProductInformation と libTepraPrint.so から抽出した値。
// 詳細は PROTOCOL.md を参照。

// PrintableSizeTable の列順 (dpi)
export const RESOLUTIONS = [180, 270, 360, 300];

// PrintableSizeTable[テープ幅コード][解像度インデックス] = 印字可能ドット数
const PRINTABLE_SIZE = {
  0: [0, 0, 0, 0],
  1: [22, 33, 44, 36],
  2: [36, 54, 72, 60],
  3: [54, 81, 108, 90],
  4: [72, 108, 144, 120],
  5: [108, 162, 216, 180],
  6: [128, 192, 288, 238],
  7: [192, 288, 384, 361],
  8: [0, 0, 0, 0],
  9: [0, 0, 0, 0],
  10: [297, 446, 595, 496],
  11: [652, 979, 1305, 1088],
  12: [297, 446, 595, 566],
};

// TepraPrintTapeWidth
export const TAPE_WIDTHS = [
  { code: 1, mm: 4, label: '4mm' },
  { code: 2, mm: 6, label: '6mm' },
  { code: 3, mm: 9, label: '9mm' },
  { code: 4, mm: 12, label: '12mm' },
  { code: 5, mm: 18, label: '18mm' },
  { code: 6, mm: 24, label: '24mm' },
  { code: 7, mm: 36, label: '36mm' },
  { code: 8, mm: 24, label: '24mm (cable)' },
  { code: 9, mm: 36, label: '36mm (cable)' },
  { code: 10, mm: 50, label: '50mm' },
  { code: 11, mm: 100, label: '100mm' },
  { code: 12, mm: 50, label: '50mm (new)' },
];

// TepraPrintProductInformation の _information。
// ble: DeviceConnectionBLE が受け付ける (statusLength === 22) 機種か。
export const PRINTERS = [
  { model: 'SR-R5600P', usbmdl: 'SR-R5600P', resolution: 180, statusLength: 22, commandLevel: 5, halfcut: false, lowSpeed: false, modelNumber: 18, tapeKinds: [1, 2, 3, 4, 5, 6] },
  { model: 'SR-R5600C', usbmdl: 'SR-R5600C', resolution: 180, statusLength: 22, commandLevel: 5, halfcut: false, lowSpeed: false, modelNumber: 19, tapeKinds: [1, 2, 3, 4, 5, 6] },
  { model: 'SR-R5600GS', usbmdl: 'SR-R5600GS', resolution: 180, statusLength: 22, commandLevel: 5, halfcut: false, lowSpeed: false, modelNumber: 20, tapeKinds: [1, 2, 3, 4, 5, 6] },
  { model: 'SR-MK1', usbmdl: 'SR-MK1', resolution: 360, statusLength: 78, commandLevel: 5, halfcut: false, lowSpeed: false, modelNumber: 7, tapeKinds: [1, 2, 3, 4, 5, 6] },
  { model: 'SR-R2500P', usbmdl: 'SR-R2500P', resolution: 180, statusLength: 78, commandLevel: 5, halfcut: false, lowSpeed: false, modelNumber: 8, tapeKinds: [1, 2, 3, 4, 5] },
  { model: 'TEPRA PRO SR-R7900P', usbmdl: 'SR-R7900P', resolution: 300, statusLength: 78, commandLevel: 4, halfcut: true, lowSpeed: true, modelNumber: 6, tapeKinds: [1, 2, 3, 4, 5, 6, 7, 12] },
  { model: 'TEPRA PRO SR5900P', usbmdl: 'SR5900P', resolution: 360, statusLength: 20, commandLevel: 3, halfcut: true, lowSpeed: true, modelNumber: 4, tapeKinds: [1, 2, 3, 4, 5, 6, 7] },
  { model: 'TEPRA PRO SR5900C', usbmdl: 'SR5900C', resolution: 360, statusLength: 20, commandLevel: 3, halfcut: true, lowSpeed: true, modelNumber: 16, tapeKinds: [1, 2, 3, 4, 5, 6, 7] },
  { model: 'TEPRA PRO SR5900GS', usbmdl: 'SR5900GS', resolution: 360, statusLength: 20, commandLevel: 3, halfcut: true, lowSpeed: true, modelNumber: 17, tapeKinds: [1, 2, 3, 4, 5, 6, 7] },
  { model: 'SR5500P', usbmdl: 'SR5500P', resolution: 180, statusLength: 8, commandLevel: 1, halfcut: false, lowSpeed: false, modelNumber: 5, tapeKinds: [1, 2, 3, 4, 5, 6] },
];

export function findPrinter(model) {
  return PRINTERS.find((p) => p.model === model) || PRINTERS[0];
}

/** アドバタイズ名から機種を推定する (makePrinterInfoFromBLEDevice と同じ照合)。 */
export function printerFromAdvertisedName(name) {
  if (!name) return null;
  // 長いキーから順に見て "SR-R5600P" が "SR-R5600" 等に負けないようにする
  const sorted = [...PRINTERS].sort((a, b) => b.usbmdl.length - a.usbmdl.length);
  return sorted.find((p) => name.indexOf(p.usbmdl) !== -1) || null;
}

/** TepraPrintProductInformation.getPrintableSize() */
export function printableDots(tapeCode, resolution, modelNumber) {
  if ((modelNumber === 1300 || modelNumber === 8) && tapeCode === 5) return 96;
  if (modelNumber === 7 && tapeCode === 6) return 256;
  const row = PRINTABLE_SIZE[tapeCode] || PRINTABLE_SIZE[0];
  const idx = RESOLUTIONS.indexOf(resolution);
  if (idx === -1) return 0;
  return row[idx];
}

// CommandFilter::tapeWidthFromLWStatusTWCode()
const TW_CODE_MAP = {
  0x01: 2, 0x02: 3, 0x03: 4, 0x04: 5, 0x05: 6, 0x06: 7, 0x07: 12, 0x0b: 1,
  0x11: 8, 0x12: 9, 0x21: 10, 0x23: 11,
  0x51: 2, 0x52: 3, 0x53: 4, 0x54: 5, 0x55: 6, 0x56: 7, 0x57: 12, 0x5b: 1,
};

export function tapeWidthFromStatusCode(raw) {
  if (raw === 0) return 0;
  const v = TW_CODE_MAP[raw];
  return v === undefined ? -1 : v;
}

export function tapeWidthLabel(code) {
  if (code === 0) return 'No tape';
  if (code === -1) return 'Unknown';
  const t = TAPE_WIDTHS.find((t) => t.code === code);
  return t ? t.label : `code ${code}`;
}

// PrintCoreStatus
export const PRINTER_STATUS = {
  0: 'Idle', 1: 'Feeding tape', 2: 'Printing', 3: 'Receiving data',
  4: 'Feed complete', 5: 'Print complete', 6: 'Pick&Print printing',
  16: 'Demo printing', 17: 'Feeding (from printer)', 18: 'Printing (from printer)',
  19: 'Updating firmware', 32: 'Small roll standby', 34: 'Waiting for label removal',
  72: 'Embossing', 74: 'Emboss feed', 75: 'Emboss feed complete', 255: 'Unexpected error',
};

// PrintCoreDeviceStatus
export const DEVICE_ERROR = {
  0: 'No error', 1: 'Cutter error', 6: 'No tape cartridge',
  21: 'Print head overheated', 32: 'Cancelled on printer', 33: 'Cover is open',
  34: 'Low voltage', 35: 'Cancelled by power off', 36: 'Tape eject error',
  48: 'Tape feed error', 64: 'Ink ribbon slack', 65: 'Ink ribbon low',
  66: 'Tape end', 67: 'Label cut error', 68: 'Temperature error',
  69: 'Missing parameter', 80: 'Half-cutter blade not installed', 81: 'Full-cutter blade not installed',
  82: 'Half-cutter blade detached', 83: 'Full-cutter blade detached',
  84: 'Winder cover open', 85: 'Vinyl tape temperature error', 86: 'Winder error',
  87: 'Half cut / full cut', 88: 'Big roll recognition error', 89: 'Big roll not supported',
  92: 'Stopped by auto power off', 93: 'Stopped by power source change',
  94: 'Winder set', 95: 'Winder not set', 96: 'Winder half cut / full cut',
  255: 'Unexpected error',
};
