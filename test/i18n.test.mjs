// Every English UI string has a Japanese translation, and language detection works.
// Run: node test/i18n.test.mjs

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { JA, detectLanguage } from '../app/i18n.js';
import { TAPE_WIDTHS, PRINTER_STATUS, DEVICE_ERROR } from '../app/models.js';
import { NO_RESPONSE_HINT } from '../app/job.js';

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

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

function decodeHtml(text) {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").trim().replace(/\s+/g, ' ');
}

/** Keys passed to t() as string literals (including 'a' + 'b' concatenations) */
function keysFromJs(source) {
  const literal = String.raw`(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")`;
  const re = new RegExp(String.raw`\b(?:t|setI18nText\([^,]+,|setDevicePlaceholder)\(\s*(${literal}(?:\s*\+\s*${literal})*)`, 'g');
  const keys = [];
  for (const m of source.matchAll(re)) {
    // eslint-disable-next-line no-new-func
    keys.push(Function(`return ${m[1]}`)());
  }
  return keys;
}

function keysFromHtml(html) {
  const keys = [];
  for (const [, , attrs, text] of html.matchAll(/<(\w+)(\s[^>]*)?>([^<]*)<\/\1>/g)) {
    const m = (attrs || '').match(/\sdata-i18n(?:="([^"]*)")?(?=[\s>]|$)/);
    if (m) keys.push(m[1] || decodeHtml(text));
  }
  for (const m of html.matchAll(/(placeholder|title|aria-label)="([^"]+)"[^>]*data-i18n-\1/g)) {
    keys.push(decodeHtml(m[2]));
  }
  return keys;
}

const missing = (keys) => [...new Set(keys)].filter((k) => !Object.hasOwn(JA, k));

test('index.html strings are translated', () => {
  const keys = keysFromHtml(read('index.html'));
  assert.ok(keys.length > 80, `only found ${keys.length} keys`);
  assert.deepEqual(missing(keys), []);
});

test('t() keys in app/*.js are translated', () => {
  const files = readdirSync(new URL('app/', root)).filter((f) => f.endsWith('.js') && f !== 'i18n.js');
  const keys = files.flatMap((f) => keysFromJs(read(`app/${f}`)));
  assert.ok(keys.length > 100, `only found ${keys.length} keys`);
  assert.deepEqual(missing(keys), []);
});

test('model tables are translated', () => {
  assert.deepEqual(missing([
    ...TAPE_WIDTHS.map((w) => w.label).filter((l) => !/^\d+mm$/.test(l)),
    ...Object.values(PRINTER_STATUS),
    ...Object.values(DEVICE_ERROR),
    'No tape', 'Unknown', NO_RESPONSE_HINT,
  ]), []);
});

test('placeholders match between English and Japanese', () => {
  for (const [en, ja] of Object.entries(JA)) {
    const names = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(names(ja), names(en), en);
  }
});

test('detectLanguage picks the first supported preference', () => {
  assert.equal(detectLanguage(['ja-JP', 'en-US']), 'ja');
  assert.equal(detectLanguage(['en-GB', 'ja']), 'en');
  assert.equal(detectLanguage(['fr-FR', 'ja']), 'ja');
  assert.equal(detectLanguage(['fr-FR', 'de']), 'en');
  assert.equal(detectLanguage([]), 'en');
  assert.equal(detectLanguage(undefined), 'en');
});

console.log(failed ? `${failed} failed, ${passed} passed` : `All passed (${passed})`);
process.exit(failed ? 1 : 0);
