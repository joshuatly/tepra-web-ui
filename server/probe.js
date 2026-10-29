// Bluetooth 接続の診断。
//   npm run probe                                   一番それらしい端末を自動選択
//   npm run probe -- 74-c9-0f-be-9d-e8              アドレスを指定
//   npm run probe -- --channel=6                    RFCOMM チャネルを固定
//   npm run probe -- --cycles=3                     接続 → 切断 を繰り返して再接続を確認
//   npm run probe -- --model=SR-MK1
//
// 送るのはリセットとステータス要求だけ。テープは動かさない。

import { toHex } from './transport.js';
import { RfcommTransport, rfcommUnavailableReason, normalizeAddress } from './rfcomm.js';
import { frameLength } from '../app/status.js';
import { findPrinter, PRINTER_STATUS, DEVICE_ERROR, tapeWidthLabel } from '../app/models.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RESET = Uint8Array.from([0x1b, 0x7b, 0x03, 0x21, 0x21, 0x7d]);
const STATUS_ONCE = Uint8Array.from([0x1b, 0x7b, 0x05, 0x49, 0x00, 0x00, 0x49, 0x7d]);

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};
const cycles = Number(flag('cycles', 1));
const channel = Number(flag('channel', 0)) || null;
let target = args.find((a) => !a.startsWith('--'));

console.log('TEPRA Web  Bluetooth 直接 (RFCOMM) 診断\n');

let deviceName = '';
let aclConnected = null;

const reason = await rfcommUnavailableReason();
if (reason) {
  console.log(`✗ ${reason}`);
  process.exit(1);
}

const devices = await RfcommTransport.list();
if (!devices.length) {
  console.log('✗ ペアリング済みの Bluetooth 端末が見つかりません。');
  console.log('  OS の Bluetooth 設定でプリンタとペアリングしてください。');
  process.exit(1);
}
console.log('ペアリング済みの端末:');
for (const d of devices) console.log(`  ${d.likely ? '★' : ' '} ${d.name}  ${d.detail}`);

const picked = target
  ? devices.find((d) => normalizeAddress(d.id) === normalizeAddress(target.split('@')[0]))
  : (devices.find((d) => d.likely) || devices[0]);
if (!picked && !target) {
  console.log('✗ 対象を決められません。');
  process.exit(1);
}
if (picked) {
  target = picked.id;
  deviceName = picked.name;
  aclConnected = picked.connected ?? null;
  if (!channel && picked.channels.length > 1) {
    console.log(`\n候補チャネル: ${picked.channels.join(', ')} — 上から順に試します`);
  }
} else {
  deviceName = target;
}

const printer = findPrinter(flag('model', deviceName));
console.log(`\n対象: ${target}${channel ? ` (ch${channel} 固定)` : ''}`);
console.log(`機種: ${printer.model} (${printer.resolution} dpi / statusLength ${printer.statusLength}`
  + ` / commandLevel ${printer.commandLevel} / フレーム ${frameLength(printer.statusLength)} バイト)`);

// ACL リンクの状態。RFCOMM を開くときに張り直すので、繋がっていなくても失敗ではない。
if (aclConnected !== null) {
  console.log(`Bluetooth: ${aclConnected ? '接続済み (ACL)' : 'リンク未確立（接続時に張ります）'}`);
}

/** 1 サイクル: 繋ぐ → リセット → ステータス要求 → 受信 → 後始末して切る */
async function cycle(n) {
  const t = new RfcommTransport(target, { channel });
  t.statusLength = printer.statusLength;
  t.asciiStatus = printer.statusLength === 8;
  t.debugRaw = true;
  t.on('log', ({ message }) => console.log(`    ${message}`));

  let got = null;
  t.on('status', (s) => { if (!got) got = s; });

  console.log(`\n--- ${n} 回目 ---`);
  try {
    await t.open();
  } catch (err) {
    console.log(`  ✗ 接続できません: ${err.message}`);
    return false;
  }
  if (t.channel) console.log(`  RFCOMM チャネル: ${t.channel}`);

  try {
    console.log(`  TX リセット      : ${toHex(RESET)}`);
    await t.write(RESET, 8000);
    await sleep(300);
    console.log(`  TX ステータス要求: ${toHex(STATUS_ONCE)}`);
    await t.write(STATUS_ONCE, 8000);
  } catch (err) {
    console.log(`  ✗ 送信できません: ${err.message}`);
    await t.close();
    return false;
  }

  for (let i = 0; i < 80 && !got; i++) await sleep(100);

  if (!got) {
    console.log(`  ✗ 応答なし (受信 ${t.bytesReceived} バイト)`);
    if (t.bytesReceived > 0) {
      console.log('    データは来ていますがフレームになりません。--model= で機種を変えて試してください。');
    } else {
      console.log('    チャネルが違う可能性があります。--channel= で指定して試してください。');
    }
    await t.close();
    return false;
  }

  console.log('  ✓ ステータス受信');
  console.log(`    状態      : ${PRINTER_STATUS[got.ST] ?? '不明'} (0x${(got.ST ?? 0).toString(16)})`);
  console.log(`    エラー    : ${got.ER === 0 ? 'なし' : (DEVICE_ERROR[got.ER] ?? got.ER)}`);
  console.log(`    装着テープ: ${tapeWidthLabel(got.tapeWidthCode)} (TW=0x${(got.TW ?? 0).toString(16)})`);
  console.log(`    印刷枚数  : ${got.PP}`);

  // PrintController.done() と同じ後始末: 自動通知 OFF に戻してから閉じる
  console.log(`  TX 後始末        : ${toHex(STATUS_ONCE)} (自動通知 OFF)`);
  await t.write(STATUS_ONCE, 3000).catch(() => {});
  await sleep(200);
  await t.close();
  console.log('  切断しました');
  return true;
}

let ok = 0;
for (let i = 1; i <= cycles; i++) {
  if (await cycle(i)) ok++;
  if (i < cycles) await sleep(1000);
}

console.log(`\n結果: ${ok}/${cycles} 成功`);
if (ok < cycles) {
  console.log('\nうまくいかないとき:');
  console.log('  ・プリンタの電源が入っているか（TEPRA は自動電源オフがあります）');
  console.log('  ・スマホの TEPRA LINK 2 など他の端末が繋がっていないか（同時接続は 1 台）');
  console.log('  ・自動ステータス通知モードのまま残っている場合は電源を入れ直すと復帰します');
  process.exit(1);
}
