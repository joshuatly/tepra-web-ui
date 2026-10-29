# TEPRA LINK 2 印字プロトコル解析メモ

解析対象: `TEPRA+LINK+2_1.3.0_APKPure.xapk`
(`jp.co.kingjim.android.tepra2` v1.3.0 / versionCode 61)

解析に使ったもの:

| 対象 | ツール | 得られたもの |
|---|---|---|
| `jp.co.kingjim.android.tepra2.apk` | apktool 3.0.2 / jadx | SDK の Java 層 (`jp.co.kingjim.tepraprint.sdk.*`) |
| `config.arm64_v8a.apk` → `lib/arm64-v8a/libTepraPrint.so` | radare2 | コマンド生成の実体 (`CommandFilter::*`) |
| `lib/arm64-v8a/libPrintCore.so` | nm | 画像2値化のみ。プロトコルは含まれない |

Java 層はトランスポートと手順、`libTepraPrint.so` はバイト列生成を持っている。以下は
両方を突き合わせて確定させた内容。

---

## 1. トランスポート

SDK は 4 系統の接続を持つ (`sdk/android/androidcore/`)。

| クラス | 経路 | 対象機種 (statusLength) |
|---|---|---|
| `DeviceConnectionBLE` | BLE / Dialog DSPS | statusLength == 22 の機種のみ |
| `DeviceConnectionBluetooth` | Bluetooth Classic SPP | statusLength 8 / 78 |
| `DeviceConnectionPort9100TCP/UDP` | TCP/UDP 9100 | 独自パケットヘッダで包む (`CommandFilter::makePacket`) |
| `DeviceConnectionWifiDirect` | Wi-Fi Direct | 同上 |

`makePacket(int type, unsigned char* out, ...)` @ 0x3e2fc は 16 バイトのヘッダを書く。
先頭 4 バイトは定数 0x1b758 = **`54 50 52 54` (`"TPRT"`)**、続いて 0 埋めと
`type` (1〜5 と 0xFF 超で分岐) が入る。中身の完全な解析はしていない。

本ツールが実装しているのは **`DeviceConnectionBluetooth` 相当の RFCOMM 直結のみ**
(バックエンドの Node から接続する)。BLE / TCP / Wi-Fi Direct は未実装なので、
`statusLength == 22` の SR-R5600 系 (BLE 専用機) には繋がらない。

### 1.0 SR-R2500P の SDP (実機で確認)

この機種は RFCOMM を 2 本出している。SPP でない方に繋ぐと接続できない。

| ch | ServiceClass | サービス名 | 用途 |
|---|---|---|---|
| 6 | `0x1101` SerialPort | `SerialPort` | **これがプリンタのデータ経路** |
| 1 | `00000000-decafade-decadeaf-decacaff` | `Wireless iAP` | Apple MFi。ホストからは繋げない |
| – | `0x1200` PnPInformation | – | RFCOMM チャネルを持たない |

チャネルの判定は ServiceClass UUID `0x1101` で行う。名前だけを見る実装や、
「最初に見つかった RFCOMM レコード」を採る実装 (`bluetooth-serial-port` の
`findSerialPortChannel()` は RFCOMM プロトコル UUID `0x0003` で引く) は
ch1 の iAP を掴んでしまう。

### 1.0.1 macOS で RFCOMM を開く際の制約

`IOBluetoothDevice.openRFCOMMChannelSync()` は **CFRunLoop が回っている
メインスレッド** からしか成功しない。非メインスレッド (dispatch queue や
`Thread`) から呼ぶと、リンクが張れていても必ず `kIOReturnError`
(`0xE00002BC`) を返す。実測:

| 呼び出し元 | 結果 |
|---|---|
| メインスレッド | 成功 |
| `dispatch_sync` (メインスレッドから = 呼び出し元スレッドで実行) | 成功 |
| `dispatch_sync` (バックグラウンドスレッドから) | `kIOReturnError` |
| `Thread` (ランループなし) | `kIOReturnError` |

また、電源が落ちた後もホスト側にリンクが残ることがあり、その状態では
`openRFCOMMChannelSync()` が失敗し続ける。接続前に `closeConnection()` →
`openConnection()` でベースバンドリンクを張り直すと安定する。

### 1.1 GATT (Dialog Semiconductor DSPS プロファイル)

`DeviceManagerBLE$Uuid` より:

```
DSPS_SERVICE        0783b03e-8535-b5a0-7140-a304d2495cb7
TX_CHARACTERISTIC   0783b03e-8535-b5a0-7140-a304d2495cb8   notify  (プリンタ → ホスト)
FLOW_CONTROL        0783b03e-8535-b5a0-7140-a304d2495cb9   notify + write
RX_CHARACTERISTIC   0783b03e-8535-b5a0-7140-a304d2495cba   write   (ホスト → プリンタ)
CCCD                00002902-0000-1000-8000-00805f9b34fb
```

接続手順 (`DeviceManagerBLE.onServicesDiscovered` / `onDeviceReady`):

1. サービス探索 → TX / FC の CCCD に notify を有効化
2. MTU 247 を要求 → チャンクサイズ = `MTU - 3` = 244 バイト
3. 準備完了後、FC characteristic に `0x01` を write (フロー制御 ON)
4. データは RX へ `WRITE_TYPE_NO_RESPONSE` で 244 バイトずつ
5. FC の notify が `0x02` = 送信停止、`0x01` = 送信再開

BLE スキャンは DSPS サービス UUID でフィルタし、アドバタイズ名に機種名
(`SR-R5600P` など) が含まれるものを採用している。

### 1.2 ステータス応答フレーム

`AccessManagerBLE.getPrinterStatusSub()`:

- `0x40` (`'@'`) で始まる **36 バイト** 固定長
- 先頭 13 バイトがプレフィクス、その後ろが 22 バイトのステータスブロック

`AccessManagerBLE.parseStatusFromLwStatus()` (statusLength == 22) の割り付け。
`b[i]` はフレーム先頭から 13 バイト目を 0 とするオフセット:

| off | キー | 意味 |
|---|---|---|
| 1 | ST | プリンタ状態 |
| 2 | ER | エラー |
| 4 | EI2 | エラー詳細 |
| 5 | EJ2 | エラー詳細2 |
| 6 | TW | テープ幅コード (生値) |
| 7 | TR | テープ種別 |
| 8 | TS | テープスイッチ |
| 9,10,11 | T8S, T8O, T8T | 8bit テープ情報 |
| 12–13 | PP | 印刷ページ数 (BE16) |
| 14–17 | RB | 受信バッファ残 (BE32) |
| 18 | WA | 警告 |
| 19 | VER | バージョン |
| 20–21 | RES | 予約 |

### 1.3 ステータス長ごとのフォーマット

`statusLength` は機種ごとに決まっていて (§7 の表)、フレーム全長も本体のレイアウトも変わる。
フレーム先頭は共通で 13 バイトのプレフィクス。

| statusLength | フレーム全長 | 解析元 | 機種 |
|---|---|---|---|
| 8 (バイナリ) | 21 | `AccessManager` | port9100 の第一世代 |
| 8 (ASCII) | 64 | `AccessManagerBluetooth` | SR5500P の Bluetooth Classic |
| 12 | 25 | `AccessManager` | – |
| 20 | 33 | `AccessManager` | SR5900P / SR5900C / SR5900GS |
| 22 | **36** | `AccessManagerBLE` | SR-R5600P / C / GS (BLE) |
| 24 | 37 | `AccessManager` | – |
| 78 | **92** | `AccessManagerBluetooth2` | SR-MK1 / SR-R2500P / SR-R7900P |

22 と 78 は本体の後ろに 1 バイト余分が付く (13 + n + 1)。
78 は `AccessManagerBluetooth2` が「合計 91 バイト以上たまるまで待つ」実装なので
アプリ側は余りを気にしていないが、**SR-R2500P の実機は一貫して 92 バイトを返す**。

```
40 42 44 43 20 53 54 32 0d 0a 50 00 3b | 4e 00 00 03 … 00 | 8c
'@' 'B' 'D' 'C' ' ' 'S' 'T' '2' CR LF   |  78 バイトの本体   | 末尾 1 バイト
└───────── プレフィクス 13 バイト ─────┘
```

末尾の 1 バイトはチェックサムらしい。ストリームから切り出すときは 92 バイト
消費しないと 1 バイトずつ残って後続のフレームがずれるので、本ツールは 92 で扱う。

ASCII 形式 (第一世代 Bluetooth) は 64 バイトで末尾が `0xFF`、中身は
`ST:02;ER:00;TW:03;…` のようなテキストで、`parseStatusCode()` がキーの 3 文字後ろから
16 進 2 桁を読む。

78 バイト版のレイアウト (プレフィクス 13 バイトを除いた `b[i]`):

| off | キー | | off | キー |
|---|---|---|---|---|
| 1 | ST | | 25–28 | RB (BE32) |
| 2 | ER / ER2 | | 29 | WA |
| 3 | TW | | 30–31 | PPN (BE16) |
| 4 | TR | | 32 | TWS 巻取り |
| 5 | EI | | 33 | BR ビッグロール |
| 8 | TO | | 34–37 | BTLM テープ長 mm |
| 9 | IR | | 38–41 | BTLI テープ長 inch |
| 10 | RR | | 42–45 | BTUL 使用長 mm |
| 11 | EJ | | 46–47 | BLT ラベル総数 |
| 12–13 | PP (BE16) | | 48–49 | BLC ラベル数 |
| 14 | ER2 | | 50–53 | BTR テープ色 RGBA |
| 15 | EI2 | | 54–57 | BRR リボン色 RGBA |
| 16 | EJ2 | | 58 | BTW テープ幅 |
| 17 | TC テープ色 | | 59–60 | BTK テープ種別 |
| 18 | RC リボン色 | | 61 | BPS 速度 |
| 19 | JI ジョブID | | 62 | BO オプション |
| 20 | TS | | 63 | BPD 濃度 |
| 21–23 | T8S/T8O/T8T | | 64 | BHD ハーフカット深さ |
| 24 | T8B | | 65 | RES3 |
|  |  | | 66–77 | BSN シリアル 12 バイト |

ST の値 (`PrintCoreStatus`): 0=Idle, 1=Feeding, 2=Printing, 3=DataSending,
4=FeedEnd, 5=PrintEnd, 16=DemoPrinting, 17=DeviceFeeding, 18=DevicePrinting,
19=FirmwareUpdating, 32=SmallRollWaiting, 34=WaitingForTapeRemoval, 255=Error

ER の値 (`PrintCoreDeviceStatus`): 0=正常, 1=カッターエラー, 6=テープカートリッジなし,
21=ヘッド過熱, 32=本体キャンセル, 33=カバーオープン, 34=電圧低下, 35=電源オフ,
36=テープ排出エラー, 48=テープ送りエラー, 64=リボンたるみ, 65=リボン残少,
66=テープエンド, 67=ラベルカットエラー, 68=温度エラー, 69=パラメータ不足 …

---

## 2. コマンドフレーム

`CommandFilter::makeCommand(char* out, unsigned char cmd, unsigned long param)`
(`libTepraPrint.so` @ 0x3c878) が生成する共通フレーム:

```
1B 7B <len> <cmd> <params...> <chk> 7D
      ESC  {                          }

len = <cmd> 以降 <7D> までのバイト数 = 1 + params.length + 2
chk = (cmd + Σparams) & 0xFF
```

`makeCommand` は cmd を `'!'`(0x21) 〜 `'{'`(0x7B) の 91 分岐スイッチで処理する。
確認できたコマンド:

| cmd | フレーム | 意味 |
|---|---|---|
| `!` 0x21 | `1B 7B 03 21 21 7D` | プリンタリセット |
| `+` 0x2B | `1B 7B 04 2B v chk 7D` | テープ送り (v=0) / 送り+カット (v=1) |
| `@` 0x40 | `1B 7B 03 40 40 7D` | ジョブ初期化 / 印刷終了 |
| `C` 0x43 | `1B 7B 07 43 c0 c1 c2 c3 chk 7D` | カット設定 (LE32) |
| `D` 0x44 | `1B 7B 04 44 v chk 7D` | 濃度。`v = clamp(density + 5, 0..10)`、範囲外は 0 |
| `G` 0x47 | `1B 7B 03 47 47 7D` | ジョブ環境終端 |
| `H` 0x48 | `1B 7B 04 48 05 4D 7D` | 画像処理モード (commandLevel 3/4/7 で固定値 5) |
| `I` 0x49 | `1B 7B 05 49 a b chk 7D` | ステータス要求 |
| `L` 0x4C | `1B 7B 07 4C l0 l1 l2 l3 chk 7D` | ページ長 (印字方向のドット数, LE32) |
| `T` 0x54 | `1B 7B 05 54 m0 m1 chk 7D` | 先頭余白ドット数 (LE16) |
| `W` 0x57 | `1B 7B 05 57 w0 w1 chk 7D` | 画像幅 (commandLevel 2 のみ) |
| `X` 0x58 | `1B 7B 04 58 v chk 7D` | 連続ハーフカット (`ParameterKeyHalfCutContinuous`) |
| `o` 0x6F | `1B 7B 05 6F v 00 chk 7D` | オブジェクト種別 (`ParameterKeyObjectType`, commandLevel 4) |
| `s` 0x73 | `1B 7B 04 73 v chk 7D` | 印字速度 |
| `y` 0x79 | `1B 7B 03 79 79 7D` | 優先印字設定 |
| `{` 0x7B | `1B 7B 07 7B 00 00 53 54 22 7D` | ジョブ開始 (固定) |

### 2.1 `C` (カット設定) の 4 バイト値

`makeCommand` の 'C' 分岐 (0x3cc08〜) を追うと、`ParameterKeyTapeCut` と
`ParameterKeyHalfCut` から LE32 値を組み立てている:

```
base = TapeCut==0 (毎ラベル)  ? (HalfCut==1 ? 0x01010200 : 0x01010100)
     : TapeCut==1 (ジョブ後)  ? 0x01010000
     : TapeCut==2 (カットなし)? 0x00000000
     :                          0x01000000

HalfCut==1 かつ TapeCut!=2 → value = base | 2
HalfCut==0 かつ TapeCut!=2 → value = base | 1
それ以外                    → value = base
```

実際に出てくる組み合わせ:

| TapeCut | HalfCut | LE32 | 送出バイト |
|---|---|---|---|
| 0 毎ラベル | 0 | `0x01010101` | `1B 7B 07 43 01 01 01 01 47 7D` |
| 0 毎ラベル | 1 | `0x01010202` | `1B 7B 07 43 02 02 01 01 49 7D` |
| 1 ジョブ後 | 0 | `0x01010001` | `1B 7B 07 43 01 00 01 01 46 7D` |
| 1 ジョブ後 | 1 | `0x01010002` | `1B 7B 07 43 02 00 01 01 47 7D` |
| 2 カットなし | – | `0x00000000` | `1B 7B 07 43 00 00 00 00 43 7D` |

### 2.2 `s` (印字速度)

`ParameterKeyPrintSpeed` (0=高速, 1=低速, 2=中速) を見て

```
speed==1                 → 1
arg フラグあり && speed==2 → 2
それ以外                  → 0
```

arg フラグは `makeCommand` の第 3 引数で、`makePageEnvironmentCommand` が
commandLevel ごとに固定値を渡している。**level 3 は 0、level 4/6/7/8 は 1**。
つまり中速を選べるのは level 4 以降だけ。

### 2.3 `X` (連続ハーフカット)

`makeCommand` の 'X' 分岐 @ 0x3cb18。ジャンプテーブル (0x1cc9c, `cmd - 0x21` で引く
u16 × 91 エントリ) の index 55 がここを指す。

```
1B 7B 04 58 v chk 7D
v   = (ParameterKeyHalfCutContinuous == 1) ? 1 : 0
chk = (0x58 + v) & 0xFF
```

| 設定 | 送出バイト |
|---|---|
| OFF | `1B 7B 04 58 00 58 7D` |
| ON  | `1B 7B 04 58 01 59 7D` |

**`makeCommand` の第 3 引数 (param) は使っていない。** 'X' 分岐は引数を無視して
パラメータ表から `ParameterKeyHalfCutContinuous` を引き直す。実際
`makePageEnvironmentCommand` 内の 4 か所すべてが `param = 0` (`mov x3, xzr`) で
呼んでいる。

---

## 3. ジョブ環境コマンド

`CommandFilter::makeJobEnvironmentCommand(char*)` @ 0x3c800 は固定 16 バイト +
`C` + `D` + 固定 6 バイトを連結する:

```
1B 7B 03 40 40 7D                  '@'  初期化
1B 7B 07 7B 00 00 53 54 22 7D      '{'  ジョブ開始 ("ST")
<C コマンド>                        カット設定
<D コマンド>                        濃度
1B 7B 03 47 47 7D                  'G'
```

## 4. ページ環境コマンド

`CommandFilter::makePageEnvironmentCommand(char*, int pageLength, int imageWidth,
int margin, int commandLevel)` @ 0x3d858。先頭 18 バイトは commandLevel 非依存:

```
1B 7B 07 4C <pageLength LE32> chk 7D     'L'
1B 7B 05 54 <margin LE16>     chk 7D     'T'
```

その後 commandLevel で分岐する:

| level | 追加分 | 機種 |
|---|---|---|
| 1 | なし | SR5500P |
| 2 | `W`(imageWidth) + `O` + `t` | – |
| 3 | `H`(5) + `s` + `X` | SR5900P / SR5900C / SR5900GS |
| 4 | `H`(5) + `s` + `X` + `y`? + `o`(ObjectType) | SR-R7900P |
| 5 | `y`? のみ | **SR-R2500P / SR-MK1 / SR-R5600P / SR-R5600C / SR-R5600GS** |
| 6 | `s` + `X` + `y`? | – |
| 7 | `H`(5) + `s` + `X` + `y`? | – |
| 8 | `s` | – |

`y`? は `ParameterKeyPriorityPrintSetting == 1` のときだけ付く
(`1B 7B 03 79 79 7D`、定数 0x1b720)。

各 level の分岐アドレスと、逆アセンブルで確認した並び:

| level | 分岐 | 並び |
|---|---|---|
| 3 | 0x3df3c | `H`(5) → `s`(arg=0) → `X` |
| 4 | 0x3da40 | `H`(5) → `s`(arg=1) → `X` → `y`? → `o` |
| 6 | 0x3d928 | `s`(arg=1) → `X` → `y`? |

`H` は 4 バイト定数 0x1b760 (`1B 7B 04 48`) + `05 4D 7D` を直接書き込んでいて、
`makeCommand` を経由しない。

**`X` を解読したので level 1/3/4/5/6/7/8 はすべて組み立てられる** (本ツール実装済み)。
残るのは level 2 の `W` + `O` + `t` だけだが、該当する機種がテーブルに無い。

## 5. ラスタデータ

`PrintController.executePrint()`:

- 1 ラスタ行ごとに `makeRasterCommand(width)` = `1B 2E 00 00 00 01 nL nH`
  (`ESC . c=0 v=0 h=0 m=1 nL nH`、n = テープ幅方向のドット数) を書き、
  直後に `ceil(width/8)` バイトのビットマップを続ける
- 1024 行ずつまとめて送信し、バンドごとにステータスを確認する
- ページ末尾に `0x0C` (FF)

### 5.1 ビットパック

`CommandFilter::bitmapToRaster(int width, int height, const uint8_t* gray, uint8_t* dst)`
@ 0x3e170:

```
グレースケール値 < 0x8C (140) なら黒 (ビット 1)
先頭ピクセルが MSB (bit7)、以降 bit6, bit5 … と MSB ファースト
```

グレースケール化は `PrintController.getImageData()` 側:
`Y = R*0.299 + G*0.587 + B*0.114` (切り捨て)。

### 5.2 座標系

`getImageData()` は元ビットマップ (幅 = ラベルの長さ方向, 高さ = テープ幅方向) を
`Matrix.postRotate(90)` + `postTranslate(imageWidth, -startRow)` して読み出す。
つまり:

```
ラベル座標 (x = 長さ方向, y = テープ幅方向・上が 0)
        ↓
ラスタ行番号 = x
行内の位置  = imageWidth - y     ← テープ幅方向は反転する
```

- `PrintController.getImageHeight()` = `getContentWidthForPage()` = **ラベル長 (ドット)** → `L` コマンド
- `PrintController.getImageWidth()` = `getContentHeightForPage()` = **テープ幅方向のドット数** → ラスタ 1 行の幅
- `getContentMarginForPage()` = `margin_mm / 25.4 * resolution` (ラベル長を超えない) → `T` コマンド

---

## 6. 印刷シーケンス (BLE)

`PrintController.executePrint()` と `AccessManagerBluetooth2` から:

```
1.  1B 7B 03 21 21 7D              リセット
2.  1B 7B 05 49 05 00 4E 7D        ステータス自動通知 ON  (setRequestStatus)
3.  ステータス受信を待つ           ST が Idle であること
4.  <ジョブ環境コマンド>
5.  1B 7B 05 49 05 00 4E 7D        再度ステータス要求
6.  ページごと:
      <ページ環境コマンド>
      1024 行ずつ:
        (1B 2E 00 00 00 01 nL nH + ラスタ) × 行数
        ステータス確認
      0C                            FF (ページ終了)
7.  1B 7B 03 40 40 7D              印刷終了
8.  ステータス受信を待つ
```

単発ステータス要求は `1B 7B 05 49 00 00 49 7D`。
Bluetooth Classic 第一世代機は `I`(0x49) ではなく `Q`(0x51) を使う。

テープ送り / カットは、上記 1〜3 のあとに
`1B 7B 04 2B 00 2B 7D` (送り) または `1B 7B 04 2B 01 2C 7D` (送り+カット)。

---

## 7. 機種テーブル

`TepraPrintProductInformation` より。

| 機種名 (USBMDL) | 解像度 | statusLength | commandLevel | ハーフカット | 低速 | modelNumber |
|---|---|---|---|---|---|---|
| TEPRA PRO SR5900P | 360 | 20 | 3 | ○ | ○ | 4 |
| SR5500P | 180 | 8 | 1 | × | × | 5 |
| SR-R5600P | 180 | **22** | 5 | × | × | 18 |
| SR-R5600C | 180 | **22** | 5 | × | × | 19 |
| SR-R5600GS | 180 | **22** | 5 | × | × | 20 |
| TEPRA PRO SR-R7900P | 300 | 78 | 4 | ○ | ○ | 6 |
| SR-MK1 | 360 | 78 | 5 | × | × | 7 |
| SR-R2500P | 180 | 78 | 5 | × | × | 8 |
| TEPRA PRO SR5900C | 360 | 20 | 3 | ○ | ○ | 16 |
| TEPRA PRO SR5900GS | 360 | 20 | 3 | ○ | ○ | 17 |

statusLength == 22 の 3 機種だけが `DeviceConnectionBLE` を通る (それ以外は
コンストラクタでエラーログを出す)。

### 7.1 印字可能ドット数 `PrintableSizeTable`

行 = テープ幅コード、列 = 解像度 [180, 270, 360, 300] dpi。

| コード | 幅 | 180 | 270 | 360 | 300 |
|---|---|---|---|---|---|
| 1 | 4mm | 22 | 33 | 44 | 36 |
| 2 | 6mm | 36 | 54 | 72 | 60 |
| 3 | 9mm | 54 | 81 | 108 | 90 |
| 4 | 12mm | 72 | 108 | 144 | 120 |
| 5 | 18mm | 108 | 162 | 216 | 180 |
| 6 | 24mm | 128 | 192 | 288 | 238 |
| 7 | 36mm | 192 | 288 | 384 | 361 |
| 10 | 50mm | 297 | 446 | 595 | 496 |
| 11 | 100mm | 652 | 979 | 1305 | 1088 |
| 12 | 50mm(新) | 297 | 446 | 595 | 566 |

例外 (`getPrintableSize`): modelNumber 1300/8 かつ 18mm → 96、
modelNumber 7 (SR-MK1) かつ 24mm → 256。

### 7.2 ステータスの TW コード → テープ幅コード

`CommandFilter::tapeWidthFromLWStatusTWCode` @ 0x3f2a0:

| TW 生値 | 幅 | | TW 生値 | 幅 |
|---|---|---|---|---|
| 0x01 / 0x51 | 6mm | | 0x07 / 0x57 | 50mm(新) |
| 0x02 / 0x52 | 9mm | | 0x0B / 0x5B | 4mm |
| 0x03 / 0x53 | 12mm | | 0x11 | 24mm ケーブル |
| 0x04 / 0x54 | 18mm | | 0x12 | 36mm ケーブル |
| 0x05 / 0x55 | 24mm | | 0x21 | 50mm |
| 0x06 / 0x56 | 36mm | | 0x23 | 100mm |

0x00 は「テープなし」、その他は不明 (-1)。
