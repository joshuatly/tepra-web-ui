// UI の言語切り替え (English / 日本語)。
//
// キーは英語の文言そのもの。日本語が無いキーは英語のまま出る。
// 日本語は元の nikachu2012/tepra_web の UI の文言をできるだけそのまま使い、
// Wi-Fi まわりなど元に無い部分だけ同じ調子で書き足している。
//
// HTML 側は data-i18n (textContent)、data-i18n-placeholder / -title / -aria-label
// (属性) を付けた要素の英語を初回にキーとして覚え、applyI18n() で差し替える。
// リンクなどを含む段落は data-i18n-html="<id>" で HTML ごと差し替える。

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'ja', name: '日本語' },
];

const STORAGE_KEY = 'tepra-web.lang';

/** 英語 → 日本語 */
export const JA = {
  // ---- index.html -------------------------------------------------------
  'TEPRA Web — label printing': 'TEPRA Web — ブラウザ版テプラ印字ツール',
  'Label printing for KING JIM TEPRA PRO': 'キングジム テプラ PRO のラベル印字ツール',
  'Not connected': '未接続',
  'Connect': 'プリンタに接続',
  'Disconnect': '切断',
  'Reconnect': '再接続',
  'Dismiss': '閉じる',
  'Label': 'ラベル',
  'Text (one line per row)': '本文（改行で行を分けます）',
  'Font': 'フォント',
  'Alignment': '文字揃え',
  'Center': '中央',
  'Left': '左',
  'Right': '右',
  'Filter fonts': 'フォント名で絞り込み',
  'e.g. Arial / Mono / Noto': '例: Hiragino / 明朝 / Mono',
  'Font list': 'フォント一覧',
  'Load installed fonts': 'インストール済みフォントを読み込む',
  'Bold': '太字',
  'Italic': '斜体',
  'Border': '枠線',
  'Text size': '文字サイズ',
  'Line spacing': '行間',
  'Image': '画像',
  'File': '読み込み',
  'Position': '配置',
  'Left of text': '文字の左',
  'Right of text': '文字の右',
  'Remove image': '画像を外す',
  'Tape & size': 'テープ / サイズ',
  'Model': '機種',
  'Tape width': 'テープ幅',
  'Match the tape loaded in the printer automatically': '装着中のテープ幅に自動で合わせる',
  'Label length': 'ラベル長',
  'Fit to content': '自動',
  'Fixed': '固定',
  'Fixed length (mm)': '固定長 (mm)',
  'Side padding (mm)': '版下の左右余白 (mm)',
  'Leading tape margin (mm)': 'テープ送り余白 (mm)',
  'Print settings': '印刷設定',
  'Copies': '枚数',
  'Density (-5 to +5)': '濃度 (-5〜+5)',
  'Cut': 'カット',
  'After each label': 'ラベルごとにカット',
  'After the whole job': 'ジョブ終了後にカット',
  "Don't cut": 'カットしない',
  'Half cut (backing stays joined)': 'ハーフカット（台紙はつながったまま）',
  'Off': 'しない',
  'On': 'する',
  'Dither (for photos)': '誤差拡散で2値化（写真向け）',
  'Flip vertically': '上下反転',
  'Printer': 'プリンタ',
  'Connection type': '接続方法',
  'Wi-Fi / LAN': 'Wi-Fi / LAN',
  'Bluetooth': 'Bluetooth',
  'Saved printers': '保存済みのプリンタ',
  '(none saved yet)': '（まだありません）',
  'IP address or host name': 'IP アドレスまたはホスト名',
  'Name': '名前',
  'Label printer': 'ラベルプリンタ',
  'Save printer': 'プリンタを保存',
  'Remove': '削除',
  'Find on network': 'ネットワークで探す',
  'Device': 'デバイス',
  '(not scanned)': '（未取得）',
  'RFCOMM channel': 'RFCOMM チャネル',
  'Auto (from SDP)': '自動（SDP から判定）',
  'Scan paired devices': 'デバイスを探す',
  'Preview': 'プレビュー',
  'Design': '版下',
  'Printed dots': '実際の印字ドット',
  'Print this label': '印刷（現在の版下）',
  'Print': '印刷',
  'Cancel': '中止',
  'Refresh status': '状態を取得',
  'Feed': 'テープ送り',
  'Feed + cut': '送り + カット',
  'Bluetooth only': 'Bluetooth 接続時のみ',
  'Printer status': 'プリンタ状態',
  'State': '状態',
  'Error': 'エラー',
  'Loaded tape': '装着テープ',
  'Counters': 'カウンタ',
  'Batch job': 'ジョブ',
  'Add current label': '現在の版下を追加',
  'Overwrite selected': '選択中を上書き',
  'Load selected into editor': '選択中を版下に読み込む',
  'Print batch': 'ジョブを一括印刷',
  'Sets': 'セット数',
  'Save batch': 'ジョブを保存',
  'Open batch': 'ジョブを読み込み',
  'Clear all': 'すべて消す',
  'Advanced': '詳細',
  'Save command bytes (.bin)': 'コマンドを保存 (.bin)',
  'Hex dump': '16進ダンプ',
  'Log': 'ログ',
  'Command bytes': '送信コマンド',
  'Close': '閉じる',

  // ---- main.js ----------------------------------------------------------
  'TEPRA\nWeb': 'テプラ\nWeb版',
  'Lost the connection while printing. Check the tape, then reconnect.':
    '印刷中にプリンタとの接続が切れました。テープの状態を確かめてから再接続してください。',
  'Lost the connection to the printer. Please reconnect.': 'プリンタとの接続が切れました。再接続してください。',
  'Connecting…': '接続中…',
  'Connected': '接続中',
  'Connected to {name} ({host}:{port})': '{name} ({host}:{port}) に接続しました',
  'Could not read status: {error}': 'ステータス取得に失敗: {error}',
  ' (BLE only, not supported)': '（BLE専用・接続不可）',
  '{shown} / {total}': '{shown} / {total} 件',
  '{total}': '{total} 件',
  'No fonts returned': 'フォントを取得できませんでした',
  'Loaded {n} installed fonts': 'インストール済みフォントを {n} 件読み込みました',
  'Loaded': '読み込み済み',
  'Could not list fonts: {error}': 'フォント一覧を取得できませんでした: {error}',
  'Not supported in this browser': 'このブラウザでは一覧を取得できません',
  'Listing installed fonts needs Chrome or Edge (and HTTPS or localhost). Only common fonts are offered.':
    'インストール済みフォントの列挙は Chrome / Edge（HTTPS か localhost）でのみ使えます。代表的なフォントだけ選べます。',
  'Cannot print on this tape width': 'このテープ幅では印字できません',
  'Move up': '上へ',
  'Move down': '下へ',
  '{items} item(s) / {labels} label(s)': '{items} 項目 / {labels} 枚',
  '(empty)': '（空）',
  ' / ~{mm} mm / raster {bytes} B': ' / 約 {mm} mm / ラスタ {bytes} B',
  'Could not load the image stored in the batch item': 'ジョブに入っていた画像を読み込めませんでした',
  'Cannot read the image': '画像を読み込めません',
  '{length} × {width} dot / {mm} mm / {dpi} dpi / {bytes} B': '{length} × {width} dot / {mm} mm / {dpi} dpi / ラスタ {bytes} B',
  'Unknown': '不明',
  'Unknown ({code})': '不明 ({code})',
  'None': 'なし',
  '{tape} (TW=0x{tw}, type {type})': '{tape}（TW=0x{tw}, 種別 {type}）',
  'buffer {bytes} B / ': 'バッファ {bytes} B / ',
  'printed {n} label(s)': '印刷済み {n} 枚',
  'Printing…': '印刷中…',
  'Connect a printer first': '先にプリンタに接続してください',
  ' (config)': '（設定ファイル）',
  'Other…': 'その他…',
  "Enter the printer's IP address first": '先にプリンタの IP アドレスを入力してください',
  'Saved printer {name} ({host})': 'プリンタ {name} ({host}) を保存しました',
  'Could not save the printer: {error}': 'プリンタを保存できませんでした: {error}',
  'Loaded tape ({tape}) is not supported by {model}': '装着テープ ({tape}) は {model} では使えません',
  'Tape width set to {tape} to match the printer': 'プリンタに合わせてテープ幅を {tape} にしました',
  'Status poll failed: {error}': 'ステータスの定期取得に失敗: {error}',
  'Remove {name} ({host})?': '{name} ({host}) を削除します。よろしいですか？',
  'Removed {name}': '{name} を削除しました',
  'Searching…': '検索中…',
  'No printers answered. Discovery needs the server on the same LAN (Docker: network_mode: host). You can still type the IP address.':
    '応答したプリンタはありません。検索にはサーバーが同じ LAN にいる必要があります（Docker では network_mode: host）。IP アドレスを直接入力しても接続できます。',
  'Use': '使う',
  'Found {n} printer(s) on the network': 'ネットワーク上で {n} 台見つかりました',
  'Discovery failed: {error}': '検索に失敗: {error}',
  '(scanning…)': '（検索中…）',
  '(none found)': '（見つかりません）',
  'No paired Bluetooth devices found. Pair the printer in the OS settings first.':
    'ペアリング済みの Bluetooth 端末が見つかりません。OS の設定でプリンタとペアリングしてください。',
  'Found {n} device(s)': '{n} 件見つかりました',
  '(scan failed)': '（取得失敗）',
  'Device scan failed: {error}': 'デバイス一覧の取得に失敗: {error}',
  'Detected model {model} ({dpi} dpi)': '機種を {model} と判定しました（{dpi} dpi）',
  'Pick a saved printer or type its IP address first': '先に保存済みのプリンタを選ぶか IP アドレスを入力してください',
  'Scan for paired devices and pick the printer first': '先に「デバイスを探す」で接続先を選んでください',
  'Connection failed: {error}': '接続に失敗しました: {error}',
  'Reconnecting…': '再接続中…',
  'Reconnected': '再接続しました',
  'Reconnect failed: {error}': '再接続に失敗: {error}',
  'Reconnect failed: {error}. Check the printer is on and try again.':
    '再接続に失敗しました: {error}。プリンタの電源を確かめてもう一度試してください。',
  'Status updated': 'ステータスを取得しました',
  'Tape feed': 'テープ送り',
  'Lost communication with the printer ({error}). Please reconnect.':
    'プリンタとの通信が切れました（{error}）。再接続してください。',
  '{name}…': '{name} を実行します',
  '{name} done': '{name} 完了',
  '{name} failed: {error}': '{name} に失敗: {error}',
  'Wi-Fi printing supports the SR5900P / SR5900C / SR5900GS. Pick one of those under Model (currently {model}).':
    'Wi-Fi 印刷は SR5900P / SR5900C / SR5900GS に対応しています。「機種」でいずれかを選んでください（現在は {model}）。',
  '{model} uses command level {level}, whose page commands are not decoded yet, so it cannot print.':
    '{model} はコマンドレベル {level} です。このレベルのページ環境コマンドは未解析のため印字できません。',
  'Sending to printer': 'プリンタへ送信中',
  '{what} printed': '{what}を送信しました',
  'Print cancelled': '印刷を中止しました',
  'Print failed: {error}': '印刷に失敗: {error}',
  'Nothing printable for this tape width': '印字できる版下がありません',
  'The batch is empty': 'ジョブが空です',
  'Skipping items that do not fit this tape width: {items}': 'このテープ幅で印字できない項目を飛ばします: {items}',
  'No printable items': '印字できる項目がありません',
  'Printing batch ({items} items / {labels} labels / {sets} set(s))':
    'ジョブを印刷します（{items} 項目 / {labels} 枚 / {sets} セット）',
  'Batch': 'ジョブ',
  'Cancel requested': '中止を要求しました',
  'Added to batch: {name}': 'ジョブに追加しました: {name}',
  'Overwrote selected item: {name}': '選択中の項目を上書きしました: {name}',
  'Loaded into editor: {name}': '版下に読み込みました: {name}',
  'Remove all {n} item(s) from the batch?': 'ジョブの {n} 項目をすべて消します。よろしいですか？',
  'Batch cleared': 'ジョブを空にしました',
  'Saved batch with {n} item(s)': 'ジョブ {n} 項目を保存しました',
  'Loaded batch with {n} item(s) ({file})': 'ジョブ {n} 項目を読み込みました ({file})',
  'Could not open batch: {error}': 'ジョブを読み込めませんでした: {error}',
  'Saved {n} command bytes': 'コマンド {n} バイトを保存しました',
  '{total} bytes total (first {shown} shown)': '全 {total} バイト（先頭 {shown} バイトを表示）',
  'Cannot read the file': 'ファイルを読めません',
  'This format cannot be saved in a batch (PNG / JPEG / GIF / WebP / BMP only). It still works for the current label.':
    'この形式はジョブに保存できません（PNG / JPEG / GIF / WebP / BMP のみ）。現在の版下では使えます。',
  'Could not load image: {error}': '画像を読み込めませんでした: {error}',
  'Cannot reach the backend. Only preview and saving command bytes work.':
    'バックエンドに接続できません。プレビューとコマンド保存のみ利用できます。',
  'Ready. Pick your printer and press Connect.': '準備完了。プリンタを選んで「プリンタに接続」を押してください。',
  "Ready. Type your printer's IP address (or use Find on network) and press Connect.":
    '準備完了。プリンタの IP アドレスを入力するか「ネットワークで探す」を使い、「プリンタに接続」を押してください。',
  'Ready. Turn the printer on, scan for paired devices and press Connect.':
    '準備完了。プリンタの電源を入れて「デバイスを探す」を押してください。',
  'Backend not running (start it with npm start or Docker).': 'バックエンド未起動（npm start か Docker で起動できます）',
  'Server {version} — Wi-Fi printing over UDP/TCP 9100': 'サーバー {version} — Wi-Fi 印刷 (UDP/TCP 9100)',
  'Server {version} ({platform}) — Bluetooth available': 'バックエンド稼働中 {version} ({platform}) — RFCOMM 利用可',
  'Bluetooth is not available on the server: {reason}': 'Bluetooth 直接接続が使えません: {reason}',
  'unknown reason': '原因不明',

  // ---- models.js (テープ / 状態 / エラー) ----------------------------------
  '24mm (cable)': '24mm (ケーブル)',
  '36mm (cable)': '36mm (ケーブル)',
  '50mm (new)': '50mm (新)',
  'No tape': 'テープなし',
  'code {code}': 'コード {code}',
  'Idle': 'アイドル',
  'Feeding tape': 'テープ送り中',
  'Printing': '印刷中',
  'Receiving data': 'データ受信中',
  'Feed complete': 'テープ送り完了',
  'Print complete': '印刷完了',
  'Pick&Print printing': 'Pick&Print 印刷中',
  'Demo printing': 'デモ印刷中',
  'Feeding (from printer)': '本体テープ送り中',
  'Printing (from printer)': '本体印刷中',
  'Updating firmware': 'ファーム更新中',
  'Small roll standby': '小ロール待機',
  'Waiting for label removal': 'テープ取り出し待ち',
  'Embossing': '刻印中',
  'Emboss feed': '刻印送り',
  'Emboss feed complete': '刻印送り完了',
  'Unexpected error': '予期しないエラー',
  'No error': 'エラーなし',
  'Cutter error': 'カッターエラー',
  'No tape cartridge': 'テープカートリッジなし',
  'Print head overheated': 'ヘッド過熱',
  'Cancelled on printer': '本体でキャンセル',
  'Cover is open': 'カバーが開いています',
  'Low voltage': '電圧低下',
  'Cancelled by power off': '電源オフによるキャンセル',
  'Tape eject error': 'テープ排出エラー',
  'Tape feed error': 'テープ送りエラー',
  'Ink ribbon slack': 'インクリボンのたるみ',
  'Ink ribbon low': 'インクリボン残少',
  'Tape end': 'テープエンド',
  'Label cut error': 'ラベルカットエラー',
  'Temperature error': '温度エラー',
  'Missing parameter': 'パラメータ不足',
  'Half-cutter blade not installed': 'ハーフカッター刃が未装着',
  'Full-cutter blade not installed': 'フルカッター刃が未装着',
  'Half-cutter blade detached': 'ハーフカッター刃が外れています',
  'Full-cutter blade detached': 'フルカッター刃が外れています',
  'Winder cover open': '巻取りカバーオープン',
  'Vinyl tape temperature error': 'ビニルテープ温度エラー',
  'Winder error': '巻取りエラー',
  'Half cut / full cut': 'ハーフカット/全カット',
  'Big roll recognition error': 'ビッグロール認識異常',
  'Big roll not supported': 'ビッグロール非対応',
  'Stopped by auto power off': 'オートパワーオフで印刷停止',
  'Stopped by power source change': '電源変更で印刷停止',
  'Winder set': '巻取りセット',
  'Winder not set': '巻取り未セット',
  'Winder half cut / full cut': '巻取りハーフカット/全カット',

  // ---- job.js / joblist.js / backend.js / netlink.js / fonts.js ---------
  'No response from the printer. Check that it is powered on and that no other device (e.g. the phone app) is connected. Bluetooth SPP accepts only one connection at a time.':
    'プリンタから応答がありません。電源が入っているか、他の端末（スマホのアプリなど）が接続していないか確認してください。Bluetooth SPP は同時に 1 台としか繋がりません。',
  'Cancelled': 'キャンセルされました',
  'error code {code}': 'エラーコード {code}',
  'Printer error: {error}': 'プリンタエラー: {error}',
  'Resetting printer': 'プリンタをリセットしています',
  'State: {state}': '状態: {state}',
  'Sending job settings': 'ジョブ環境を送信',
  'Printing (set {copy}/{copies}, page {page}/{pages})': '印刷中 ({copy}/{copies} 部, ページ {page}/{pages})',
  'Finishing': '印刷終了処理',
  'Done. State: {state}': '完了。状態: {state}',
  'Did not receive the final status ({error})': '終了ステータスを受け取れませんでした ({error})',
  'Cleanup failed: {error}': '後始末に失敗しました: {error}',
  '(image only)': '(画像のみ)',
  '(empty label)': '(空のラベル)',
  'Not valid JSON': 'JSON として読めません',
  'Top level is not an object': '中身がオブジェクトではありません',
  'Unsupported format ({format})': '対応していない形式です ({format})',
  'unknown': '不明',
  'Missing items': 'items がありません',
  'The job has no items': '項目が 1 つもありません',
  'Too many items (max 500)': '項目が多すぎます (最大 500)',
  'Backend is not responding ({status})': 'バックエンドが応答しません ({status})',
  'Could not list devices': 'デバイス一覧を取得できません',
  'Lost the event stream from the backend (reconnecting)': 'バックエンドとのイベント接続が切れました（再接続します）',
  'Connection failed': '接続に失敗しました',
  'Send failed ({status})': '送信に失敗しました ({status})',
  'Status response timed out': 'ステータス応答がタイムアウトしました',
  'Could not save the printer': 'プリンタを保存できません',
  'Could not remove the printer': 'プリンタを削除できません',
  'Discovery failed': '検索に失敗しました',
  'No response': '応答がありません',
  "{error}. Check the printer's IP address, that it is on and on the same network.":
    '{error}。プリンタの IP アドレス、電源、同じネットワークにいるかを確認してください。',
  'Print failed ({status})': '印刷に失敗しました ({status})',
  'This browser does not support the Local Font Access API': 'このブラウザは Local Font Access API に対応していません',

  // ---- サーバーから届く進捗 (server/network.js) ---------------------------
  'Checking printer status': 'プリンタの状態を確認中',
  'Opening data connection': 'データ接続を開いています',
  'Data sent, printing': '送信完了、印刷中',
  'Sending data': 'データ送信中',
  'Done': '完了',
};

/** 文言に数値が埋め込まれていて、キーで引けないもの (サーバーの進捗など) */
const JA_PATTERNS = [
  [/^Printing \((\d+)\/(\d+)\)$/, '印刷中 ($1/$2)'],
];

/** data-i18n-html の段落 (英語は index.html にあるものを使う) */
const JA_HTML = {
  'net-help': 'プリンタの IP アドレスはルーターの DHCP クライアント一覧で確認できます（<em>ネットワークで探す</em> も試せます）。'
    + 'アドレスが変わらないよう DHCP の固定割り当てをしておくと便利です。',
  'bt-help': 'SR-R2500P / SR-MK1 / SR-R7900P 向けの Bluetooth Classic (RFCOMM) 直結です。'
    + 'あらかじめサーバーを動かしているコンピュータの OS 設定でプリンタとペアリングしてください。Docker の中では使えません。',
  'job-help': '版下をためて一括で印字します。テープ幅と機種は印刷時の設定で描き直すので、あとから変えられます。',
  footer: 'キングジム社とは無関係の非公式ツールです。'
    + '<a href="https://github.com/nikachu2012/tepra_web">nikachu2012/tepra_web</a> をもとに'
    + '（プロトコルの解析は <a href="PROTOCOL.md">PROTOCOL.md</a> を参照）、'
    + '<a href="https://github.com/takonomura/tepra-web">takonomura/tepra-web</a> と '
    + '<a href="https://github.com/hikalium/sr5900p">hikalium/sr5900p</a> の Wi-Fi プロトコルを取り入れています。',
};

const DICTIONARIES = { ja: JA };
const HTML_DICTIONARIES = { ja: JA_HTML };
const PATTERNS = { ja: JA_PATTERNS };

function isSupported(code) {
  return LANGUAGES.some((l) => l.code === code);
}

/**
 * ブラウザの言語設定から選ぶ。navigator.languages を優先順に見て、
 * 最初に対応しているものを使う (無ければ英語)。
 * @param {readonly string[]} [preferred]
 */
export function detectLanguage(preferred = globalThis.navigator?.languages
  ?? [globalThis.navigator?.language]) {
  for (const tag of preferred || []) {
    const base = String(tag || '').toLowerCase().split('-')[0];
    if (isSupported(base)) return base;
  }
  return 'en';
}

function storedLanguage() {
  try { return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null; } catch { return null; }
}

let current = (() => {
  const saved = storedLanguage();
  return isSupported(saved) ? saved : detectLanguage();
})();

export function getLanguage() {
  return current;
}

/**
 * @param {string} key 英語の文言。{name} は params で置き換える。
 * @param {Record<string, unknown>} [params]
 */
export function t(key, params) {
  let text = key;
  const dict = DICTIONARIES[current];
  if (dict) {
    if (Object.hasOwn(dict, key)) {
      text = dict[key];
    } else {
      for (const [re, replacement] of PATTERNS[current] || []) {
        if (re.test(key)) { text = key.replace(re, replacement); break; }
      }
    }
  }
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name) => (Object.hasOwn(params, name) ? String(params[name]) : m));
}

/** 両方の言語で同じものを指す文言か (既定の本文を差し替えるかの判定に使う) */
export function isTranslationOf(text, key) {
  return text === key || Object.values(DICTIONARIES).some((d) => d[key] === text);
}

const ATTRIBUTES = ['placeholder', 'title', 'aria-label'];
/** data-i18n-html の要素 → index.html にあった英語の HTML */
const originalHtml = new WeakMap();

/** index.html の data-i18n* が付いた要素をいまの言語にする */
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    if (!el.dataset.i18n) el.dataset.i18n = el.textContent.trim().replace(/\s+/g, ' ');
    el.textContent = t(el.dataset.i18n);
  }
  for (const attr of ATTRIBUTES) {
    const data = `data-i18n-${attr}`;
    for (const el of root.querySelectorAll(`[${data}]`)) {
      if (!el.getAttribute(data)) el.setAttribute(data, el.getAttribute(attr) || '');
      el.setAttribute(attr, t(el.getAttribute(data)));
    }
  }
  for (const el of root.querySelectorAll('[data-i18n-html]')) {
    if (!originalHtml.has(el)) originalHtml.set(el, el.innerHTML);
    // 訳文はこのファイルの定数だけなので innerHTML で入れてよい
    el.innerHTML = HTML_DICTIONARIES[current]?.[el.dataset.i18nHtml] ?? originalHtml.get(el);
  }
  if (root === document) document.documentElement.lang = current;
}

/**
 * JS から書き換える文言。キーを data-i18n に残すので、言語を切り替えても追従する。
 * @param {Element} el
 * @param {string} key
 */
export function setI18nText(el, key) {
  el.dataset.i18n = key;
  el.textContent = t(key);
}

/** 言語が変わったら呼ばれる */
export const languageEvents = new EventTarget();

export function setLanguage(code) {
  if (!isSupported(code) || code === current) return;
  current = code;
  try { globalThis.localStorage?.setItem(STORAGE_KEY, code); } catch { /* ignore */ }
  applyI18n();
  languageEvents.dispatchEvent(new Event('change'));
}

/** フッターの言語セレクタを用意する */
export function initLanguageSelect(select) {
  select.replaceChildren(...LANGUAGES.map(({ code, name }) => {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = name;
    option.lang = code;
    return option;
  }));
  select.value = current;
  select.addEventListener('change', () => setLanguage(select.value));
}
