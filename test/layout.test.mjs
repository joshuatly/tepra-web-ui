// Text layout (sections, lines, inline icons) and the icon data file.
// Run: node test/layout.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseSections, parseRuns, iconIds, layoutSections, ICON_TOKEN,
} from '../app/layout.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}\n  ${err.stack || err}`);
  }
}

/** Every character is 0.6 × the font size wide, like a monospaced font */
const measure = (text, px) => text.length * px * 0.6;
const opts = (extra = {}) => ({
  heightDots: 64, innerDots: 64, lineGapDots: 2, fontScale: 1, sectionGapDots: 10,
  align: 'center', measure, maxWidth: null, ...extra,
});

test('a line with only --- splits sections', () => {
  assert.deepEqual(parseSections('A\n---\nB\nC\nD\n  ---  \nE\nF'), [['A'], ['B', 'C', 'D'], ['E', 'F']]);
});

test('empty sections are dropped, empty text gives one empty line', () => {
  assert.deepEqual(parseSections('---\nA\n---\n\n---'), [['A']]);
  assert.deepEqual(parseSections(''), [['']]);
  assert.deepEqual(parseSections('---'), [['']]);
});

test('--- inside a line is text, not a break', () => {
  assert.deepEqual(parseSections('A --- B'), [['A --- B']]);
});

test('icon tokens split a line into runs', () => {
  assert.deepEqual(parseRuns('Cables [tabler:plug] Drawer 2'),
    [{ text: 'Cables ' }, { icon: 'tabler:plug' }, { text: ' Drawer 2' }]);
  assert.deepEqual(parseRuns('[maki:toilet][maki:hospital-JP]'),
    [{ icon: 'maki:toilet' }, { icon: 'maki:hospital-JP' }]);
});

test('unknown icons and other brackets stay as text', () => {
  assert.deepEqual(parseRuns('[tabler:nope] [x] [foo:bar]', (id) => id !== 'tabler:nope'),
    [{ text: '[tabler:nope] [x] [foo:bar]' }]);
});

test('iconIds lists each icon once', () => {
  assert.deepEqual(iconIds('[tabler:car] a [maki:toilet]\n[tabler:car]'), ['tabler:car', 'maki:toilet']);
  assert.deepEqual(iconIds('no icons'), []);
});

test('each section fills the tape with its own number of lines', () => {
  const { sections } = layoutSections([['A'], ['B', 'C', 'D'], ['E', 'F']], opts());
  const sizes = sections.map((s) => s.lines[0].fontPx);
  assert.equal(sizes[0], 64);                    // 1 line: full height
  assert.equal(sizes[1], Math.floor((64 - 4) / 3)); // 3 lines, 2 gaps
  assert.equal(sizes[2], Math.floor((64 - 2) / 2));
  // Lines of one section are centred around the tape centre
  const ys = sections[1].lines.map((l) => l.centerY);
  assert.ok(Math.abs((ys[0] + ys[2]) / 2 - 32) < 0.01, `centres ${ys}`);
});

test('sections sit side by side with the gap between them', () => {
  const { width, sections } = layoutSections([['AB'], ['C']], opts());
  assert.equal(sections[0].x, 0);
  assert.equal(sections[1].x, sections[0].width + 10);
  assert.equal(width, Math.ceil(sections[1].x + sections[1].width));
});

test('lines align inside their section', () => {
  const left = layoutSections([['AAAA', 'B']], opts({ align: 'left' })).sections[0].lines;
  const right = layoutSections([['AAAA', 'B']], opts({ align: 'right' })).sections[0].lines;
  const center = layoutSections([['AAAA', 'B']], opts({ align: 'center' })).sections[0].lines;
  assert.equal(left[1].x, 0);
  assert.equal(right[1].x, right[0].width - right[1].width);
  assert.equal(center[1].x, (center[0].width - center[1].width) / 2);
});

test('an icon is a square as tall as the text', () => {
  const line = layoutSections([['A[tabler:car]B']], opts()).sections[0].lines[0];
  const [a, icon, b] = line.runs;
  assert.equal(icon.icon, 'tabler:car');
  assert.equal(icon.width, line.fontPx);
  assert.equal(icon.x, a.width);
  assert.equal(b.x, a.width + icon.width);
});

test('a fixed length shrinks the text to fit', () => {
  const free = layoutSections([['A long label'], ['x']], opts());
  assert.ok(free.width > 200);
  const fitted = layoutSections([['A long label'], ['x']], opts({ maxWidth: 200 }));
  assert.ok(fitted.width <= 200, `width ${fitted.width}`);
  assert.ok(fitted.shrink < 1);
  // A label that already fits is left alone
  assert.equal(layoutSections([['A']], opts({ maxWidth: 200 })).shrink, 1);
});

// ---- icons.json -------------------------------------------------------------

const data = JSON.parse(readFileSync(new URL('../app/icons.json', import.meta.url), 'utf8'));

test('icons.json has the three sets and every tab', () => {
  assert.equal(data.format, 'tepra-web/icons@1');
  const sets = new Set(data.icons.map((i) => i.id.split(':')[0]));
  assert.deepEqual([...sets].sort(), ['maki', 'phosphor', 'tabler']);
  for (const tab of data.tabs) assert.ok(data.icons.some((i) => i.tab === tab), tab);
});

test('icon ids are unique and match the token syntax', () => {
  const ids = data.icons.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    const m = [...`[${id}]`.matchAll(ICON_TOKEN)];
    assert.equal(m.length === 1 && m[0][1], id, id);
  }
});

test('no brand logos are bundled', () => {
  const brands = data.icons.filter((i) => /^(tabler:brand-|phosphor:.*-logo$)/.test(i.id));
  assert.deepEqual(brands.map((i) => i.id), []);
});

test('every icon has path data and search words', () => {
  for (const i of data.icons) {
    assert.ok(i.d.length && i.d.every((d) => /^[Mm]/.test(d)), i.id);
    assert.ok(i.vb > 0 && i.k, i.id);
  }
});

test('common sign words find an icon in Japanese', () => {
  for (const word of ['トイレ', '駐車場', '車椅子', 'エレベーター', '非常口', 'AED']) {
    assert.ok(data.icons.some((i) => i.ja && i.ja.split(' ').includes(word)), word);
  }
});

console.log(failed ? `${failed} failed, ${passed} passed` : `All passed (${passed})`);
process.exit(failed ? 1 : 0);
