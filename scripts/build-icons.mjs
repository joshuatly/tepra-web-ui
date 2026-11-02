// Builds app/icons.json from the three open icon sets the label editor uses.
//
//   Tabler Icons (MIT)        outline, stroked on a 24 grid   → main set
//   Maki (CC0)                filled map pictograms, 15 grid  → the "Sign" tab
//   Phosphor, Bold (MIT)      filled outline, 256 grid        → only names Tabler lacks
//
// The output is committed, so the app needs no build step. Re-run this when updating a set:
//
//   git clone --depth 1 https://github.com/tabler/tabler-icons
//   git clone --depth 1 https://github.com/mapbox/maki
//   git clone --depth 1 https://github.com/phosphor-icons/core phosphor-core
//   node scripts/build-icons.mjs --tabler tabler-icons --maki maki --phosphor phosphor-core
//
// Brand logos are left out on purpose: the licences cover the drawings, not the trademarks.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) =>
  (v.startsWith('--') ? [...acc, [v.slice(2), a[i + 1]]] : acc), []));
for (const key of ['tabler', 'maki', 'phosphor']) {
  if (!args[key]) {
    console.error('usage: node scripts/build-icons.mjs --tabler DIR --maki DIR --phosphor DIR');
    process.exit(2);
  }
}

const ROOT = new URL('../', import.meta.url);
const read = (...p) => readFileSync(path.join(...p), 'utf8');
const version = (dir) => JSON.parse(read(dir, 'package.json')).version;

// ---- Tabs ------------------------------------------------------------------
// The TEPRA LINK 2 tab names. Each icon goes in at most one; everything stays searchable.

const TABS = ['work', 'life', 'mark', 'play', 'vehicle', 'food', 'living', 'sign'];

const TABLER_TABS = {
  Devices: 'work', Document: 'work', Computers: 'work', Communication: 'work', Electrical: 'work',
  Laundry: 'life', Buildings: 'life', Health: 'life', 'E-commerce': 'life',
  Shapes: 'mark', Symbols: 'mark', Weather: 'mark', Mood: 'mark', Zodiac: 'mark', Badges: 'mark',
  Gestures: 'mark', Currencies: 'mark', Numbers: 'mark', Letters: 'mark',
  Sport: 'play', Games: 'play', Media: 'play', Photography: 'play',
  Vehicles: 'vehicle',
  Food: 'food',
  Animals: 'living', Nature: 'living',
  Gender: 'mark',
};

/**
 * Public-sign pictograms, shown first in the "Sign" tab (and first in search results) in this
 * order. The rest of the tab is Maki, which is a map set and also has shops, sports and so on.
 */
const SIGN_FIRST = [
  'maki:toilet', 'tabler:man', 'tabler:woman', 'maki:wheelchair', 'tabler:baby-carriage',
  'maki:information', 'maki:parking', 'maki:elevator', 'tabler:escalator', 'tabler:escalator-up',
  'tabler:escalator-down', 'tabler:stairs', 'tabler:stairs-up', 'tabler:door-exit',
  'tabler:fire-extinguisher', 'tabler:first-aid-kit', 'maki:defibrillator', 'tabler:emergency-bed',
  'tabler:lifebuoy', 'tabler:smoking-no', 'tabler:smoking', 'tabler:camera-off', 'tabler:ban',
  'tabler:alert-triangle', 'tabler:bolt', 'tabler:wifi', 'maki:telephone', 'maki:drinking-water',
  'maki:waste-basket', 'maki:recycling', 'tabler:luggage', 'maki:taxi', 'maki:bus', 'tabler:bus-stop',
  'maki:rail-metro', 'maki:airport', 'maki:charging-station', 'maki:fuel', 'maki:hospital-JP',
  'maki:hospital', 'maki:pharmacy', 'maki:police-JP', 'maki:post-JP', 'maki:restaurant', 'maki:cafe',
  'maki:bar', 'maki:hot-spring', 'maki:religious-shinto', 'maki:religious-buddhist', 'maki:castle-JP',
  'maki:museum', 'maki:park', 'maki:campsite', 'maki:swimming',
];

/** Phosphor's categories are UI-oriented, so its tab comes from the tags */
function phosphorTab(tags) {
  if (tags.some((t) => ['food', 'meal', 'fruit', 'drink', 'drinks', 'beverages'].includes(t))) return 'food';
  if (tags.some((t) => ['animal', 'animals', 'pet', 'pets', 'nature', 'plants'].includes(t))) return 'living';
  if (tags.some((t) => ['vehicle', 'vehicles', 'transportation', 'transit'].includes(t))) return 'vehicle';
  return null;
}

// ---- Japanese search words ----------------------------------------------------
// Japanese word → English words. An icon gets the Japanese word when its name or one of
// its tags is one of the English words. A starting set; extend as needed.

const JA = {
  'トイレ': ['toilet', 'toilets', 'restroom', 'wc'], '男性': ['man', 'male', 'gender-male'],
  '女性': ['woman', 'female', 'gender-female'], '車椅子': ['wheelchair', 'disabled'],
  '禁煙': ['smoking-no', 'no-smoking'], '喫煙': ['smoking', 'cigarette'], '案内': ['information', 'info'],
  '駐車場': ['parking'], 'エレベーター': ['elevator'], 'エスカレーター': ['escalator'], '階段': ['stairs'],
  '非常口': ['exit', 'emergency-exit'], '消火器': ['fire-extinguisher'], '救急': ['first-aid', 'first-aid-kit', 'ambulance'],
  'AED': ['defibrillator'], '電話': ['phone', 'telephone'], 'タクシー': ['taxi'], 'バス': ['bus'],
  '電車': ['train', 'rail'], '鉄道': ['train', 'rail'], '地下鉄': ['subway', 'rail-metro'], '飛行機': ['plane', 'airplane', 'airport'],
  '空港': ['airport'], '船': ['ship', 'boat', 'ferry'], '自転車': ['bike', 'bicycle'], 'バイク': ['motorbike', 'motorcycle'],
  '車': ['car'], 'トラック': ['truck'], 'ヘリコプター': ['helicopter'], '温泉': ['hot-spring', 'spa'],
  'レストラン': ['restaurant'], 'カフェ': ['cafe', 'coffee'], 'コーヒー': ['coffee'], 'お茶': ['tea'], 'ビール': ['beer'],
  'ワイン': ['wine'], '病院': ['hospital'], '警察': ['police'], '交番': ['police-JP'], '郵便': ['post', 'mail', 'mailbox'],
  '手紙': ['mail', 'envelope'], '荷物': ['luggage', 'package', 'box'], '薬': ['pill', 'pills', 'medicine', 'pharmacy'],
  '薬局': ['pharmacy'], 'ゴミ': ['trash', 'waste', 'waste-basket'], 'リサイクル': ['recycle', 'recycling'],
  '神社': ['torii', 'religious-shinto'], '寺': ['religious-buddhist', 'temple'], '城': ['castle', 'castle-JP'],
  '博物館': ['museum'], '公園': ['park'], 'キャンプ': ['tent', 'campsite', 'camping'], 'プール': ['pool', 'swimming'],
  '水泳': ['swimming', 'swim'], 'シャワー': ['shower'], '風呂': ['bath', 'bathtub'], '水': ['water', 'droplet', 'drinking-water'],
  '危険': ['alert-triangle', 'danger', 'caution'], '注意': ['alert-triangle', 'caution', 'alert-circle'],
  '禁止': ['ban', 'forbid', 'no-entry'], '情報': ['info', 'information'], '電気': ['bolt', 'electric'],
  '充電': ['charging-station', 'battery-charging'], 'ガソリン': ['fuel', 'gas-station'], 'ATM': ['atm'],
  'お金': ['cash', 'coin', 'money', 'currency-yen'], '円': ['currency-yen'], '鍵': ['key', 'lock'],
  'パソコン': ['computer', 'device-desktop', 'laptop', 'device-laptop'], 'ノートパソコン': ['laptop', 'device-laptop'],
  'プリンター': ['printer'], 'スマホ': ['device-mobile', 'phone', 'smartphone'], 'フォルダ': ['folder'],
  '書類': ['file', 'document', 'file-text'], 'ハサミ': ['scissors'], 'ペン': ['pen', 'pencil'],
  'カレンダー': ['calendar'], '時計': ['clock'], 'メール': ['mail'], 'かばん': ['briefcase', 'bag'], 'USB': ['usb'],
  'コンセント': ['plug', 'outlet'], 'ケーブル': ['cable', 'plug'], 'Wi-Fi': ['wifi'], 'キーボード': ['keyboard'],
  'マウス': ['mouse'], 'モニター': ['monitor', 'device-desktop'], '電池': ['battery'], '箱': ['box', 'package'],
  'クリップ': ['paperclip'], '電卓': ['calculator'], 'ヘッドホン': ['headphones'], '家': ['home', 'house'],
  'ベッド': ['bed'], 'ソファ': ['sofa', 'armchair'], '洗濯': ['wash', 'washing-machine', 'wash-machine'],
  'アイロン': ['iron', 'ironing'], 'ハンガー': ['hanger'], 'シャツ': ['shirt'], '傘': ['umbrella'], 'メガネ': ['eyeglass', 'glasses'],
  '赤ちゃん': ['baby', 'baby-carriage'], '電球': ['bulb', 'lightbulb'], '冷蔵庫': ['fridge'], '植物': ['plant', 'potted-plant'],
  '買い物': ['shopping-cart', 'shopping-bag'], 'プレゼント': ['gift'], '歯': ['tooth', 'dental'], 'ドア': ['door'],
  '窓': ['window'], 'テレビ': ['tv', 'television'], '工具': ['tool', 'tools', 'hammer', 'wrench'], '靴': ['shoe'],
  '財布': ['wallet'], '体温計': ['thermometer'], 'ハート': ['heart'], '星': ['star'], 'チェック': ['check'],
  'バツ': ['x'], '丸': ['circle'], '三角': ['triangle'], '四角': ['square'], '矢印': ['arrow'], 'はてな': ['question-mark', 'help'],
  '音楽': ['music'], '旗': ['flag'], '太陽': ['sun'], '晴れ': ['sun'], '月': ['moon'], '雲': ['cloud'], '雨': ['cloud-rain', 'umbrella'],
  '雪': ['snowflake'], '花': ['flower'], 'プラス': ['plus'], '王冠': ['crown'], '雷': ['bolt'], '火': ['flame', 'fire'],
  '笑顔': ['mood-smile', 'smiley'], 'いいね': ['thumb-up'], 'ベル': ['bell'], 'トロフィー': ['trophy'], 'メダル': ['medal'],
  'サッカー': ['ball-football', 'soccer', 'soccer-ball'], '野球': ['ball-baseball', 'baseball'],
  'バスケ': ['ball-basketball', 'basketball'], 'テニス': ['ball-tennis', 'tennis'], 'ゴルフ': ['golf'],
  'スキー': ['ski', 'skiing', 'ski-jumping'], 'テント': ['tent'], 'ギター': ['guitar'], 'ゲーム': ['device-gamepad', 'game-controller'],
  'サイコロ': ['dice'], 'トランプ': ['cards', 'play-card'], 'カメラ': ['camera'], '絵': ['palette', 'paint'], '釣り': ['fish-hook', 'fishing'],
  'ランニング': ['run', 'running'], '風船': ['balloon'], 'パズル': ['puzzle'], 'チケット': ['ticket'], '映画': ['movie', 'film', 'cinema'],
  'りんご': ['apple'], 'バナナ': ['banana'], 'にんじん': ['carrot'], 'パン': ['bread', 'baguette'], '卵': ['egg'], '魚': ['fish'],
  '肉': ['meat', 'steak'], 'チーズ': ['cheese'], 'ピザ': ['pizza'], 'ハンバーガー': ['burger', 'hamburger'], 'ケーキ': ['cake'],
  '牛乳': ['milk'], 'アイス': ['ice-cream'], 'ラーメン': ['soup', 'bowl-chopsticks', 'restaurant-noodle'], '寿司': ['restaurant-sushi'],
  'おにぎり': ['onigiri'], 'クッキー': ['cookie'], '飲み物': ['drink', 'glass', 'bottle'], '食事': ['tools-kitchen', 'fork-knife', 'restaurant'],
  '犬': ['dog'], '猫': ['cat'], '鳥': ['bird'], 'うさぎ': ['rabbit'], '馬': ['horse'], '牛': ['cow'], '豚': ['pig'], '蝶': ['butterfly'],
  '虫': ['bug'], 'クモ': ['spider'], '木': ['tree', 'trees'], '葉': ['leaf'], 'サボテン': ['cactus'], 'きのこ': ['mushroom'],
  '足あと': ['paw', 'paw-print'], '鹿': ['deer'],
};

const jaIndex = new Map();
for (const [ja, words] of Object.entries(JA)) {
  for (const w of words) {
    if (!jaIndex.has(w)) jaIndex.set(w, []);
    jaIndex.get(w).push(ja);
  }
}
function jaWords(name, tags) {
  const out = new Set();
  for (const w of [name, ...tags]) for (const ja of jaIndex.get(w) || []) out.add(ja);
  return [...out];
}

// ---- Readers -----------------------------------------------------------------

const PATH_D = /<path\b[^>]*\sd="([^"]+)"/g;
/** Shortens numbers to 2 decimals; the shapes are drawn at most ~200 dots tall. */
function tidy(d) {
  // Numbers are scanned left to right as the SVG parser would, so "-.23.0599" stays two numbers.
  // A run like "011.234" is arc flags glued to a number and is left alone.
  return d.replace(/&#x[0-9a-f]+;/gi, ' ')
    .replace(/-?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi, (n) => {
      const m = n.match(/^-?(\d*)\.(\d{3,})$/);
      if (!m || (m[1].length > 1 && m[1].startsWith('0'))) return n;
      return ` ${Math.round(Number(n) * 100) / 100}`;
    })
    .replace(/\s+/g, ' ').trim();
}
const paths = (svg) => [...svg.matchAll(PATH_D)].map((m) => tidy(m[1]));
const words = (list) => [...new Set(list.map((t) => String(t).toLowerCase().trim())
  .filter((t) => t && !t.includes('*')))];

function readTabler(dir) {
  const out = [];
  const base = path.join(dir, 'icons', 'outline');
  for (const file of readdirSync(base).sort()) {
    if (!file.endsWith('.svg')) continue;
    const name = file.slice(0, -4);
    const svg = read(base, file);
    const category = (svg.match(/^category: (.+)$/m) || [])[1]?.trim() || '';
    if (category === 'Brand' || name.startsWith('brand-')) continue;
    const tagText = (svg.match(/^tags: \[(.*)\]$/m) || [])[1] || '';
    const tags = words(tagText.split(',').map((t) => t.replace(/["']/g, ''))).filter((t) => t !== name);
    const d = paths(svg);
    if (!d.length) continue;
    out.push({
      id: `tabler:${name}`, name, set: 'tabler', stroke: 2, vb: 24, d, tags,
      tab: name.endsWith('-off') ? null : TABLER_TABS[category] || null,
    });
  }
  return out;
}

function readMaki(dir) {
  const out = [];
  const base = path.join(dir, 'icons');
  for (const file of readdirSync(base).sort()) {
    if (!file.endsWith('.svg')) continue;
    const name = file.slice(0, -4);
    const svg = read(base, file);
    const vb = Number((svg.match(/viewBox="0 0 (\d+)/) || [])[1] || 15);
    const tags = words(name.split('-').concat(name.endsWith('-JP') ? ['japan'] : []));
    out.push({ id: `maki:${name}`, name, set: 'maki', stroke: 0, vb, d: paths(svg), tags, tab: 'sign' });
  }
  return out;
}

function readPhosphor(dir, skipNames) {
  const src = read(dir, 'src', 'icons.ts');
  const meta = new Map();
  for (const m of src.matchAll(/name: "([^"]+)",[\s\S]*?categories: \[([^\]]*)\][\s\S]*?tags: \[([\s\S]*?)\]/g)) {
    meta.set(m[1], { brand: m[2].includes('BRAND'), tags: words([...m[3].matchAll(/"([^"]+)"/g)].map((x) => x[1])) });
  }
  const out = [];
  const base = path.join(dir, 'assets', 'bold');
  for (const file of readdirSync(base).sort()) {
    const name = file.replace(/-bold\.svg$/, '');
    const info = meta.get(name);
    if (!info || info.brand || name.endsWith('-logo') || skipNames.has(name)) continue;
    out.push({
      id: `phosphor:${name}`, name, set: 'phosphor', stroke: 0, vb: 256,
      d: paths(read(base, file)), tags: info.tags, tab: phosphorTab(info.tags),
    });
  }
  return out;
}

// ---- Build -------------------------------------------------------------------

const tabler = readTabler(args.tabler);
const maki = readMaki(args.maki);
const phosphor = readPhosphor(args.phosphor, new Set(tabler.map((i) => i.name)));

// Signs come first, so a search for "toilet" or "parking" shows the pictogram before an outline
const all = [...maki, ...tabler, ...phosphor];
const signRank = new Map(SIGN_FIRST.map((id, n) => [id, n]));
for (const id of SIGN_FIRST) {
  const icon = all.find((i) => i.id === id);
  if (!icon) throw new Error(`SIGN_FIRST: ${id} is not in the sets`);
  icon.tab = 'sign';
}
const rank = (i) => signRank.get(i.id) ?? SIGN_FIRST.length;
const ordered = all.map((icon, n) => ({ icon, n }))
  .sort((a, b) => rank(a.icon) - rank(b.icon) || a.n - b.n).map((x) => x.icon);

const icons = ordered.map((i) => {
  const ja = jaWords(i.name, [...i.name.split('-'), ...i.tags]);
  const entry = { id: i.id, d: i.d, vb: i.vb };
  if (i.stroke) entry.stroke = i.stroke;
  if (i.tab) entry.tab = i.tab;
  entry.k = [i.name.replace(/-/g, ' '), ...i.tags].join(' ');
  if (ja.length) entry.ja = ja.join(' ');
  return entry;
});

const out = {
  format: 'tepra-web/icons@1',
  sources: {
    tabler: { name: 'Tabler Icons', version: version(args.tabler), license: 'MIT', url: 'https://tabler.io/icons' },
    maki: { name: 'Maki', version: version(args.maki), license: 'CC0-1.0', url: 'https://github.com/mapbox/maki' },
    phosphor: { name: 'Phosphor Icons (Bold)', version: version(args.phosphor), license: 'MIT', url: 'https://phosphoricons.com' },
  },
  tabs: TABS,
  icons,
};
const json = JSON.stringify(out);
writeFileSync(new URL('app/icons.json', ROOT), `${json}\n`);

// Licence texts travel with the data
const licence = (dir) => read(dir, 'LICENSE').trim();
const makiLicence = read(args.maki, 'LICENSE.txt').trim();
writeFileSync(new URL('THIRD_PARTY_LICENSES.md', ROOT), `# Third-party licences

\`app/icons.json\` contains icons from these sets, built by \`scripts/build-icons.mjs\`.
Brand logos from the sets are not included.

## Tabler Icons ${out.sources.tabler.version} (MIT)

${out.sources.tabler.url}

\`\`\`
${licence(args.tabler)}
\`\`\`

## Phosphor Icons ${out.sources.phosphor.version}, Bold weight (MIT)

${out.sources.phosphor.url}

\`\`\`
${licence(args.phosphor)}
\`\`\`

## Maki ${out.sources.maki.version} (CC0 1.0)

${out.sources.maki.url}

\`\`\`
${makiLicence}
\`\`\`
`);

const count = (set) => icons.filter((i) => i.id.startsWith(`${set}:`)).length;
const perTab = Object.fromEntries(TABS.map((t) => [t, icons.filter((i) => i.tab === t).length]));
console.log(`icons.json: ${icons.length} icons (tabler ${count('tabler')}, maki ${count('maki')}, `
  + `phosphor ${count('phosphor')}), ${(json.length / 1024).toFixed(0)} KiB`);
console.log('per tab:', perTab);
console.log('with Japanese words:', icons.filter((i) => i.ja).length);
