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
import { SECTION_BREAK, iconIds, imageKeys } from './layout.js';
import {
  ICON_TABS, loadIcons, iconsLoaded, iconSvg, iconsInTab, searchIcons,
} from './icons.js';
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
import { deviceErrorCode } from './status.js';
import {
  t, applyI18n, setI18nText, initLanguageSelect, languageEvents, isTranslationOf,
} from './i18n.js';

const $ = (id) => document.getElementById(id);

let currentJob = null;
let printing = false;
let labelImage = null;      // HTMLImageElement (描画用)
let labelImageUrl = null;   // 同じ画像の data URL (ジョブ保存用)
/** 本文の "[img:N]" に入る画像。N → { url (保存用 data URL), img (描画用) } */
let inlineImages = {};
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
      if (printing) setProgress(p.done, p.total, t(p.phase));
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
        ? t('Lost the connection while printing. Check the tape, then reconnect.')
        : t('Lost the connection to the printer. Please reconnect.'));
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
  $('conn-state').textContent = t('Connecting…');
  setConnectDisabled(true);
  let device;
  try {
    device = await target.connect(printer);
  } finally {
    setConnectDisabled(false);
  }
  active = target;
  lastTarget = { kind: 'network', ...device };
  hideReconnect();
  setConnected(true, `${device.name || device.host} · Wi-Fi`);
  log(t('Connected to {name} ({host}:{port})', { name: device.name || device.host, host: device.host, port: device.port }), 'ok');
  startStatusPolling();
  return device;
}

async function connectBluetooth({ id, model, channel }) {
  const target = getLink();
  $('conn-state').textContent = t('Connecting…');
  setConnectDisabled(true);
  // バックエンドは繋ぎ直す前に古い接続を切るので、その通知で帯を出さない
  expectDisconnect = true;
  let device;
  try {
    device = await target.connect({ id, model, channel });
  } finally {
    expectDisconnect = false;
    setConnectDisabled(false);
  }
  active = target;
  lastTarget = { kind: 'bluetooth', id, model, channel: device.channel ?? channel ?? null };
  hideReconnect();
  setConnected(true, `${device.model} / RFCOMM ch${device.channel ?? '?'}`);
  try {
    showStatus(await fetchStatus(active));
  } catch (err) {
    log(t('Could not read status: {error}', { error: err.message }), 'warn');
  }
  return device;
}

// ---- 初期化 -------------------------------------------------------------

function renderPrinterOptions() {
  // statusLength 22 の 3 機種 (SR-R5600P/C/GS) は BLE 専用で、
  // Bluetooth Classic のプロファイルを持たないため RFCOMM では繋がらない。
  const prev = $('printer').value;
  $('printer').innerHTML = PRINTERS
    .map((p) => {
      const bleOnly = p.statusLength === 22;
      return `<option value="${p.model}"${bleOnly ? ' data-bleonly="1"' : ''}>`
        + `${p.model}${bleOnly ? t(' (BLE only, not supported)') : ''}</option>`;
    })
    .join('');
  if (prev) $('printer').value = prev;
}

function initSelects() {
  renderPrinterOptions();
  $('printer').value = PRINTERS.some((p) => p.model === prefs.get('model'))
    ? prefs.get('model')
    : 'TEPRA PRO SR5900P';
  refreshTapeOptions();
}

/** テープ幅の表示名 (models.js の英語名を訳す) */
function tapeLabel(code) {
  if (code > 0 && !TAPE_WIDTHS.some((w) => w.code === code)) return t('code {code}', { code });
  return t(tapeWidthLabel(code));
}

// ---- フォント -----------------------------------------------------------

const FONT_STORAGE_KEY = 'font';
/** Text used to wait for a font to load: Latin and kana, so either subset gets fetched */
const FONT_SAMPLE = 'Aあ';

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

// The font picker is a text box you type into to search, with a list that shows each font
// in itself. The chosen family lives in the hidden #font input, which the rest of the code reads.

/** Makes `select` (or the current font) the chosen one and redraws the picker. */
function renderFontOptions(select) {
  const chosen = select ?? $('font').value;
  if (chosen) {
    $('font').value = chosen;
    if (document.activeElement !== $('font-input')) showChosenFont();
  }
  $('font-count').textContent = t('{total}', { total: fontFamilies.length });
  if (!$('font-list').hidden) renderFontList();
}

/** The text box shows the chosen family, set in that family */
function showChosenFont() {
  const family = $('font').value;
  $('font-input').value = family;
  $('font-input').style.fontFamily = family ? cssFamily(family) : '';
}

/** Families matching what is typed in the box (all of them while it still shows the chosen one) */
function fontMatches() {
  const typed = $('font-input').value.trim().toLowerCase();
  if (!typed || $('font-input').value === $('font').value) return fontFamilies;
  return fontFamilies.filter((f) => f.toLowerCase().includes(typed));
}

/** Index of the highlighted row in the open list */
let fontActive = -1;

function renderFontList() {
  const list = $('font-list');
  const matches = fontMatches();
  const chosen = $('font').value;
  if (fontActive >= matches.length) fontActive = matches.length - 1;
  if (!matches.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = t('No matching fonts');
    list.replaceChildren(li);
    $('font-input').removeAttribute('aria-activedescendant');
    return;
  }
  // Font names come from the OS, so build the list without innerHTML
  list.replaceChildren(...matches.map((family, i) => {
    const li = document.createElement('li');
    li.id = `font-opt-${i}`;
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', i === fontActive ? 'true' : 'false');
    if (family === chosen) li.classList.add('current');
    li.textContent = family;
    li.style.fontFamily = cssFamily(family);   // each row in its own font
    li.dataset.family = family;
    return li;
  }));
  if (fontActive >= 0) {
    $('font-input').setAttribute('aria-activedescendant', `font-opt-${fontActive}`);
    list.children[fontActive].scrollIntoView({ block: 'nearest' });
  } else {
    $('font-input').removeAttribute('aria-activedescendant');
  }
}

function openFontList() {
  const matches = fontMatches();
  fontActive = Math.max(0, matches.indexOf($('font').value));
  $('font-list').hidden = false;
  $('font-input').setAttribute('aria-expanded', 'true');
  renderFontList();
}

function closeFontList() {
  $('font-list').hidden = true;
  $('font-input').setAttribute('aria-expanded', 'false');
  $('font-input').removeAttribute('aria-activedescendant');
}

function chooseFont(family) {
  closeFontList();
  $('font').value = family;
  showChosenFont();
  renderFontOptions(family);
  useFont(family);
}

$('font-input').addEventListener('focus', () => {
  $('font-input').select();
  openFontList();
});
$('font-input').addEventListener('input', () => {
  $('font-input').style.fontFamily = '';
  fontActive = 0;
  if ($('font-list').hidden) openFontList();
  else renderFontList();
});
$('font-input').addEventListener('keydown', (e) => {
  const count = fontMatches().length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if ($('font-list').hidden) { openFontList(); return; }
    if (!count) return;
    fontActive = (fontActive + (e.key === 'ArrowDown' ? 1 : -1) + count) % count;
    renderFontList();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const family = fontMatches()[fontActive];
    if (family) chooseFont(family);
  } else if (e.key === 'Escape' && !$('font-list').hidden) {
    e.preventDefault();
    closeFontList();
    showChosenFont();
    $('font-input').select();
  }
});
$('font-input').addEventListener('blur', () => {
  closeFontList();
  showChosenFont();
});
// mousedown, not click: keeps the focus in the box so blur doesn't close the list first
$('font-list').addEventListener('mousedown', (e) => {
  e.preventDefault();
  const li = e.target.closest('li[data-family]');
  if (li) chooseFont(li.dataset.family);
});

async function useFont(family) {
  prefs.set(FONT_STORAGE_KEY, family);
  // canvas は未読み込みのフォントを黙って代替に差し替えるので、待ってから描く
  await ensureFontLoaded(`16px ${cssFamily(family)}`, $('text').value || FONT_SAMPLE);
  refresh();
}

/** インストール済みフォントを読み込む。ユーザー操作の中から呼ぶこと。 */
async function loadLocalFonts({ silent = false } = {}) {
  try {
    const families = await queryLocalFamilies();
    if (!families.length) throw new Error(t('No fonts returned'));
    setFontFamilies(families);
    await useFont($('font').value);
    log(t('Loaded {n} installed fonts', { n: families.length }), 'ok');
    $('btn-load-fonts').hidden = true;
  } catch (err) {
    if (silent) return;
    // 許可を拒否された場合もここに来る
    log(t('Could not list fonts: {error}', { error: err.message }), 'warn', { toast: true });
  }
}

async function initFonts() {
  setFontFamilies(knownFamilies(), { keep: false });

  if (!hasLocalFontApi()) {
    $('btn-load-fonts').hidden = true;
    log(t('Listing installed fonts needs Chrome or Edge (and HTTPS or localhost). '
      + 'Only common fonts are offered.'), 'warn');
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
    .filter((w) => printer.tapeKinds.includes(w.code))
    .map((w) => {
      const dots = printableDots(w.code, printer.resolution, printer.modelNumber);
      return `<option value="${w.code}">${t(w.label)} — ${dots} dot</option>`;
    });
  $('tape').innerHTML = opts.join('');
  if (prev && [...$('tape').options].some((o) => o.value === prev)) $('tape').value = prev;
  else $('tape').value = String(printer.tapeKinds.includes(4) ? 4 : printer.tapeKinds[0]);
  // Models without a half cutter ignore both half-cut settings
  for (const id of ['lead-cut', 'half-cut']) $(id).disabled = !printer.halfcut;
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
      : t('Cannot print on this tape width');
    body.append(name, meta);

    // 枚数はその場で変えられるようにする
    const copies = document.createElement('input');
    copies.type = 'number';
    copies.className = 'job-copies';
    copies.min = '1';
    copies.max = '99';
    copies.value = String(item.copies);
    copies.title = t('Copies');
    copies.addEventListener('click', (e) => e.stopPropagation());
    copies.addEventListener('change', () => {
      item.copies = Math.max(1, Math.min(99, Number(copies.value) || 1));
      copies.value = String(item.copies);
      updateJobSummary();
    });

    const buttons = document.createElement('div');
    buttons.className = 'job-buttons';
    buttons.append(
      jobButton('↑', t('Move up'), index === 0, () => moveItem(index, -1)),
      jobButton('↓', t('Move down'), index === jobItems.length - 1, () => moveItem(index, 1)),
      jobButton('✕', t('Remove'), false, () => removeItem(item.id)),
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
  scheduleSave();
  const has = jobItems.length > 0;
  const sets = Math.max(1, Number($('job-sets').value) || 1);
  const labels = jobItems.reduce((n, it) => n + it.copies, 0) * sets;

  let text = has ? t('{items} item(s) / {labels} label(s)', { items: jobItems.length, labels }) : t('(empty)');
  if (has && lastJobBuild.length === jobItems.length) {
    const dpi = currentPrinter().resolution;
    const mm = lastJobBuild.reduce((sum, b, i) => sum
      + (b ? dotsToMm(b.page.lengthDots, dpi) * jobItems[i].copies : 0), 0);
    const bytes = lastJobBuild.reduce((sum, b, i) => sum
      + (b ? b.page.rows.length * (8 + ((b.page.widthDots + 7) >> 3)) * jobItems[i].copies : 0), 0);
    text += t(' / ~{mm} mm / raster {bytes} B', { mm: (mm * sets).toFixed(0), bytes: (bytes * sets).toLocaleString() });
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
    dividers: $('dividers').checked,
    dither: $('dither').checked,
    flip: $('flip').checked,
    imageDataUrl: labelImageUrl,
    imagePosition: $('image-pos').value,
    images: Object.fromEntries(Object.entries(inlineImages).map(([key, v]) => [key, v.url])),
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
  $('dividers').checked = design.dividers;
  $('dither').checked = design.dither;
  $('flip').checked = design.flip;
  $('image-pos').value = design.imagePosition;

  labelImageUrl = design.imageDataUrl;
  labelImage = design.imageDataUrl ? await loadImage(design.imageDataUrl).catch(() => null) : null;
  if (design.imageDataUrl && !labelImage) log(t('Could not load the image stored in the batch item'), 'warn');
  $('image').value = '';

  inlineImages = {};
  for (const [key, img] of Object.entries(await loadInlineImages(design.images))) {
    inlineImages[key] = { url: design.images[key], img };
  }

  await ensureFontLoaded(`16px ${cssFamily(design.fontFamily)}`, design.text || FONT_SAMPLE);
  await ensureIcons(design.text);
}

/** data URL / object URL から HTMLImageElement を作る */
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(t('Cannot read the image')));
    img.src = url;
  });
}

/** 版下の images (N → data URL) を描画用の画像にする。読めなかったものは抜けたまま。 */
async function loadInlineImages(images = {}) {
  const out = {};
  await Promise.all(Object.entries(images).map(async ([key, url]) => {
    try { out[key] = await loadImage(url); } catch { /* 本文には [img:N] が文字のまま出る */ }
  }));
  if (Object.keys(out).length < Object.keys(images).length) {
    log(t('Could not load the image stored in the batch item'), 'warn');
  }
  return out;
}

/** 版下の設定 + 機種 + テープ幅 → renderLabel に渡す LabelSpec */
function specFrom(design, printer, tapeCode, image, inline = {}) {
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
    dividers: design.dividers,
    image,
    inlineImages: inline,
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
  const inline = Object.fromEntries(Object.entries(inlineImages).map(([key, v]) => [key, v.img]));
  return rasterize(specFrom(design, printer, tapeCode, labelImage, inline), design);
}

/** ジョブの項目を、いまの機種・テープ幅で描く */
async function buildItemPage(item) {
  if (!await ensureIcons(item.design.text)) return null;
  const image = item.design.imageDataUrl
    ? await loadImage(item.design.imageDataUrl).catch(() => null)
    : null;
  const inline = await loadInlineImages(item.design.images);
  const spec = specFrom(item.design, currentPrinter(), Number($('tape').value), image, inline);
  return rasterize(spec, item.design);
}

function printOptions(copies = Math.max(1, Number($('copies').value) || 1)) {
  const printer = currentPrinter();
  return {
    copies,
    tapeCut: Number($('tape-cut').value),
    halfCut: Number($('half-cut').value),
    // Half-cut the blank the printer feeds at the start of a job so it stays on the
    // label as a peel tab, instead of cutting it off. Only for half-cut models.
    leadingHalfCut: printer.halfcut ? $('lead-cut').value === '1' : undefined,
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
  scheduleSave();
  const built = buildPage();
  lastRender = built;
  if (!built) {
    $('size-info').textContent = t('Cannot print on this tape width');
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
  $('size-info').textContent = t('{length} × {width} dot / {mm} mm / {dpi} dpi / {bytes} B', {
    length: page.lengthDots, width: page.widthDots, mm: lenMm, dpi: spec.dpi, bytes: bytes.toLocaleString(),
  });
}

// ---- ログ / 状態表示 -----------------------------------------------------

/**
 * Adds a line to the log. Errors also pop up as a toast, since the log is far down the page;
 * pass { toast: true } for a warning the user needs to see, or { toast: false } when the
 * message is already shown somewhere else (the reconnect banner).
 */
function log(message, kind = 'info', { toast = kind === 'err' } = {}) {
  const el = $('log');
  const time = new Date().toLocaleTimeString([], { hour12: false });
  const line = document.createElement('div');
  if (kind !== 'info') line.className = kind;
  line.textContent = `[${time}] ${message}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  if (toast) showToast(message, kind === 'err' ? 'err' : 'warn');
}

const MAX_TOASTS = 3;

function showToast(message, kind = 'err') {
  const box = $('toasts');
  // The same message again (e.g. a retry that fails the same way): just restart its timer
  for (const old of box.children) {
    if (old.dataset.message === message) old.remove();
  }
  const toast = document.createElement('div');
  toast.className = `toast ${kind}`;
  toast.dataset.message = message;
  toast.setAttribute('role', kind === 'err' ? 'alert' : 'status');
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.title = t('Close');
  close.setAttribute('aria-label', t('Close'));
  close.addEventListener('click', () => toast.remove());
  toast.append(text, close);
  box.append(toast);
  while (box.children.length > MAX_TOASTS) box.firstElementChild.remove();
  setTimeout(() => toast.remove(), kind === 'err' ? 10000 : 6000);
}

/** Last status shown, so the table can be redrawn in another language */
let shownStatus = null;

function showStatus(s) {
  shownStatus = s;
  $('st-state').textContent = `${t(PRINTER_STATUS[s.ST] ?? 'Unknown')} (0x${s.ST.toString(16)})`;
  const code = deviceErrorCode(s);
  const err = DEVICE_ERROR[code] ? t(DEVICE_ERROR[code]) : t('Unknown ({code})', { code });
  $('st-error').textContent = code === 0 ? t('None') : err;
  $('st-error').style.color = code === 0 ? '' : 'var(--err)';
  $('st-tape').textContent = t('{tape} (TW=0x{tw}, type {type})', {
    tape: tapeLabel(s.tapeWidthCode), tw: s.TW.toString(16).padStart(2, '0'), type: s.TR,
  });
  $('st-buffer').textContent = (s.RB ? t('buffer {bytes} B / ', { bytes: s.RB.toLocaleString() }) : '')
    + t('printed {n} label(s)', { n: s.PP });
  updatePrinterSummary();
}

/**
 * The one-line summary shown on the folded printer section:
 * "Label printer · Wi-Fi — Ready · 12mm", or the error when there is one.
 */
function updatePrinterSummary() {
  const el = $('printer-summary');
  const on = !!active?.connected;
  el.hidden = !on;
  el.classList.remove('has-error');
  if (!on) { el.textContent = ''; return; }
  const parts = [];
  const s = shownStatus;
  if (s) {
    const code = deviceErrorCode(s);
    if (code !== 0) {
      parts.push(DEVICE_ERROR[code] ? t(DEVICE_ERROR[code]) : t('Unknown ({code})', { code }));
      el.classList.add('has-error');
    } else {
      parts.push(t(PRINTER_STATUS[s.ST] ?? 'Unknown'));
    }
    if (s.tapeWidthCode > 0) parts.push(tapeLabel(s.tapeWidthCode));
  }
  el.textContent = [connLabel || t('Connected'), parts.join(' · ')].filter(Boolean).join(' — ');
  el.title = el.textContent;
}

/** Whether the backend can use Bluetooth (set by initTransport) */
let btAvailable = false;
/** Label shown in the connection pill while connected (kept for language switches) */
let connLabel = null;
/** Connection state the printer section was last folded for (null = not yet) */
let foldedFor = null;

function setConnected(on, label) {
  if (!on) {
    active = null;
    stopStatusPolling();
  }
  // Once connected the printer settings are locked, so fold them away and let the preview
  // lead; open them again when the connection ends. Only on a change, so a section the user
  // opened or closed by hand stays that way across language switches.
  if (foldedFor !== on) {
    foldedFor = on;
    $('printer-section').open = !on;
  }
  connLabel = on ? label : null;
  $('conn-state').textContent = on ? (label || t('Connected')) : t('Not connected');
  $('conn-state').className = `pill ${on ? 'pill-on' : 'pill-off'}`;
  for (const el of document.querySelectorAll('.js-connect')) el.hidden = on;
  for (const el of document.querySelectorAll('.js-disconnect')) el.hidden = !on;
  for (const el of document.querySelectorAll('input[name=conn-kind]')) el.disabled = on;
  for (const id of ['device', 'channel', 'net-printer', 'net-host', 'net-name']) $(id).disabled = on;
  $('btn-scan').disabled = on || !btAvailable;
  $('btn-net-discover').disabled = on;
  updatePrinterSummary();
  setPrinting(printing);
}

function setPrinting(on) {
  printing = on;
  const ready = !!active && active.connected;
  const bluetooth = ready && active.kind !== 'network';
  $('btn-print').disabled = on || !ready;
  $('btn-print-mobile').disabled = on || !ready;
  $('btn-print-mobile').textContent = on ? t('Printing…') : t('Print');
  $('mobile-info').textContent = ready ? $('conn-state').textContent : t('Connect a printer first');
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
    select.innerHTML = `<option value="" data-i18n="(none saved yet)">${t('(none saved yet)')}</option>`;
  } else {
    select.replaceChildren(...netPrinters.map((p) => {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = `${p.name} — ${p.host}${p.port !== 9100 ? `:${p.port}` : ''}${p.fromEnv ? t(' (config)') : ''}`;
      return o;
    }), Object.assign(document.createElement('option'), { value: '' }));
    setI18nText(select.lastElementChild, 'Other…');
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
  const target = networkTarget();
  if (!target) { log(t("Enter the printer's IP address first"), 'warn', { toast: true }); return null; }
  try {
    const { printer, printers } = await NetworkLink.savePrinter({
      name: $('net-name').value.trim() || target.name || target.host,
      host: target.host,
      port: target.port,
      model: $('printer').value,
    });
    netPrinters = printers;
    renderNetPrinters(printer.id);
    if (!quiet) log(t('Saved printer {name} ({host})', { name: printer.name, host: printer.host }), 'ok');
    return printer;
  } catch (err) {
    log(t('Could not save the printer: {error}', { error: err.message }), 'err');
    return null;
  }
}

/** Keeps the tape selector in sync with the cartridge in the printer. */
function matchLoadedTape(status) {
  if (!$('auto-tape').checked || !status || status.tapeWidthCode <= 0) return;
  const code = String(status.tapeWidthCode);
  if ($('tape').value === code) return;
  if (![...$('tape').options].some((o) => o.value === code)) {
    log(t('Loaded tape ({tape}) is not supported by {model}', { tape: tapeLabel(status.tapeWidthCode), model: $('printer').value }), 'warn', { toast: true });
    return;
  }
  $('tape').value = code;
  invalidateJobPages();
  renderJobList();
  refresh();
  log(t('Tape width set to {tape} to match the printer', { tape: tapeLabel(status.tapeWidthCode) }), 'ok');
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
      log(t('Status poll failed: {error}', { error: err.message }), 'warn');
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
  if (!p || !confirm(t('Remove {name} ({host})?', { name: p.name, host: p.host }))) return;
  try {
    netPrinters = await NetworkLink.removePrinter(p.id);
    $('net-host').value = '';
    $('net-name').value = '';
    renderNetPrinters();
    log(t('Removed {name}', { name: p.name }));
  } catch (err) {
    log(err.message, 'err');
  }
});

$('btn-net-discover').addEventListener('click', async () => {
  const button = $('btn-net-discover');
  const list = $('net-found');
  button.disabled = true;
  button.textContent = t('Searching…');
  try {
    const found = await NetworkLink.discover();
    list.hidden = false;
    if (!found.length) {
      const li = document.createElement('li');
      li.textContent = t('No printers answered. Discovery needs the server on the same LAN '
        + '(Docker: network_mode: host). You can still type the IP address.');
      list.replaceChildren(li);
      return;
    }
    list.replaceChildren(...found.map((f) => {
      const li = document.createElement('li');
      const text = document.createElement('span');
      text.textContent = `${f.host} — ${f.summary}`;
      const use = document.createElement('button');
      use.textContent = t('Use');
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
    log(t('Found {n} printer(s) on the network', { n: found.length }), 'ok');
  } catch (err) {
    log(t('Discovery failed: {error}', { error: err.message }), 'err');
  } finally {
    button.disabled = !!active;
    button.textContent = t('Find on network');
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
  setDevicePlaceholder('(scanning…)');
  try {
    const devices = await BackendLink.listDevices();
    if (!devices.length) {
      setDevicePlaceholder('(none found)');
      log(t('No paired Bluetooth devices found. '
        + 'Pair the printer in the OS settings first.'), 'warn', { toast: true });
      return;
    }
    select.innerHTML = devices
      .map((d) => `<option value="${d.id}">${d.likely ? '★ ' : ''}${d.name}${d.detail ? ` — ${d.detail}` : ''}</option>`)
      .join('');
    log(t('Found {n} device(s)', { n: devices.length }), 'ok');
    autoSelectModelFromDevice();
  } catch (err) {
    setDevicePlaceholder('(scan failed)');
    log(t('Device scan failed: {error}', { error: err.message }), 'err');
  }
});

function setDevicePlaceholder(key) {
  const option = Object.assign(document.createElement('option'), { value: '' });
  setI18nText(option, key);
  $('device').replaceChildren(option);
}

/** デバイス名に機種名が含まれていれば機種セレクタを合わせる */
function autoSelectModelFromDevice() {
  const text = $('device').selectedOptions[0]?.textContent || '';
  const guess = printerFromAdvertisedName(text);
  if (!guess) return;
  $('printer').value = guess.model;
  refreshTapeOptions();
  refresh();
  log(t('Detected model {model} ({dpi} dpi)', { model: guess.model, dpi: guess.resolution }), 'ok');
}

$('device').addEventListener('change', autoSelectModelFromDevice);

/** The Connect buttons (top bar and printer section) */
function setConnectDisabled(disabled) {
  for (const el of document.querySelectorAll('.js-connect')) el.disabled = disabled;
}

async function onConnectClick() {
  let target;
  if (connKind() === 'network') {
    target = networkTarget();
    if (!target) { log(t('Pick a saved printer or type its IP address first'), 'warn', { toast: true }); return; }
  } else {
    const id = $('device').value;
    if (!id) { log(t('Scan for paired devices and pick the printer first'), 'warn', { toast: true }); return; }
    target = { kind: 'bluetooth', id, model: $('printer').value, channel: Number($('channel').value) || null };
  }
  try {
    await connectTo(target);
    // Remember a printer that was typed in and worked
    if (target.unsaved) await saveNetPrinter({ quiet: true });
  } catch (err) {
    setConnected(false);
    log(t('Connection failed: {error}', { error: err.message }), 'err', { toast: false });
    showReconnect(t('Connection failed: {error}', { error: err.message }));
  }
}

for (const el of document.querySelectorAll('.js-connect')) el.addEventListener('click', onConnectClick);

$('btn-reconnect').addEventListener('click', async () => {
  if (!lastTarget) return;
  const button = $('btn-reconnect');
  button.disabled = true;
  button.textContent = t('Reconnecting…');
  try {
    await connectTo(lastTarget);
    log(t('Reconnected'), 'ok');
  } catch (err) {
    setConnected(false);
    log(t('Reconnect failed: {error}', { error: err.message }), 'err', { toast: false });
    showReconnect(t('Reconnect failed: {error}. Check the printer is on and try again.', { error: err.message }));
  } finally {
    button.disabled = false;
    button.textContent = t('Reconnect');
  }
});

$('btn-reconnect-dismiss').addEventListener('click', hideReconnect);

async function onDisconnectClick() {
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
}

for (const el of document.querySelectorAll('.js-disconnect')) el.addEventListener('click', onDisconnectClick);

$('btn-status').addEventListener('click', async () => {
  try {
    // NetworkLink.fetchStatus() reports through its 'status' event
    if (active.kind === 'network') await active.fetchStatus();
    else showStatus(await fetchStatus(active));
    log(t('Status updated'), 'ok');
  } catch (err) {
    log(t('Could not read status: {error}', { error: err.message }), 'err');
    noteIfDisconnected(err);
  }
});

$('btn-feed').addEventListener('click', () => runSimple(() => tapeFeed(active, false), t('Tape feed')));
$('btn-feed-cut').addEventListener('click', () => runSimple(() => tapeFeed(active, true), t('Feed + cut')));

/**
 * 通信が原因で失敗したなら再接続を促す。
 * 切断通知が届かずにエラーだけ返ってくる経路 (送信中の書き込み失敗など) の保険。
 */
function noteIfDisconnected(err) {
  if (active?.connected) return;
  showReconnect(t('Lost communication with the printer ({error}). Please reconnect.', { error: err.message }));
}

async function runSimple(fn, name) {
  setPrinting(true);
  try {
    log(t('{name}…', { name }));
    await fn();
    log(t('{name} done', { name }), 'ok');
  } catch (err) {
    log(t('{name} failed: {error}', { name, error: err.message }), 'err');
    noteIfDisconnected(err);
  } finally {
    setPrinting(false);
  }
}

/** ページ環境コマンドを組める commandLevel か */
function printableModel() {
  const printer = currentPrinter();
  if (active?.kind === 'network' && printer.statusLength !== 20) {
    log(t('Wi-Fi printing supports the SR5900P / SR5900C / SR5900GS. Pick one of those under Model '
      + '(currently {model}).', { model: printer.model }), 'err');
    return false;
  }
  if (SUPPORTED_COMMAND_LEVELS.includes(printer.commandLevel)) return true;
  log(t('{model} uses command level {level}, whose page commands are not decoded yet, so it cannot print.',
    { model: printer.model, level: printer.commandLevel }), 'err');
  return false;
}

/** Wi-Fi: the backend runs the whole session; we send the complete job in one request. */
async function runNetworkPrint(pages, opts) {
  const link = active;
  currentJob = { cancel: () => link.cancel() };
  const bytes = buildNetworkJobBytes(pages, opts);
  setProgress(0, bytes.length, t('Sending to printer'));
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
    log(t('{what} printed', { what }), 'ok');
  } catch (err) {
    if (err.name === 'PrintAborted') {
      log(t('Print cancelled'), 'warn');
    } else {
      log(t('Print failed: {error}', { error: err.message }), 'err');
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
  await ensureFontLoaded(`16px ${cssFamily($('font').value)}`, $('text').value || FONT_SAMPLE);
  // アイコンも同じ。読み込み前に描くと空白のまま印字される。
  if (!await ensureIcons($('text').value)) return;
  const built = buildPage();
  lastRender = built;
  if (!built) { log(t('Nothing printable for this tape width'), 'err'); return; }
  if (!printableModel()) return;

  await runPrint([built.page], printOptions(), t('Label'));
});

$('btn-job-print').addEventListener('click', async () => {
  if (!jobItems.length) { log(t('The batch is empty'), 'warn', { toast: true }); return; }
  if (!printableModel()) return;

  const sets = Math.max(1, Math.min(99, Number($('job-sets').value) || 1));
  const pages = [];
  const skipped = [];
  for (const item of jobItems) {
    // フォントは項目ごとに違う。描く前に必ず読み込みを待つ。
    await ensureFontLoaded(`16px ${cssFamily(item.design.fontFamily)}`, item.design.text || FONT_SAMPLE);
    itemPageCache.delete(item.id);
    const built = await itemPage(item);
    if (!built) { skipped.push(itemLabel(item)); continue; }
    for (let i = 0; i < item.copies; i++) pages.push(built.page);
  }

  if (skipped.length) {
    log(t('Skipping items that do not fit this tape width: {items}', { items: skipped.join(', ') }), 'warn', { toast: true });
  }
  if (!pages.length) { log(t('No printable items'), 'err'); return; }

  await renderJobList();
  log(t('Printing batch ({items} items / {labels} labels / {sets} set(s))',
    { items: jobItems.length, labels: pages.length * sets, sets }));
  await runPrint(pages, printOptions(sets), t('Batch'));
});

$('btn-print-mobile').addEventListener('click', () => $('btn-print').click());

$('btn-cancel').addEventListener('click', () => {
  if (currentJob) { currentJob.cancel(); log(t('Cancel requested'), 'warn'); }
});

// ---- ジョブの操作 -------------------------------------------------------

$('btn-job-add').addEventListener('click', async () => {
  const item = createItem(readDesignFromUI(), { copies: Math.max(1, Number($('copies').value) || 1) });
  jobItems.push(item);
  selectedItemId = item.id;
  await renderJobList();
  log(t('Added to batch: {name}', { name: itemLabel(item) }), 'ok');
});

$('btn-job-update').addEventListener('click', async () => {
  const item = selectedItem();
  if (!item) return;
  item.design = readDesignFromUI();
  itemPageCache.delete(item.id);
  await renderJobList();
  log(t('Overwrote selected item: {name}', { name: itemLabel(item) }), 'ok');
});

$('btn-job-edit').addEventListener('click', async () => {
  const item = selectedItem();
  if (!item) return;
  await applyDesignToUI(item.design);
  $('copies').value = String(item.copies);
  refresh();
  log(t('Loaded into editor: {name}', { name: itemLabel(item) }));
});

$('btn-job-clear').addEventListener('click', async () => {
  if (!jobItems.length) return;
  if (!confirm(t('Remove all {n} item(s) from the batch?', { n: jobItems.length }))) return;
  jobItems = [];
  selectedItemId = null;
  invalidateJobPages();
  await renderJobList();
  log(t('Batch cleared'));
});

$('job-sets').addEventListener('input', () => updateJobSummary());

$('btn-job-save').addEventListener('click', () => {
  const json = serializeJob(jobItems, {
    printer: $('printer').value,
    tapeCode: Number($('tape').value),
    tapeCut: Number($('tape-cut').value),
    halfCut: Number($('half-cut').value),
    leadingHalfCut: Number($('lead-cut').value),
    density: Number($('density').value),
    sets: Math.max(1, Number($('job-sets').value) || 1),
  });
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tepra-job-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  log(t('Saved batch with {n} item(s)', { n: jobItems.length }), 'ok');
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
    $('lead-cut').value = String(loaded.print.leadingHalfCut);
    $('density').value = String(loaded.print.density);
    $('job-sets').value = String(loaded.print.sets);

    jobItems = loaded.items;
    selectedItemId = null;
    invalidateJobPages();
    // 項目ごとにフォントが違うので、描く前にまとめて読み込んでおく
    for (const item of jobItems) {
      await ensureFontLoaded(`16px ${cssFamily(item.design.fontFamily)}`, item.design.text || FONT_SAMPLE);
    }
    await renderJobList();
    refresh();
    log(t('Loaded batch with {n} item(s) ({file})', { n: jobItems.length, file: file.name }), 'ok');
  } catch (err) {
    log(t('Could not open batch: {error}', { error: err.message }), 'err');
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
  log(t('Saved {n} command bytes', { n: bytes.length.toLocaleString() }));
});

$('btn-hex').addEventListener('click', () => {
  const built = lastRender || buildPage();
  if (!built) return;
  const bytes = buildJobBytes([built.page], printOptions());
  const head = bytes.subarray(0, 512);
  $('hex-out').textContent = `${t('{total} bytes total (first {shown} shown)',
    { total: bytes.length.toLocaleString(), shown: head.length })}\n\n${toHex(head)}`;
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
      reader.onerror = () => reject(new Error(t('Cannot read the file')));
      reader.readAsDataURL(file);
    });
    labelImage = await loadImage(dataUrl);
    labelImageUrl = normalizeDesign({ imageDataUrl: dataUrl }).imageDataUrl;
    if (!labelImageUrl) {
      log(t('This format cannot be saved in a batch (PNG / JPEG / GIF / WebP / BMP only). '
        + 'It still works for the current label.'), 'warn');
    }
    refresh();
  } catch (err) {
    log(t('Could not load image: {error}', { error: err.message }), 'err');
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

$('btn-load-fonts').addEventListener('click', () => loadLocalFonts());

for (const id of ['text', 'align', 'bold', 'italic', 'border', 'dividers', 'tape',
                  'fixed-length', 'padding', 'tape-margin', 'dither', 'flip', 'image-pos']) {
  $(id).addEventListener('input', refresh);
  $(id).addEventListener('change', refresh);
}
for (const el of document.querySelectorAll('input[name=preview-mode]')) {
  el.addEventListener('change', refresh);
}

// ---- アイコンとセクション -------------------------------------------------

/**
 * 本文にアイコンがあれば icons.json の読み込みを待つ。読めなかったら false。
 * 読み込みが済んだら描き直す (読み込み前のプレビューはアイコンの場所が空白)。
 */
async function ensureIcons(text) {
  if (iconsLoaded() || !iconIds(text).length) return true;
  try {
    await loadIcons();
    invalidateJobPages();
    refresh();
    return true;
  } catch (err) {
    log(t('Could not load the icons: {error}', { error: err.message }), 'err');
    return false;
  }
}

/** textarea のカーソル位置に文字列を入れる */
function insertAtCursor(textarea, text) {
  const { selectionStart: start, selectionEnd: end, value } = textarea;
  textarea.value = value.slice(0, start) + text + value.slice(end);
  textarea.selectionStart = textarea.selectionEnd = start + text.length;
  textarea.focus();
  refresh();
}

let iconTab = ICON_TABS[0].id;

function renderIconTabs() {
  const box = $('icon-tabs');
  box.replaceChildren(...ICON_TABS.map((tab) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.role = 'tab';
    b.textContent = t(tab.label);
    b.setAttribute('aria-selected', String(tab.id === iconTab && !$('icon-search').value.trim()));
    b.addEventListener('click', () => {
      iconTab = tab.id;
      $('icon-search').value = '';
      renderIconGrid();
    });
    return b;
  }));
}

function renderIconGrid() {
  renderIconTabs();
  const query = $('icon-search').value.trim();
  const ids = query ? searchIcons(query) : iconsInTab(iconTab);
  $('icon-grid').replaceChildren(...ids.map((id) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = id;
    b.innerHTML = iconSvg(id); // icons.json は自前で生成したデータ
    b.addEventListener('click', () => {
      $('icon-dialog').close();
      insertAtCursor($('text'), `[${id}]`);
    });
    return b;
  }));
  $('icon-info').textContent = query && !ids.length
    ? t('No icons match “{query}”', { query })
    : t('{n} icons. Click one to insert it at the cursor.', { n: ids.length });
}

$('btn-insert-icon').addEventListener('click', async () => {
  try {
    await loadIcons();
  } catch (err) {
    log(t('Could not load the icons: {error}', { error: err.message }), 'err');
    return;
  }
  renderIconGrid();
  $('icon-dialog').showModal();
  $('icon-search').focus();
});
$('icon-search').addEventListener('input', () => renderIconGrid());

$('btn-new-section').addEventListener('click', () => {
  const ta = $('text');
  const before = ta.value.slice(0, ta.selectionStart);
  const after = ta.value.slice(ta.selectionEnd);
  // 区切りは必ず単独の行にする。後ろが既に改行なら足さずにその先へカーソルを置く
  // (空行を作るとその行もセクションの 1 行に数えられて文字が小さくなる)。
  insertAtCursor(ta, `${before && !before.endsWith('\n') ? '\n' : ''}${SECTION_BREAK}${after.startsWith('\n') ? '' : '\n'}`);
  if (after.startsWith('\n')) ta.selectionStart = ta.selectionEnd = ta.selectionStart + 1;
});

/** 本文に入れる画像の最大の大きさ。いちばん広いテープ (36mm, 384 dot) より大きければ足りる。 */
const INLINE_IMAGE_MAX = { height: 512, width: 2048 };

/**
 * 画像ファイルを本文用に縮めて PNG の data URL にする。ジョブ保存のサイズを抑えるのと、
 * どの形式 (SVG を含む) でも保存できる形にそろえるため。透明部分は残る (白地に描かれる)。
 */
async function inlineImageUrl(file) {
  const source = URL.createObjectURL(file);
  try {
    const img = await loadImage(source);
    const w = img.naturalWidth || 1;
    const h = img.naturalHeight || 1;
    const k = Math.min(1, INLINE_IMAGE_MAX.height / h, INLINE_IMAGE_MAX.width / w);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * k));
    canvas.height = Math.max(1, Math.round(h * k));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(source);
  }
}

$('btn-insert-image').addEventListener('click', () => $('inline-image').click());
$('inline-image').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const url = await inlineImageUrl(file);
    const img = await loadImage(url);
    // 番号は本文とこれまでの画像のどちらとも重ならないものにする
    const used = [...Object.keys(inlineImages), ...imageKeys($('text').value)].map(Number);
    const key = String(Math.max(0, ...used) + 1);
    inlineImages[key] = { url, img };
    insertAtCursor($('text'), `[img:${key}]`);
  } catch (err) {
    log(t('Could not load image: {error}', { error: err.message }), 'err');
  }
});

// 手で "[tabler:…]" と書いたときも、アイコンの読み込みを始める
$('text').addEventListener('input', () => { ensureIcons($('text').value); });

// ---- 言語 ---------------------------------------------------------------

/** The sample label text in index.html; replaced by its translation while untouched */
const DEFAULT_TEXT = 'TEPRA\nWeb';

/** Redraws everything JS wrote, after applyI18n() has handled index.html. */
function relocalize() {
  if (isTranslationOf($('text').value, DEFAULT_TEXT)) $('text').value = t(DEFAULT_TEXT);
  renderPrinterOptions();
  refreshTapeOptions();
  renderFontOptions();
  refresh();
  renderJobList();
  setConnected(!!active?.connected, connLabel);
  updateBackendState();
  if (shownStatus) showStatus(shownStatus);
}

applyI18n();
initLanguageSelect($('lang'));
if (isTranslationOf($('text').value, DEFAULT_TEXT)) $('text').value = t(DEFAULT_TEXT);
languageEvents.addEventListener('change', relocalize);

// ---- Keeping the label between visits -----------------------------------
// The label being edited (design + print settings) and the batch are kept in localStorage,
// so a reload or a closed tab doesn't lose them. Nothing is saved until they are restored.

const PRINT_SETTING_IDS = ['copies', 'density', 'tape-cut', 'lead-cut', 'half-cut', 'job-sets'];
let saveReady = false;
let saveTimer = null;
let savedBatch = null;
let warnedSaveFailed = false;

function scheduleSave() {
  if (!saveReady) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSession, 400);
}

/** localStorage.setItem that says whether it worked (quota, private mode) */
function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(`tepra-web.${key}`);
    else localStorage.setItem(`tepra-web.${key}`, value);
    return true;
  } catch {
    return false;
  }
}

function saveSession() {
  const print = Object.fromEntries(PRINT_SETTING_IDS.map((id) => [id, $(id).value]));
  let ok = store('draft', JSON.stringify({ design: readDesignFromUI(), print }));

  const batch = jobItems.length ? JSON.stringify(jobItems.map(({ name, copies, design }) => ({ name, copies, design }))) : null;
  if (batch !== savedBatch) {
    if (store('batch', batch)) savedBatch = batch;
    else ok = false;
  }
  if (!ok && !warnedSaveFailed) {
    // Usually images too big for the browser's storage; the page itself still works
    warnedSaveFailed = true;
    log(t('Could not keep the label in this browser (storage full or blocked). It will be lost on reload.'), 'warn');
  }
}

function readStored(key) {
  try {
    const raw = localStorage.getItem(`tepra-web.${key}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function restoreSession() {
  const draft = readStored('draft');
  if (draft?.design) {
    const design = normalizeDesign(draft.design);
    if (isTranslationOf(design.text, DEFAULT_TEXT)) design.text = t(DEFAULT_TEXT);
    await applyDesignToUI(design);
  }
  for (const id of PRINT_SETTING_IDS) {
    const value = draft?.print?.[id];
    if (typeof value !== 'string') continue;
    const el = $(id);
    if (el.tagName === 'SELECT' ? [...el.options].some((o) => o.value === value) : Number.isFinite(Number(value))) {
      el.value = value;
    }
  }

  const batch = readStored('batch');
  if (Array.isArray(batch) && batch.length) {
    savedBatch = JSON.stringify(batch);
    jobItems = batch.slice(0, 500).map((it) => createItem(it.design, { name: it.name, copies: it.copies }));
    for (const item of jobItems) {
      await ensureFontLoaded(`16px ${cssFamily(item.design.fontFamily)}`, item.design.text || FONT_SAMPLE);
    }
  }
}

for (const id of PRINT_SETTING_IDS) $(id).addEventListener('change', scheduleSave);

// ---- Small UI toggles ---------------------------------------------------

$('btn-text-help').addEventListener('click', () => {
  const open = $('text-help').hidden;
  $('text-help').hidden = !open;
  $('btn-text-help').setAttribute('aria-expanded', String(open));
});

$('more-settings').open = prefs.get('more-settings') === '1';
$('more-settings').addEventListener('toggle', () => {
  prefs.set('more-settings', $('more-settings').open ? '1' : '0');
});

// ---- 起動 ---------------------------------------------------------------

initSelects();
refresh();
setConnected(false);
(async () => {
  await initFonts();   // フォントが決まった時点で refresh() まで進む
  await restoreSession();
  refresh();
  await renderJobList();
  saveReady = true;
})();

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
    setConnectDisabled(true);
    log(t('Cannot reach the backend. Only preview and saving command bytes work.'), 'warn', { toast: true });
    return;
  }

  btAvailable = !!backendState.rfcomm;
  netPrinters = backendState.printers || [];
  renderNetPrinters();
  updateBackendState();
  setConnected(false);

  if (connKind() === 'network') {
    log(netPrinters.length
      ? t('Ready. Pick your printer and press Connect.')
      : t("Ready. Type your printer's IP address (or use Find on network) and press Connect."));
  } else {
    log(t('Ready. Turn the printer on, scan for paired devices and press Connect.'));
  }
}

/** Says why Connect can't work (no backend, no Bluetooth); stays hidden when all is well. */
function updateBackendState() {
  const el = $('backend-state');
  let problem = '';
  if (!backendState) {
    problem = t('Backend not running (start it with npm start or Docker).');
  } else if (connKind() === 'network' || btAvailable) {
    setConnectDisabled(false);
  } else {
    problem = t('Bluetooth is not available on the server: {reason}',
      { reason: backendState.rfcommError || t('unknown reason') });
    setConnectDisabled(true);
  }
  el.textContent = problem;
  el.hidden = !problem;
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
