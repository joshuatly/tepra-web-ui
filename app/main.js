// UI wiring.

import {
  PRINTERS, TAPE_WIDTHS, findPrinter, printableDots, printerFromAdvertisedName,
  tapeWidthLabel, PRINTER_STATUS, DEVICE_ERROR,
} from './models.js';
import {
  buildJobBytes, buildNetworkJobBytes, toHex, PrintSpeed, SUPPORTED_COMMAND_LEVELS,
} from './protocol.js';
import {
  grayscale, ditherFloydSteinberg, toRasterRows, contentMarginDots, dotsToMm,
} from './raster.js';
import { renderLabel, drawPreview, drawBinarizedPreview } from './editor.js';
import {
  cssFamily, hasLocalFontApi, localFontPermission,
  queryLocalFamilies, knownFamilies, sortFamilies, ensureFontLoaded,
} from './fonts.js';
import {
  createItem, itemLabel, normalizeDesign, serializeJob, parseJob,
} from './joblist.js';
import { BackendLink } from './backend.js';
import { NetworkLink } from './netlink.js';
import { PrintJob, tapeFeed, fetchStatus, endSession } from './job.js';

const $ = (id) => document.getElementById(id);

let currentJob = null;
let printing = false;
let labelImage = null;      // HTMLImageElement (描画用)
let labelImageUrl = null;   // 同じ画像の data URL (ジョブ保存用)
let lastRender = null; // { canvas, page }
let backendState = null;

// ---- Transports ---------------------------------------------------------
// Wi-Fi / LAN (SR5900P family) via NetworkLink, Bluetooth Classic via BackendLink.
// Both talk to the backend; the backend does the actual printer I/O.

/** Small localStorage wrapper: storage can be unavailable (private mode, blocked). */
const prefs = {
  get(key, def = null) {
    try { return localStorage.getItem(`tepra-web.${key}`) ?? def; } catch { return def; }
  },
  set(key, value) {
    try { localStorage.setItem(`tepra-web.${key}`, value); } catch { /* ignore */ }
  },
};

/** 'network' or 'bluetooth' */
function connKind() {
  return document.querySelector('input[name=conn-kind]:checked').value;
}

let netLink = null;

function getNetLink() {
  if (!netLink) {
    netLink = new NetworkLink();
    netLink.addEventListener('log', (e) => log(e.detail.message, e.detail.kind));
    netLink.addEventListener('status', (e) => {
      showStatus(e.detail);
      matchLoadedTape(e.detail);
    });
    netLink.addEventListener('progress', (e) => {
      const p = e.detail;
      if (printing) setProgress(p.done, p.total, p.phase);
    });
  }
  return netLink;
}

let link = null;

function getLink() {
  if (!link) {
    link = new BackendLink();
    link.addEventListener('log', (e) => log(e.detail.message, e.detail.kind));
    link.addEventListener('status', (e) => showStatus(e.detail));
    link.addEventListener('disconnected', () => {
      if (active !== link) return;
      const wasPrinting = printing;
      setConnected(false);
      setPrinting(false);
      if (expectDisconnect) return;
      // 自分から切ったわけではない = プリンタの電源断・スリープ・他端末の割り込みなど
      showReconnect(wasPrinting
        ? 'Lost the connection while printing. Check the tape, then reconnect.'
        : 'Lost the connection to the printer. Please reconnect.');
    });
  }
  return link;
}

/** いま接続中のリンク (未接続なら null) */
let active = null;

// ---- 再接続 -------------------------------------------------------------

/** 最後に接続できた相手。再接続はこれを使うので探し直さなくてよい。 */
let lastTarget = null;
/** 自分から切るときに立てる。切断通知で再接続を促さないため。 */
let expectDisconnect = false;

function showReconnect(message) {
  $('reconnect-message').textContent = lastTarget
    ? `${message} (${lastTarget.model} / ${lastTarget.host || lastTarget.id})`
    : message;
  $('btn-reconnect').hidden = !lastTarget;
  $('reconnect-banner').hidden = false;
}

function hideReconnect() {
  $('reconnect-banner').hidden = true;
}

/**
 * 接続の実体。「プリンタに接続」と「再接続」で共用する。
 *
 * プリンタの電源が入っていないと RFCOMM のタイムアウトまで 15〜20 秒かかるので、
 * その間ボタンを止めて「接続中」と出す。
 */
async function connectTo(target) {
  if (target.kind === 'network') return connectNetwork(target);
  return connectBluetooth(target);
}

/** Wi-Fi / LAN: "connected" means the printer answered a status request. */
async function connectNetwork(printer) {
  const target = getNetLink();
  $('conn-state').textContent = 'Connecting…';
  $('btn-connect').disabled = true;
  let device;
  try {
    device = await target.connect(printer);
  } finally {
    $('btn-connect').disabled = false;
  }
  active = target;
  lastTarget = { kind: 'network', ...device };
  hideReconnect();
  setConnected(true, `${device.name || device.host} · Wi-Fi`);
  log(`Connected to ${device.name || device.host} (${device.host}:${device.port})`, 'ok');
  startStatusPolling();
  return device;
}

async function connectBluetooth({ id, model, channel }) {
  const target = getLink();
  $('conn-state').textContent = 'Connecting…';
  $('btn-connect').disabled = true;
  // バックエンドは繋ぎ直す前に古い接続を切るので、その通知で帯を出さない
  expectDisconnect = true;
  let device;
  try {
    device = await target.connect({ id, model, channel });
  } finally {
    expectDisconnect = false;
    $('btn-connect').disabled = false;
  }
  active = target;
  lastTarget = { kind: 'bluetooth', id, model, channel: device.channel ?? channel ?? null };
  hideReconnect();
  setConnected(true, `${device.model} / RFCOMM ch${device.channel ?? '?'}`);
  try {
    showStatus(await fetchStatus(active));
  } catch (err) {
    log(`Could not read status: ${err.message}`, 'warn');
  }
  return device;
}

// ---- 初期化 -------------------------------------------------------------

function initSelects() {
  // statusLength 22 の 3 機種 (SR-R5600P/C/GS) は BLE 専用で、
  // Bluetooth Classic のプロファイルを持たないため RFCOMM では繋がらない。
  $('printer').innerHTML = PRINTERS
    .map((p) => {
      const bleOnly = p.statusLength === 22;
      return `<option value="${p.model}"${bleOnly ? ' data-bleonly="1"' : ''}>`
        + `${p.model}${bleOnly ? ' (BLE only, not supported)' : ''}</option>`;
    })
    .join('');
  $('printer').value = PRINTERS.some((p) => p.model === prefs.get('model'))
    ? prefs.get('model')
    : 'TEPRA PRO SR5900P';
  refreshTapeOptions();
}

// ---- フォント -----------------------------------------------------------

const FONT_STORAGE_KEY = 'font';

/** いま選べるファミリ名 */
let fontFamilies = [];

/** 一覧が無いときの逃げ道。ここに挙げた順で最初に見つかったものを既定にする。 */
const PREFERRED_FONTS = [
  'Helvetica Neue', 'Helvetica', 'Arial', 'Segoe UI', 'Roboto', 'Noto Sans', 'DejaVu Sans',
  'Hiragino Sans', 'ヒラギノ角ゴシック', 'Noto Sans JP', 'Yu Gothic', 'YuGothic', 'Meiryo',
];

function setFontFamilies(list, { keep = true } = {}) {
  const current = keep ? $('font').value : '';
  fontFamilies = sortFamilies(list);
  renderFontOptions(current || pickDefaultFont());
}

function pickDefaultFont() {
  const saved = prefs.get(FONT_STORAGE_KEY);
  if (saved && fontFamilies.includes(saved)) return saved;
  for (const name of PREFERRED_FONTS) {
    if (fontFamilies.includes(name)) return name;
  }
  return fontFamilies[0] || 'sans-serif';
}

/** 絞り込みを反映して <option> を作り直す。選択中のものは必ず残す。 */
function renderFontOptions(select) {
  const filter = $('font-filter').value.trim().toLowerCase();
  const chosen = select ?? $('font').value;
  const shown = filter
    ? fontFamilies.filter((f) => f.toLowerCase().includes(filter))
    : fontFamilies;
  // 絞り込みで選択中のものが消えると <select> の値が勝手に変わってしまうので、
  // 一致しなくても先頭に残す (件数表示は一致した数を出す)
  const list = shown.includes(chosen) || !chosen ? shown : [chosen, ...shown];

  // フォント名は OS 由来なので innerHTML では組み立てない
  $('font').replaceChildren(...list.map((family) => {
    const option = document.createElement('option');
    option.value = family;
    option.textContent = family;
    option.style.fontFamily = cssFamily(family);   // 一覧をそのフォントで見せる
    return option;
  }));
  if (list.includes(chosen)) $('font').value = chosen;

  const total = fontFamilies.length;
  $('font-count').textContent = filter ? `${shown.length} / ${total}` : `${total}`;
}

async function useFont(family) {
  prefs.set(FONT_STORAGE_KEY, family);
  // canvas は未読み込みのフォントを黙って代替に差し替えるので、待ってから描く
  await ensureFontLoaded(`16px ${cssFamily(family)}`, $('text').value || 'A');
  refresh();
}

/** インストール済みフォントを読み込む。ユーザー操作の中から呼ぶこと。 */
async function loadLocalFonts({ silent = false } = {}) {
  try {
    const families = await queryLocalFamilies();
    if (!families.length) throw new Error('No fonts returned');
    setFontFamilies(families);
    await useFont($('font').value);
    log(`Loaded ${families.length} installed fonts`, 'ok');
    $('btn-load-fonts').disabled = true;
    $('btn-load-fonts').textContent = 'Loaded';
  } catch (err) {
    if (silent) return;
    // 許可を拒否された場合もここに来る
    log(`Could not list fonts: ${err.message}`, 'warn');
  }
}

async function initFonts() {
  setFontFamilies(knownFamilies(), { keep: false });

  if (!hasLocalFontApi()) {
    $('btn-load-fonts').disabled = true;
    $('btn-load-fonts').textContent = 'Not supported in this browser';
    log('Listing installed fonts needs Chrome or Edge (and HTTPS or localhost). '
      + 'Only common fonts are offered.', 'warn');
  } else if (await localFontPermission() === 'granted') {
    // 一度許可していればダイアログ無しで取れる (取れなければボタンを残す)
    await loadLocalFonts({ silent: true });
  }

  await useFont($('font').value);
}

function refreshTapeOptions() {
  const printer = findPrinter($('printer').value);
  const prev = $('tape').value;
  const opts = TAPE_WIDTHS
    .filter((t) => printer.tapeKinds.includes(t.code))
    .map((t) => {
      const dots = printableDots(t.code, printer.resolution, printer.modelNumber);
      return `<option value="${t.code}">${t.label} — ${dots} dot</option>`;
    });
  $('tape').innerHTML = opts.join('');
  if (prev && [...$('tape').options].some((o) => o.value === prev)) $('tape').value = prev;
  else $('tape').value = String(printer.tapeKinds.includes(4) ? 4 : printer.tapeKinds[0]);
}

// ---- ジョブ -------------------------------------------------------------

/** @type {{id:string,name:string,copies:number,design:object}[]} */
let jobItems = [];
let selectedItemId = null;
/** id → buildItemPage() の結果。機種・テープ幅を変えたら捨てる。 */
let itemPageCache = new Map();

function selectedItem() {
  return jobItems.find((it) => it.id === selectedItemId) || null;
}

function invalidateJobPages() {
  itemPageCache = new Map();
}

async function itemPage(item) {
  if (!itemPageCache.has(item.id)) itemPageCache.set(item.id, await buildItemPage(item));
  return itemPageCache.get(item.id);
}

/** 一覧を組み直して、合計枚数とテープ長を出す */
async function renderJobList() {
  const list = $('job-list');
  const dpi = currentPrinter().resolution;

  const built = [];
  for (const item of jobItems) built.push(await itemPage(item));

  list.replaceChildren(...jobItems.map((item, index) => {
    const page = built[index];
    const li = document.createElement('li');
    li.dataset.id = item.id;
    li.setAttribute('aria-selected', item.id === selectedItemId ? 'true' : 'false');

    const idx = document.createElement('span');
    idx.className = 'job-index';
    idx.textContent = String(index + 1);

    const thumb = document.createElement('canvas');
    thumb.className = 'job-thumb';
    if (page) drawThumb(thumb, page.canvas);

    const body = document.createElement('div');
    body.className = 'job-body';
    const name = document.createElement('div');
    name.className = 'job-name';
    name.textContent = itemLabel(item);
    const meta = document.createElement('div');
    meta.className = 'job-meta';
    meta.textContent = page
      ? `${page.page.lengthDots} dot / ${dotsToMm(page.page.lengthDots, dpi).toFixed(1)} mm`
      : 'Cannot print on this tape width';
    body.append(name, meta);

    // 枚数はその場で変えられるようにする
    const copies = document.createElement('input');
    copies.type = 'number';
    copies.className = 'job-copies';
    copies.min = '1';
    copies.max = '99';
    copies.value = String(item.copies);
    copies.title = 'Copies';
    copies.addEventListener('click', (e) => e.stopPropagation());
    copies.addEventListener('change', () => {
      item.copies = Math.max(1, Math.min(99, Number(copies.value) || 1));
      copies.value = String(item.copies);
      updateJobSummary();
    });

    const buttons = document.createElement('div');
    buttons.className = 'job-buttons';
    buttons.append(
      jobButton('↑', 'Move up', index === 0, () => moveItem(index, -1)),
      jobButton('↓', 'Move down', index === jobItems.length - 1, () => moveItem(index, 1)),
      jobButton('✕', 'Remove', false, () => removeItem(item.id)),
    );

    li.append(idx, thumb, body, copies, buttons);
    li.addEventListener('click', () => selectItem(item.id));
    return li;
  }));

  updateJobSummary(built);
}

function jobButton(label, title, disabled, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.title = title;
  b.disabled = disabled;
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

/** テープ高さが 24px くらいになるよう縮めて描く (長いラベルは途中で切る) */
function drawThumb(canvas, source) {
  const TARGET_HEIGHT = 24;
  const MAX_WIDTH = 120;
  const scale = Math.min(1, TARGET_HEIGHT / Math.max(1, source.height));
  const srcWidth = Math.min(source.width, Math.round(MAX_WIDTH / scale));

  canvas.height = Math.max(1, Math.round(source.height * scale));
  canvas.width = Math.max(1, Math.round(srcWidth * scale));

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = scale < 1;   // 縮小のときだけ補間する
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, srcWidth, source.height, 0, 0, canvas.width, canvas.height);
}

/** 直近に描いたページ。枚数やセット数だけ変えたときの再計算に使う。 */
let lastJobBuild = [];

function updateJobSummary(built = null) {
  if (built) lastJobBuild = built;
  const has = jobItems.length > 0;
  const sets = Math.max(1, Number($('job-sets').value) || 1);
  const labels = jobItems.reduce((n, it) => n + it.copies, 0) * sets;

  let text = has ? `${jobItems.length} item(s) / ${labels} label(s)` : '(empty)';
  if (has && lastJobBuild.length === jobItems.length) {
    const dpi = currentPrinter().resolution;
    const mm = lastJobBuild.reduce((sum, b, i) => sum
      + (b ? dotsToMm(b.page.lengthDots, dpi) * jobItems[i].copies : 0), 0);
    const bytes = lastJobBuild.reduce((sum, b, i) => sum
      + (b ? b.page.rows.length * (8 + ((b.page.widthDots + 7) >> 3)) * jobItems[i].copies : 0), 0);
    text += ` / ~${(mm * sets).toFixed(0)} mm / raster ${(bytes * sets).toLocaleString()} B`;
  }
  $('job-summary').textContent = text;

  $('btn-job-print').disabled = !has || printing || !active?.connected;
  $('btn-job-save').disabled = !has;
  $('btn-job-clear').disabled = !has;
  const sel = !!selectedItem();
  $('btn-job-update').disabled = !sel;
  $('btn-job-edit').disabled = !sel;
}

function selectItem(id) {
  selectedItemId = selectedItemId === id ? null : id;
  for (const li of $('job-list').children) {
    li.setAttribute('aria-selected', li.dataset.id === selectedItemId ? 'true' : 'false');
  }
  updateJobSummary();
}

function moveItem(index, delta) {
  const to = index + delta;
  if (to < 0 || to >= jobItems.length) return;
  const [item] = jobItems.splice(index, 1);
  jobItems.splice(to, 0, item);
  renderJobList();
}

function removeItem(id) {
  jobItems = jobItems.filter((it) => it.id !== id);
  itemPageCache.delete(id);
  if (selectedItemId === id) selectedItemId = null;
  renderJobList();
}

// ---- 版下の生成 ---------------------------------------------------------

/**
 * UI から「版下の設定」だけを読む。機種・テープ幅・カット設定は含めない
 * (それらは印刷時の設定で、ジョブの項目ごとには持たない)。
 */
function readDesignFromUI() {
  return normalizeDesign({
    text: $('text').value,
    fontFamily: $('font').value,
    bold: $('bold').checked,
    italic: $('italic').checked,
    fontScale: Number($('font-scale').value),
    lineGapDots: Number($('line-gap').value),
    align: $('align').value,
    lengthMode: $('length-mode').value,
    fixedLengthMm: Number($('fixed-length').value),
    paddingMm: Number($('padding').value),
    tapeMarginMm: Number($('tape-margin').value),
    border: $('border').checked,
    dither: $('dither').checked,
    flip: $('flip').checked,
    imageDataUrl: labelImageUrl,
    imagePosition: $('image-pos').value,
  });
}

/** 版下の設定を UI に流し込む。画像の読み込みがあるので非同期。 */
async function applyDesignToUI(design) {
  $('text').value = design.text;
  if (!fontFamilies.includes(design.fontFamily)) fontFamilies = sortFamilies([...fontFamilies, design.fontFamily]);
  renderFontOptions(design.fontFamily);
  $('bold').checked = design.bold;
  $('italic').checked = design.italic;
  $('font-scale').value = String(design.fontScale);
  $('font-scale-out').textContent = `${design.fontScale}%`;
  $('line-gap').value = String(design.lineGapDots);
  $('line-gap-out').textContent = `${design.lineGapDots} dot`;
  $('align').value = design.align;
  $('length-mode').value = design.lengthMode;
  $('fixed-length').value = String(design.fixedLengthMm);
  $('fixed-length').disabled = design.lengthMode !== 'fixed';
  $('padding').value = String(design.paddingMm);
  $('tape-margin').value = String(design.tapeMarginMm);
  $('border').checked = design.border;
  $('dither').checked = design.dither;
  $('flip').checked = design.flip;
  $('image-pos').value = design.imagePosition;

  labelImageUrl = design.imageDataUrl;
  labelImage = design.imageDataUrl ? await loadImage(design.imageDataUrl).catch(() => null) : null;
  if (design.imageDataUrl && !labelImage) log('Could not load the image stored in the batch item', 'warn');
  $('image').value = '';

  await ensureFontLoaded(`16px ${cssFamily(design.fontFamily)}`, design.text || 'A');
}

/** data URL / object URL から HTMLImageElement を作る */
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Cannot read the image'));
    img.src = url;
  });
}

/** 版下の設定 + 機種 + テープ幅 → renderLabel に渡す LabelSpec */
function specFrom(design, printer, tapeCode, image) {
  return {
    printer,
    tapeCode,
    lines: design.text.split('\n'),
    fontFamily: cssFamily(design.fontFamily),
    bold: design.bold,
    italic: design.italic,
    fontScale: design.fontScale / 100,
    lineGapDots: design.lineGapDots,
    align: design.align,
    heightDots: printableDots(tapeCode, printer.resolution, printer.modelNumber),
    dpi: printer.resolution,
    lengthMode: design.lengthMode,
    fixedLengthMm: design.fixedLengthMm,
    paddingMm: design.paddingMm,
    border: design.border,
    image,
    imagePosition: design.imagePosition,
    imageGapMm: 1.5,
  };
}

/** 版下描画 → 2値化 → ラスタ行までを作る */
function rasterize(spec, design) {
  if (!spec.heightDots) return null;

  const { canvas, lengthDots, heightDots } = renderLabel(spec);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let img = grayscale(ctx.getImageData(0, 0, lengthDots, heightDots));
  if (design.dither) img = ditherFloydSteinberg(img);

  const { rows, widthDots } = toRasterRows(img, { flip: design.flip });
  const marginDots = contentMarginDots(design.tapeMarginMm, spec.dpi, lengthDots);

  return {
    spec,
    canvas,
    binarized: img,
    page: { lengthDots, widthDots, marginDots, rows },
  };
}

function currentPrinter() {
  return findPrinter($('printer').value);
}

/** いま UI にある版下 */
function buildPage() {
  const design = readDesignFromUI();
  const printer = currentPrinter();
  const tapeCode = Number($('tape').value);
  return rasterize(specFrom(design, printer, tapeCode, labelImage), design);
}

/** ジョブの項目を、いまの機種・テープ幅で描く */
async function buildItemPage(item) {
  const image = item.design.imageDataUrl
    ? await loadImage(item.design.imageDataUrl).catch(() => null)
    : null;
  const spec = specFrom(item.design, currentPrinter(), Number($('tape').value), image);
  return rasterize(spec, item.design);
}

function printOptions(copies = Math.max(1, Number($('copies').value) || 1)) {
  const printer = currentPrinter();
  return {
    copies,
    tapeCut: Number($('tape-cut').value),
    halfCut: Number($('half-cut').value),
    density: Math.max(-5, Math.min(5, Number($('density').value) || 0)),
    priorityPrint: false,
    // ページ環境コマンドは機種の commandLevel で中身が変わる
    commandLevel: printer.commandLevel,
    printSpeed: PrintSpeed.HIGH,
    halfCutContinuous: false,
    objectType: 0,
  };
}

function refresh() {
  const built = buildPage();
  lastRender = built;
  if (!built) {
    $('size-info').textContent = 'Cannot print on this tape width';
    return;
  }
  const { spec, canvas, binarized, page } = built;
  const mode = document.querySelector('input[name=preview-mode]:checked').value;
  // テープ高さがだいたい 140px になるよう整数倍で拡大する
  const scale = Math.max(1, Math.min(8, Math.round(140 / Math.max(1, canvas.height))));
  if (mode === 'dots') drawBinarizedPreview($('preview'), binarized, scale);
  else drawPreview($('preview'), canvas, scale);

  const lenMm = dotsToMm(page.lengthDots, spec.dpi).toFixed(1);
  const bytes = page.rows.length * (8 + ((page.widthDots + 7) >> 3));
  $('size-info').textContent =
    `${page.lengthDots} × ${page.widthDots} dot / ${lenMm} mm / ${spec.dpi} dpi / ${bytes.toLocaleString()} B`;
}

// ---- ログ / 状態表示 -----------------------------------------------------

function log(message, kind = 'info') {
  const el = $('log');
  const time = new Date().toLocaleTimeString([], { hour12: false });
  const line = document.createElement('div');
  if (kind !== 'info') line.className = kind;
  line.textContent = `[${time}] ${message}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function showStatus(s) {
  $('st-state').textContent = `${PRINTER_STATUS[s.ST] ?? 'Unknown'} (0x${s.ST.toString(16)})`;
  const err = DEVICE_ERROR[s.ER] ?? `Unknown (${s.ER})`;
  $('st-error').textContent = s.ER === 0 ? 'None' : err;
  $('st-error').style.color = s.ER === 0 ? '' : 'var(--err)';
  $('st-tape').textContent = `${tapeWidthLabel(s.tapeWidthCode)} (TW=0x${s.TW.toString(16).padStart(2, '0')}, type ${s.TR})`;
  $('st-buffer').textContent = `${s.RB ? `buffer ${s.RB.toLocaleString()} B / ` : ''}printed ${s.PP} label(s)`;
}

/** Whether the backend can use Bluetooth (set by initTransport) */
let btAvailable = false;

function setConnected(on, label) {
  if (!on) {
    active = null;
    stopStatusPolling();
  }
  $('conn-state').textContent = on ? (label || 'Connected') : 'Not connected';
  $('conn-state').className = `pill ${on ? 'pill-on' : 'pill-off'}`;
  $('btn-connect').hidden = on;
  $('btn-disconnect').hidden = !on;
  for (const el of document.querySelectorAll('input[name=conn-kind]')) el.disabled = on;
  for (const id of ['device', 'channel', 'net-printer', 'net-host', 'net-name']) $(id).disabled = on;
  $('btn-scan').disabled = on || !btAvailable;
  $('btn-net-discover').disabled = on;
  setPrinting(printing);
}

function setPrinting(on) {
  printing = on;
  const ready = !!active && active.connected;
  const bluetooth = ready && active.kind !== 'network';
  $('btn-print').disabled = on || !ready;
  $('btn-print-mobile').disabled = on || !ready;
  $('btn-print-mobile').textContent = on ? 'Printing…' : 'Print';
  $('mobile-info').textContent = ready ? $('conn-state').textContent : 'Connect a printer first';
  $('btn-cancel').disabled = !on;
  $('btn-status').disabled = on || !ready;
  // Tape feed over Wi-Fi has not been captured from the official software yet
  for (const id of ['btn-feed', 'btn-feed-cut']) $(id).disabled = on || !bluetooth;
  updateJobSummary();
}

// ---- Wi-Fi / LAN printers ---------------------------------------------------

/** Saved printers from the backend */
let netPrinters = [];

function renderNetPrinters(selectId = $('net-printer').value || prefs.get('net-printer')) {
  const select = $('net-printer');
  if (!netPrinters.length) {
    select.innerHTML = '<option value="">(none saved yet)</option>';
  } else {
    select.replaceChildren(...netPrinters.map((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = `${p.name} — ${p.host}${p.port !== 9100 ? `:${p.port}` : ''}${p.fromEnv ? ' (config)' : ''}`;
      return o;
    }), Object.assign(document.createElement('option'), { value: '', textContent: 'Other…' }));
    select.value = netPrinters.some((p) => p.id === selectId) ? selectId : netPrinters[0].id;
  }
  onNetPrinterSelected();
}

function selectedNetPrinter() {
  return netPrinters.find((p) => p.id === $('net-printer').value) || null;
}

function onNetPrinterSelected() {
  const p = selectedNetPrinter();
  $('btn-net-remove').disabled = !p || !!p.fromEnv;
  if (p) {
    $('net-host').value = p.host + (p.port !== 9100 ? `:${p.port}` : '');
    $('net-name').value = p.name;
    prefs.set('net-printer', p.id);
    if (connKind() === 'network') setModel(p.model);
  }
}

function setModel(model) {
  if (!model || $('printer').value === model) return;
  if (![...$('printer').options].some((o) => o.value === model)) return;
  $('printer').value = model;
  prefs.set('model', model);
  refreshTapeOptions();
  refresh();
  invalidateJobPages();
  renderJobList();
}

/** What "Connect" should use in Wi-Fi mode: the saved printer or the typed address. */
function networkTarget() {
  const saved = selectedNetPrinter();
  const typed = $('net-host').value.trim();
  if (saved && (!typed || typed === saved.host || typed === `${saved.host}:${saved.port}`)) {
    return { kind: 'network', ...saved };
  }
  if (!typed) return null;
  const m = typed.match(/^(.+?)(?::(\d+))?$/);
  return {
    kind: 'network',
    host: m[1],
    port: Number(m[2]) || 9100,
    name: $('net-name').value.trim() || m[1],
    model: $('printer').value,
    unsaved: true,
  };
}

async function saveNetPrinter({ quiet = false } = {}) {
  const t = networkTarget();
  if (!t) { log('Enter the printer\'s IP address first', 'warn'); return null; }
  try {
    const { printer, printers } = await NetworkLink.savePrinter({
      name: $('net-name').value.trim() || t.name || t.host,
      host: t.host,
      port: t.port,
      model: $('printer').value,
    });
    netPrinters = printers;
    renderNetPrinters(printer.id);
    if (!quiet) log(`Saved printer ${printer.name} (${printer.host})`, 'ok');
    return printer;
  } catch (err) {
    log(`Could not save the printer: ${err.message}`, 'err');
    return null;
  }
}

/** Keeps the tape selector in sync with the cartridge in the printer. */
function matchLoadedTape(status) {
  if (!$('auto-tape').checked || !status || status.tapeWidthCode <= 0) return;
  const code = String(status.tapeWidthCode);
  if ($('tape').value === code) return;
  if (![...$('tape').options].some((o) => o.value === code)) {
    log(`Loaded tape (${tapeWidthLabel(status.tapeWidthCode)}) is not supported by ${$('printer').value}`, 'warn');
    return;
  }
  $('tape').value = code;
  invalidateJobPages();
  renderJobList();
  refresh();
  log(`Tape width set to ${tapeWidthLabel(status.tapeWidthCode)} to match the printer`, 'ok');
}

let pollTimer = null;

/** Wi-Fi printers don't push status, so poll it while connected and idle. */
function startStatusPolling() {
  stopStatusPolling();
  pollTimer = setInterval(async () => {
    if (!active || active.kind !== 'network' || printing || document.hidden) return;
    try {
      await active.fetchStatus();
    } catch (err) {
      log(`Status poll failed: ${err.message}`, 'warn');
    }
  }, 15000);
}

function stopStatusPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && active?.kind === 'network' && !printing) active.fetchStatus().catch(() => {});
});

function applyConnKind() {
  const kind = connKind();
  prefs.set('conn-kind', kind);
  $('conn-network').hidden = kind !== 'network';
  $('conn-bluetooth').hidden = kind !== 'bluetooth';
  if (kind === 'network') {
    const p = selectedNetPrinter();
    setModel(p ? p.model : (findPrinter($('printer').value).statusLength === 20 ? null : 'TEPRA PRO SR5900P'));
  }
  updateBackendState();
}

for (const el of document.querySelectorAll('input[name=conn-kind]')) {
  el.addEventListener('change', applyConnKind);
}
$('net-printer').addEventListener('change', onNetPrinterSelected);
$('btn-net-save').addEventListener('click', () => saveNetPrinter());

$('btn-net-remove').addEventListener('click', async () => {
  const p = selectedNetPrinter();
  if (!p || !confirm(`Remove ${p.name} (${p.host})?`)) return;
  try {
    netPrinters = await NetworkLink.removePrinter(p.id);
    $('net-host').value = '';
    $('net-name').value = '';
    renderNetPrinters();
    log(`Removed ${p.name}`);
  } catch (err) {
    log(err.message, 'err');
  }
});

$('btn-net-discover').addEventListener('click', async () => {
  const button = $('btn-net-discover');
  const list = $('net-found');
  button.disabled = true;
  button.textContent = 'Searching…';
  try {
    const found = await NetworkLink.discover();
    list.hidden = false;
    if (!found.length) {
      const li = document.createElement('li');
      li.textContent = 'No printers answered. Discovery needs the server on the same LAN '
        + '(Docker: network_mode: host). You can still type the IP address.';
      list.replaceChildren(li);
      return;
    }
    list.replaceChildren(...found.map((f) => {
      const li = document.createElement('li');
      const text = document.createElement('span');
      text.textContent = `${f.host} — ${f.summary}`;
      const use = document.createElement('button');
      use.textContent = 'Use';
      use.addEventListener('click', async () => {
        $('net-printer').value = '';
        $('net-host').value = f.host;
        if (!$('net-name').value) $('net-name').value = `TEPRA ${f.host}`;
        list.hidden = true;
        await saveNetPrinter();
      });
      li.append(text, use);
      return li;
    }));
    log(`Found ${found.length} printer(s) on the network`, 'ok');
  } catch (err) {
    log(`Discovery failed: ${err.message}`, 'err');
  } finally {
    button.disabled = !!active;
    button.textContent = 'Find on network';
  }
});

function setProgress(done, total, phase) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  $('progress-bar').style.width = `${pct}%`;
  $('progress-text').textContent = phase ? `${phase} — ${pct}%` : '';
}

// ---- イベント -----------------------------------------------------------

$('btn-scan').addEventListener('click', async () => {
  const select = $('device');
  select.innerHTML = '<option value="">(scanning…)</option>';
  try {
    const devices = await BackendLink.listDevices();
    if (!devices.length) {
      select.innerHTML = '<option value="">(none found)</option>';
      log('No paired Bluetooth devices found. '
        + 'Pair the printer in the OS settings first.', 'warn');
      return;
    }
    select.innerHTML = devices
      .map((d) => `<option value="${d.id}">${d.likely ? '★ ' : ''}${d.name}${d.detail ? ` — ${d.detail}` : ''}</option>`)
      .join('');
    log(`Found ${devices.length} device(s)`, 'ok');
    autoSelectModelFromDevice();
  } catch (err) {
    select.innerHTML = '<option value="">(scan failed)</option>';
    log(`Device scan failed: ${err.message}`, 'err');
  }
});

/** デバイス名に機種名が含まれていれば機種セレクタを合わせる */
function autoSelectModelFromDevice() {
  const text = $('device').selectedOptions[0]?.textContent || '';
  const guess = printerFromAdvertisedName(text);
  if (!guess) return;
  $('printer').value = guess.model;
  refreshTapeOptions();
  refresh();
  log(`Detected model ${guess.model} (${guess.resolution} dpi)`, 'ok');
}

$('device').addEventListener('change', autoSelectModelFromDevice);

$('btn-connect').addEventListener('click', async () => {
  let target;
  if (connKind() === 'network') {
    target = networkTarget();
    if (!target) { log('Pick a saved printer or type its IP address first', 'warn'); return; }
  } else {
    const id = $('device').value;
    if (!id) { log('Scan for paired devices and pick the printer first', 'warn'); return; }
    target = { kind: 'bluetooth', id, model: $('printer').value, channel: Number($('channel').value) || null };
  }
  try {
    await connectTo(target);
    // Remember a printer that was typed in and worked
    if (target.unsaved) await saveNetPrinter({ quiet: true });
  } catch (err) {
    setConnected(false);
    log(`Connection failed: ${err.message}`, 'err');
    showReconnect(`Connection failed: ${err.message}`);
  }
});

$('btn-reconnect').addEventListener('click', async () => {
  if (!lastTarget) return;
  const button = $('btn-reconnect');
  button.disabled = true;
  button.textContent = 'Reconnecting…';
  try {
    await connectTo(lastTarget);
    log('Reconnected', 'ok');
  } catch (err) {
    setConnected(false);
    log(`Reconnect failed: ${err.message}`, 'err');
    showReconnect(`Reconnect failed: ${err.message}. Check the printer is on and try again.`);
  } finally {
    button.disabled = false;
    button.textContent = 'Reconnect';
  }
});

$('btn-reconnect-dismiss').addEventListener('click', hideReconnect);

$('btn-disconnect').addEventListener('click', async () => {
  expectDisconnect = true;
  try {
    if (active) {
      // Bluetooth: turn auto status off before disconnecting (PrintController.done())
      if (active.kind !== 'network') await endSession(active).catch(() => {});
      await active.disconnect();
    }
    setConnected(false);
    hideReconnect();
  } finally {
    expectDisconnect = false;
  }
});

$('btn-status').addEventListener('click', async () => {
  try {
    // NetworkLink.fetchStatus() reports through its 'status' event
    if (active.kind === 'network') await active.fetchStatus();
    else showStatus(await fetchStatus(active));
    log('Status updated', 'ok');
  } catch (err) {
    log(`Could not read status: ${err.message}`, 'err');
    noteIfDisconnected(err);
  }
});

$('btn-feed').addEventListener('click', () => runSimple(() => tapeFeed(active, false), 'Tape feed'));
$('btn-feed-cut').addEventListener('click', () => runSimple(() => tapeFeed(active, true), 'Feed + cut'));

/**
 * 通信が原因で失敗したなら再接続を促す。
 * 切断通知が届かずにエラーだけ返ってくる経路 (送信中の書き込み失敗など) の保険。
 */
function noteIfDisconnected(err) {
  if (active?.connected) return;
  showReconnect(`Lost communication with the printer (${err.message}). Please reconnect.`);
}

async function runSimple(fn, name) {
  setPrinting(true);
  try {
    log(`${name}…`);
    await fn();
    log(`${name} done`, 'ok');
  } catch (err) {
    log(`${name} failed: ${err.message}`, 'err');
    noteIfDisconnected(err);
  } finally {
    setPrinting(false);
  }
}

/** ページ環境コマンドを組める commandLevel か */
function printableModel() {
  const printer = currentPrinter();
  if (active?.kind === 'network' && printer.statusLength !== 20) {
    log(`Wi-Fi printing supports the SR5900P / SR5900C / SR5900GS. Pick one of those under Model `
      + `(currently ${printer.model}).`, 'err');
    return false;
  }
  if (SUPPORTED_COMMAND_LEVELS.includes(printer.commandLevel)) return true;
  log(`${printer.model} uses command level ${printer.commandLevel}, `
    + 'whose page commands are not decoded yet, so it cannot print.', 'err');
  return false;
}

/** Wi-Fi: the backend runs the whole session; we send the complete job in one request. */
async function runNetworkPrint(pages, opts) {
  const link = active;
  currentJob = { cancel: () => link.cancel() };
  const bytes = buildNetworkJobBytes(pages, opts);
  setProgress(0, bytes.length, 'Sending to printer');
  await link.print(bytes, { pages: pages.length * opts.copies, tapeCode: Number($('tape').value) });
  link.fetchStatus().catch(() => {});
}

async function runPrint(pages, opts, what) {
  setPrinting(true);
  try {
    if (active.kind === 'network') {
      await runNetworkPrint(pages, opts);
    } else {
      active.totalWritten = 0;
      currentJob = new PrintJob(active);
      await currentJob.run(pages, opts, (p) => setProgress(p.done, p.total, p.phase));
    }
    log(`${what} printed`, 'ok');
  } catch (err) {
    if (err.name === 'PrintAborted') {
      log('Print cancelled', 'warn');
    } else {
      log(`Print failed: ${err.message}`, 'err');
      noteIfDisconnected(err);
    }
  } finally {
    currentJob = null;
    setPrinting(false);
    setProgress(0, 0, '');
    updateJobSummary();
  }
}

$('btn-print').addEventListener('click', async () => {
  // フォントが未読み込みのまま描くと canvas が黙って代替フォントに差し替える。
  // 印字は取り返しがつかないので、ここで必ず読み込みを待ってから版下を作り直す。
  await ensureFontLoaded(`16px ${cssFamily($('font').value)}`, $('text').value || 'A');
  const built = buildPage();
  lastRender = built;
  if (!built) { log('Nothing printable for this tape width', 'err'); return; }
  if (!printableModel()) return;

  await runPrint([built.page], printOptions(), 'Label');
});

$('btn-job-print').addEventListener('click', async () => {
  if (!jobItems.length) { log('The batch is empty', 'warn'); return; }
  if (!printableModel()) return;

  const sets = Math.max(1, Math.min(99, Number($('job-sets').value) || 1));
  const pages = [];
  const skipped = [];
  for (const item of jobItems) {
    // フォントは項目ごとに違う。描く前に必ず読み込みを待つ。
    await ensureFontLoaded(`16px ${cssFamily(item.design.fontFamily)}`, item.design.text || 'A');
    itemPageCache.delete(item.id);
    const built = await itemPage(item);
    if (!built) { skipped.push(itemLabel(item)); continue; }
    for (let i = 0; i < item.copies; i++) pages.push(built.page);
  }

  if (skipped.length) {
    log(`Skipping items that do not fit this tape width: ${skipped.join(', ')}`, 'warn');
  }
  if (!pages.length) { log('No printable items', 'err'); return; }

  await renderJobList();
  log(`Printing batch (${jobItems.length} items / ${pages.length * sets} labels / ${sets} set(s))`);
  await runPrint(pages, printOptions(sets), 'Batch');
});

$('btn-print-mobile').addEventListener('click', () => $('btn-print').click());

$('btn-cancel').addEventListener('click', () => {
  if (currentJob) { currentJob.cancel(); log('Cancel requested', 'warn'); }
});

// ---- ジョブの操作 -------------------------------------------------------

$('btn-job-add').addEventListener('click', async () => {
  const item = createItem(readDesignFromUI(), { copies: Math.max(1, Number($('copies').value) || 1) });
  jobItems.push(item);
  selectedItemId = item.id;
  await renderJobList();
  log(`Added to batch: ${itemLabel(item)}`, 'ok');
});

$('btn-job-update').addEventListener('click', async () => {
  const item = selectedItem();
  if (!item) return;
  item.design = readDesignFromUI();
  itemPageCache.delete(item.id);
  await renderJobList();
  log(`Overwrote selected item: ${itemLabel(item)}`, 'ok');
});

$('btn-job-edit').addEventListener('click', async () => {
  const item = selectedItem();
  if (!item) return;
  await applyDesignToUI(item.design);
  $('copies').value = String(item.copies);
  refresh();
  log(`Loaded into editor: ${itemLabel(item)}`);
});

$('btn-job-clear').addEventListener('click', async () => {
  if (!jobItems.length) return;
  if (!confirm(`Remove all ${jobItems.length} item(s) from the batch?`)) return;
  jobItems = [];
  selectedItemId = null;
  invalidateJobPages();
  await renderJobList();
  log('Batch cleared');
});

$('job-sets').addEventListener('input', () => updateJobSummary());

$('btn-job-save').addEventListener('click', () => {
  const json = serializeJob(jobItems, {
    printer: $('printer').value,
    tapeCode: Number($('tape').value),
    tapeCut: Number($('tape-cut').value),
    halfCut: Number($('half-cut').value),
    density: Number($('density').value),
    sets: Math.max(1, Number($('job-sets').value) || 1),
  });
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tepra-job-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  log(`Saved batch with ${jobItems.length} item(s)`, 'ok');
});

$('btn-job-open').addEventListener('click', () => $('job-file').click());

$('job-file').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const loaded = parseJob(await file.text());

    // 機種とテープ幅は「あれば合わせる」。無ければいまの設定で描く。
    if (loaded.printer && [...$('printer').options].some((o) => o.value === loaded.printer)) {
      $('printer').value = loaded.printer;
      refreshTapeOptions();
    }
    if (loaded.tapeCode && [...$('tape').options].some((o) => Number(o.value) === loaded.tapeCode)) {
      $('tape').value = String(loaded.tapeCode);
    }
    $('tape-cut').value = String(loaded.print.tapeCut);
    $('half-cut').value = String(loaded.print.halfCut);
    $('density').value = String(loaded.print.density);
    $('job-sets').value = String(loaded.print.sets);

    jobItems = loaded.items;
    selectedItemId = null;
    invalidateJobPages();
    // 項目ごとにフォントが違うので、描く前にまとめて読み込んでおく
    for (const item of jobItems) {
      await ensureFontLoaded(`16px ${cssFamily(item.design.fontFamily)}`, item.design.text || 'A');
    }
    await renderJobList();
    refresh();
    log(`Loaded batch with ${jobItems.length} item(s) (${file.name})`, 'ok');
  } catch (err) {
    log(`Could not open batch: ${err.message}`, 'err');
  }
});

$('btn-download').addEventListener('click', () => {
  const built = lastRender || buildPage();
  if (!built) return;
  const bytes = buildJobBytes([built.page], printOptions());
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'tepra-job.bin';
  a.click();
  URL.revokeObjectURL(a.href);
  log(`Saved ${bytes.length.toLocaleString()} command bytes`);
});

$('btn-hex').addEventListener('click', () => {
  const built = lastRender || buildPage();
  if (!built) return;
  const bytes = buildJobBytes([built.page], printOptions());
  const head = bytes.subarray(0, 512);
  $('hex-out').textContent =
    `${bytes.length.toLocaleString()} bytes total (first ${head.length} shown)\n\n${toHex(head)}`;
  $('hex-dialog').showModal();
});

$('image').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  // ジョブに保存できるよう data URL で持つ (object URL はページを閉じると消える)
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Cannot read the file'));
      reader.readAsDataURL(file);
    });
    labelImage = await loadImage(dataUrl);
    labelImageUrl = normalizeDesign({ imageDataUrl: dataUrl }).imageDataUrl;
    if (!labelImageUrl) {
      log('This format cannot be saved in a batch (PNG / JPEG / GIF / WebP / BMP only). '
        + 'It still works for the current label.', 'warn');
    }
    refresh();
  } catch (err) {
    log(`Could not load image: ${err.message}`, 'err');
  }
});

$('btn-clear-image').addEventListener('click', () => {
  labelImage = null;
  labelImageUrl = null;
  $('image').value = '';
  refresh();
});

// 機種とテープ幅を変えたらジョブも描き直す (項目はラスタではなく設定を持っている)
$('printer').addEventListener('change', () => {
  prefs.set('model', $('printer').value);
  refreshTapeOptions();
  refresh();
  invalidateJobPages();
  renderJobList();
});
$('tape').addEventListener('change', () => {
  invalidateJobPages();
  renderJobList();
});
$('length-mode').addEventListener('change', () => {
  $('fixed-length').disabled = $('length-mode').value !== 'fixed';
  refresh();
});
$('font-scale').addEventListener('input', () => {
  $('font-scale-out').textContent = `${$('font-scale').value}%`;
  refresh();
});
$('line-gap').addEventListener('input', () => {
  $('line-gap-out').textContent = `${$('line-gap').value} dot`;
  refresh();
});

$('font').addEventListener('change', () => useFont($('font').value));
$('font-filter').addEventListener('input', () => renderFontOptions());
$('btn-load-fonts').addEventListener('click', () => loadLocalFonts());

for (const id of ['text', 'align', 'bold', 'italic', 'border', 'tape',
                  'fixed-length', 'padding', 'tape-margin', 'dither', 'flip', 'image-pos']) {
  $(id).addEventListener('input', refresh);
  $(id).addEventListener('change', refresh);
}
for (const el of document.querySelectorAll('input[name=preview-mode]')) {
  el.addEventListener('change', refresh);
}

// ---- 起動 ---------------------------------------------------------------

initSelects();
initFonts();   // フォントが決まった時点で refresh() まで進む
refresh();
renderJobList();
setConnected(false);

/** バックエンドが動いているか確認する */
async function initTransport() {
  try {
    backendState = await BackendLink.probe();
  } catch {
    backendState = null;
  }

  if (!backendState) {
    btAvailable = false;
    updateBackendState();
    $('btn-connect').disabled = true;
    log('Cannot reach the backend. Only preview and saving command bytes work.', 'warn');
    return;
  }

  btAvailable = !!backendState.rfcomm;
  netPrinters = backendState.printers || [];
  renderNetPrinters();
  updateBackendState();
  setConnected(false);

  if (connKind() === 'network') {
    log(netPrinters.length
      ? 'Ready. Pick your printer and press Connect.'
      : 'Ready. Type your printer\'s IP address (or use Find on network) and press Connect.');
  } else {
    log('Ready. Turn the printer on, scan for paired devices and press Connect.');
  }
}

function updateBackendState() {
  const el = $('backend-state');
  if (!backendState) {
    el.textContent = 'Backend not running (start it with npm start or Docker).';
    return;
  }
  if (connKind() === 'network') {
    el.textContent = `Server ${backendState.version || ''} — Wi-Fi printing over UDP/TCP 9100`;
    $('btn-connect').disabled = false;
  } else if (btAvailable) {
    el.textContent = `Server ${backendState.version || ''} (${backendState.platform}) — Bluetooth available`;
    $('btn-connect').disabled = false;
  } else {
    el.textContent = `Bluetooth is not available on the server: ${backendState.rfcommError || 'unknown reason'}`;
    $('btn-connect').disabled = true;
  }
}

$('auto-tape').checked = prefs.get('auto-tape') !== '0';
$('auto-tape').addEventListener('change', () => {
  prefs.set('auto-tape', $('auto-tape').checked ? '1' : '0');
  if ($('auto-tape').checked && active?.lastStatus) matchLoadedTape(active.lastStatus);
});

if (prefs.get('conn-kind') === 'bluetooth') {
  document.querySelector('input[name=conn-kind][value=bluetooth]').checked = true;
}
$('conn-network').hidden = connKind() !== 'network';
$('conn-bluetooth').hidden = connKind() !== 'bluetooth';

initTransport();
