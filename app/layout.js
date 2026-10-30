// 本文の組版: セクション分け・行・アイコン入りの行を、テープ幅方向に収まる大きさで並べる。
// Canvas を使わない純粋な計算だけを置き、文字幅の測定は呼び出し側から関数で受け取る
// (Node のテストからも呼べるようにするため)。
//
// 本文の書き方:
//   - 1 行に "---" だけを書くと、そこから次のセクション。セクションはラベルの長さ方向に並ぶ。
//   - セクションごとに行数が違ってよい。各セクションは自分の行数でテープ幅いっぱいに収める
//     (1 行のセクションは大きく、3 行のセクションは小さくなる)。
//   - "[tabler:plug]" のような書き方でアイコンを文字の間に入れる。大きさは同じ行の文字と同じ。

/** この行だけのときセクションの区切り */
export const SECTION_BREAK = '---';

/** アイコンの書き方。セット名は icons.json の id の前半 */
export const ICON_TOKEN = /\[((?:tabler|maki|phosphor):[A-Za-z0-9-]+)\]/g;

const isBreak = (line) => line.trim() === SECTION_BREAK;

/**
 * 本文をセクション (行の配列) に分ける。中身の無いセクションは捨てる。
 * @param {string} text
 * @returns {string[][]}
 */
export function parseSections(text) {
  const sections = [[]];
  for (const line of String(text ?? '').split('\n')) {
    if (isBreak(line)) sections.push([]);
    else sections[sections.length - 1].push(line);
  }
  const used = sections.filter((lines) => lines.some((l) => l.trim()));
  return used.length ? used : [['']];
}

/**
 * 1 行を文字とアイコンの並びに分ける。
 * @param {string} line
 * @param {(id:string) => boolean} [isIcon] false を返した id は書いたままの文字として残す
 * @returns {Array<{text:string}|{icon:string}>}
 */
export function parseRuns(line, isIcon = () => true) {
  const runs = [];
  let text = '';
  let last = 0;
  for (const m of line.matchAll(ICON_TOKEN)) {
    if (!isIcon(m[1])) continue;
    text += line.slice(last, m.index);
    if (text) runs.push({ text });
    text = '';
    runs.push({ icon: m[1] });
    last = m.index + m[0].length;
  }
  text += line.slice(last);
  if (text) runs.push({ text });
  return runs;
}

/** 本文に出てくるアイコンの id (重複なし) */
export function iconIds(text) {
  return [...new Set([...String(text ?? '').matchAll(ICON_TOKEN)].map((m) => m[1]))];
}

/**
 * @typedef {Object} LayoutOptions
 * @property {number} heightDots      テープの印字可能ドット数
 * @property {number} innerDots       文字に使える高さ (枠線ぶんを引いたもの)
 * @property {number} lineGapDots     行間
 * @property {number} fontScale       行スロットに対する文字の高さ比 (0.4〜1.0)
 * @property {number} sectionGapDots  セクションの間隔
 * @property {'left'|'center'|'right'} align  セクション内での行の揃え
 * @property {(text:string, fontPx:number) => number} measure  文字列の幅
 * @property {(id:string) => boolean} [isIcon]
 * @property {number|null} [maxWidth] これより長くなるときは全体を縮める (固定長のとき)
 */

const MIN_FONT_PX = 4;

function layoutOnce(sections, o, shrink) {
  let x = 0;
  const out = sections.map((lines, si) => {
    const totalGap = o.lineGapDots * (lines.length - 1);
    const slot = Math.max(4, (o.innerDots - totalGap) / lines.length);
    const fontPx = Math.max(MIN_FONT_PX, Math.floor(slot * o.fontScale * shrink));
    const top = (o.heightDots - (slot * lines.length + totalGap)) / 2;

    const laid = lines.map((line, i) => {
      let w = 0;
      const runs = parseRuns(line, o.isIcon).map((run) => {
        // アイコンは文字の高さと同じ大きさの正方形
        const width = run.icon ? fontPx : o.measure(run.text, fontPx);
        const placed = { ...run, x: w, width };
        w += width;
        return placed;
      });
      return {
        fontPx,
        centerY: top + slot * i + slot / 2 + o.lineGapDots * i,
        width: Math.ceil(w),
        runs,
      };
    });

    const width = Math.max(0, ...laid.map((l) => l.width));
    for (const l of laid) {
      const free = width - l.width;
      l.x = x + (o.align === 'center' ? free / 2 : o.align === 'right' ? free : 0);
    }
    const section = { x, width, lines: laid };
    x += width + (si < sections.length - 1 ? o.sectionGapDots : 0);
    return section;
  });
  return { width: Math.ceil(x), sections: out };
}

/**
 * セクションを並べる。座標は本文の左端を 0 とした値。
 * @param {string[][]} sections parseSections() の結果
 * @param {LayoutOptions} o
 * @returns {{width:number, shrink:number, sections:Array<{x:number, width:number,
 *   lines:Array<{x:number, centerY:number, fontPx:number, width:number,
 *   runs:Array<{text?:string, icon?:string, x:number, width:number}>}>}>}}
 */
export function layoutSections(sections, o) {
  let shrink = 1;
  let result = layoutOnce(sections, o, shrink);
  // 固定長に収まらなければ文字を縮める。文字幅はほぼ大きさに比例するので数回で収まる。
  for (let i = 0; i < 6 && o.maxWidth != null && result.width > o.maxWidth; i++) {
    const textWidth = result.width - o.sectionGapDots * (sections.length - 1);
    const room = Math.max(1, o.maxWidth - o.sectionGapDots * (sections.length - 1));
    const next = shrink * Math.min(0.98, room / Math.max(1, textWidth));
    if (next <= 0.05) break;
    shrink = next;
    result = layoutOnce(sections, o, shrink);
  }
  return { ...result, shrink };
}
