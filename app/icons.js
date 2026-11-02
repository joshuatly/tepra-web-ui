// 本文に入れるアイコン (Tabler / Maki / Phosphor)。データは scripts/build-icons.mjs が作る
// app/icons.json で、初めて必要になったときに読み込む (約 2 MB)。
//
// 描画は Path2D で同期的に行う。renderLabel() は同期関数で、プレビュー・ジョブ・印刷の
// どこからでも呼ばれるので、画像の読み込み待ちを挟まないようにしている。

const URL_ICONS = 'app/icons.json';

/** TEPRA LINK 2 と同じ並びのタブ。キーは icons.json の tab */
export const ICON_TABS = [
  { id: 'work', label: 'Work' },
  { id: 'life', label: 'Life' },
  { id: 'mark', label: 'Mark' },
  { id: 'play', label: 'Play' },
  { id: 'vehicle', label: 'Vehicle' },
  { id: 'food', label: 'Food' },
  { id: 'living', label: 'Living things' },
  { id: 'sign', label: 'Sign' },
];

let icons = null;
let byId = new Map();
let loading = null;

export const iconsLoaded = () => icons !== null;

/** icons.json を読む。何度呼んでも 1 回だけ取りに行く。 */
export function loadIcons() {
  if (!loading) {
    loading = fetch(URL_ICONS)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        icons = data.icons;
        byId = new Map(icons.map((i) => [i.id, i]));
        return icons;
      })
      .catch((err) => {
        loading = null;
        throw err;
      });
  }
  return loading;
}

export const getIcon = (id) => byId.get(id);

/**
 * 本文の中でアイコンとして扱う id か。読み込み前は書き方さえ合っていればアイコン扱い
 * (読み込み後に描き直す)。読み込み後に存在しない id は、打ち間違いが見えるよう文字のまま残す。
 */
export const isIconId = (id) => !icons || byId.has(id);

function paths(icon) {
  if (!icon.path2d) icon.path2d = icon.d.map((d) => new Path2D(d));
  return icon.path2d;
}

/**
 * アイコンを (x, y) を左上とする size × size の正方形に描く。
 * Tabler は線のアイコンなので、細くなりすぎないよう線幅に下限を付け、太字では太くする。
 */
export function drawIcon(ctx, id, x, y, size, { bold = false } = {}) {
  const icon = byId.get(id);
  if (!icon || size <= 0) return;
  const k = size / icon.vb;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  if (icon.stroke) {
    const minDots = bold ? 2.5 : 2; // 1-bit で途切れない太さ
    ctx.lineWidth = Math.max(icon.stroke * (bold ? 1.5 : 1), minDots / k);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const p of paths(icon)) ctx.stroke(p);
  } else {
    for (const p of paths(icon)) ctx.fill(p);
  }
  ctx.restore();
}

/** 一覧表示用の SVG */
export function iconSvg(id) {
  const icon = byId.get(id);
  if (!icon) return '';
  const paint = icon.stroke
    ? `fill="none" stroke="currentColor" stroke-width="${icon.stroke}" stroke-linecap="round" stroke-linejoin="round"`
    : 'fill="currentColor"';
  const body = icon.d.map((d) => `<path d="${d}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${icon.vb} ${icon.vb}" ${paint}>${body}</svg>`;
}

export function iconsInTab(tab) {
  return (icons || []).filter((i) => i.tab === tab).map((i) => i.id);
}

/**
 * 英語のタグ・日本語の語で探す。語はすべて一致しなければならない (AND)。
 * 名前の一致を上に、セットの順 (Maki → Tabler → Phosphor) はそのまま残す。
 */
export function searchIcons(query, limit = 300) {
  const terms = String(query).toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length || !icons) return [];
  const scored = [];
  for (let n = 0; n < icons.length; n++) {
    const icon = icons[n];
    const name = icon.id.slice(icon.id.indexOf(':') + 1).toLowerCase();
    const words = icon.k.split(' ');
    const ja = icon.ja ? icon.ja.split(' ') : [];
    let score = 0;
    for (const term of terms) {
      let s = 0;
      if (name === term) s = 100;
      else if (name.split('-').includes(term) || ja.includes(term)) s = 60;
      else if (name.startsWith(term)) s = 40;
      else if (words.includes(term)) s = 25;
      else if (words.some((w) => w.startsWith(term)) || ja.some((w) => w.includes(term))) s = 10;
      if (!s) { score = 0; break; }
      score += s;
    }
    if (score) scored.push({ id: icon.id, score, n });
  }
  // "car" で card・caret・carrot まで出さない: 語として一致したものがあれば前方一致だけのものは捨てる
  const exact = 25 * terms.length;
  const hits = scored.some((s) => s.score >= exact) ? scored.filter((s) => s.score >= exact) : scored;
  hits.sort((a, b) => b.score - a.score || a.n - b.n);
  return hits.slice(0, limit).map((s) => s.id);
}
