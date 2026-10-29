// 印刷ジョブの実行順序。PrintController.executePrint() / doTapeFeed() 相当。

import {
  cmdReset, cmdRequestStatusAuto, cmdRequestStatusOnce, cmdPrintEnd, cmdFormFeed,
  cmdTapeFeed, cmdTapeFeedAndCut, jobEnvironmentCommand, pageEnvironmentCommand,
  rasterBlock,
} from './protocol.js';
import { DEVICE_ERROR, PRINTER_STATUS } from './models.js';

/** PrintController.PRINT_CONTROLLER_BANDING_SIZE */
export const BANDING_SIZE = 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const NO_RESPONSE_HINT =
  'No response from the printer. '
  + 'Check that it is powered on and that no other device (e.g. the phone app) is connected. '
  + 'Bluetooth SPP accepts only one connection at a time.';

export class PrintAborted extends Error {
  constructor(message) { super(message); this.name = 'PrintAborted'; }
}

export class PrintJob {
  constructor(ble) {
    this.ble = ble;
    this.cancelRequested = false;
  }

  cancel() { this.cancelRequested = true; }

  _checkCancel() {
    if (this.cancelRequested) throw new PrintAborted('Cancelled');
  }

  _checkStatus(status) {
    if (!status) return;
    if (status.ER !== 0) {
      const name = DEVICE_ERROR[status.ER] || `error code ${status.ER}`;
      throw new Error(`Printer error: ${name}`);
    }
  }

  /**
   * @param {{lengthDots:number,widthDots:number,marginDots:number,rows:Uint8Array[]}[]} pages
   * @param {{copies:number,tapeCut:number,halfCut:number,density:number,priorityPrint:boolean}} opts
   * @param {(p:{phase:string,done:number,total:number})=>void} [onProgress]
   */
  async run(pages, opts, onProgress = () => {}) {
    try {
      await this._run(pages, opts, onProgress);
    } finally {
      // PrintController.done() と同じく、成否にかかわらず自動通知を OFF に戻す
      await endSession(this.ble);
    }
  }

  async _run(pages, opts, onProgress) {
    const ble = this.ble;
    const totalRows = pages.reduce((n, p) => n + p.rows.length, 0) * opts.copies;
    let doneRows = 0;

    ble.log('Resetting printer');
    await ble.send(cmdReset());
    await sleep(200);

    this._checkCancel();
    await ble.send(cmdRequestStatusAuto());
    let first;
    try {
      first = await ble.waitStatus(15000);
    } catch (err) {
      throw /timed out/.test(err.message) ? new Error(NO_RESPONSE_HINT) : err;
    }
    ble.log(`State: ${PRINTER_STATUS[first.ST] ?? first.ST}`);
    this._checkStatus(first);

    onProgress({ phase: 'Sending job settings', done: 0, total: totalRows });
    await ble.send(jobEnvironmentCommand(opts));
    await ble.send(cmdRequestStatusAuto());
    this._checkStatus(await ble.waitStatus(15000));

    for (let copy = 0; copy < opts.copies; copy++) {
      for (let pi = 0; pi < pages.length; pi++) {
        this._checkCancel();
        const page = pages[pi];
        await ble.send(pageEnvironmentCommand(page.lengthDots, page.marginDots, opts));

        for (let start = 0; start < page.rows.length; start += BANDING_SIZE) {
          this._checkCancel();
          const band = page.rows.slice(start, start + BANDING_SIZE);
          await ble.send(rasterBlock(band, page.widthDots));
          doneRows += band.length;
          onProgress({
            phase: `Printing (set ${copy + 1}/${opts.copies}, page ${pi + 1}/${pages.length})`,
            done: doneRows,
            total: totalRows,
          });
          // PrintController は各バンドの後にステータスを確認している
          try {
            this._checkStatus(await ble.waitStatus(60000));
          } catch (e) {
            if (e instanceof PrintAborted) throw e;
            if (!/timed out/.test(e.message)) throw e;
          }
        }

        await ble.send(cmdFormFeed());
      }
    }

    onProgress({ phase: 'Finishing', done: totalRows, total: totalRows });
    await ble.send(cmdPrintEnd());
    try {
      const last = await ble.waitStatus(60000);
      this._checkStatus(last);
      ble.log(`Done. State: ${PRINTER_STATUS[last.ST] ?? last.ST}`, 'ok');
    } catch (e) {
      ble.log(`Did not receive the final status (${e.message})`, 'warn');
    }
  }
}

/**
 * セッションの後始末。AccessManager*.resetRequestStatus() 相当。
 *
 * 印刷中は `I 05 00` で自動ステータス通知を ON にしているので、
 * 切断前に `I 00 00` を送って OFF に戻し、応答を 1 つ読み捨てる。
 * PrintController.done() が必ずこれをやっている。これを省くとプリンタが
 * 通知モードのまま残り、次の接続でステータスが取れなくなる。
 */
export async function endSession(ble, waitMs = 2000) {
  if (!ble || !ble.connected) return;
  try {
    await ble.send(cmdRequestStatusOnce());
    await ble.waitStatus(waitMs).catch(() => {});
  } catch (err) {
    ble.log(`Cleanup failed: ${err.message}`, 'warn');
  }
}

/** テープ送り / テープ送り+カット (PrintController.doTapeFeed) */
export async function tapeFeed(ble, withCut) {
  try {
    await ble.send(cmdReset());
    await sleep(200);
    await ble.send(cmdRequestStatusAuto());
    await ble.waitStatus(15000);
    await ble.send(withCut ? cmdTapeFeedAndCut() : cmdTapeFeed());
    try {
      await ble.waitStatus(30000);
    } catch {
      /* 応答が来なくても致命的ではない */
    }
  } finally {
    await endSession(ble);
  }
}

/** 単発のステータス取得 */
export async function fetchStatus(ble) {
  await ble.send(cmdRequestStatusOnce());
  try {
    return await ble.waitStatus(10000);
  } catch (err) {
    if (/timed out/.test(err.message)) throw new Error(NO_RESPONSE_HINT);
    throw err;
  }
}
