// macOS 用 Bluetooth Classic (RFCOMM) ヘルパ。
//
// なぜ Node のネイティブアドオンではなく別プロセスなのか:
//   IOBluetooth の openRFCOMMChannelSync() は「CFRunLoop が回っているメインスレッド」
//   からしか成功しない。非メインスレッドから呼ぶと必ず kIOReturnError (0xE00002BC)
//   を返す。bluetooth-serial-port を含む既存の Node ライブラリは専用の
//   dispatch queue (= 非メインスレッド) で接続するため、macOS では繋がらない。
//   Node のメインスレッドは libuv のループを回していて CFRunLoop ではないので、
//   アドオンからこれを満たすのは難しい。そこで RunLoop.main を持つ小さな
//   プロセスに IOBluetooth を任せ、標準入出力でバイト列をやり取りする。
//
// 使い方:
//   tepra-bt list                     ペアリング済み端末と SDP サービスを JSON で出す
//   tepra-bt connect <addr> <channel> RFCOMM を開いて標準入出力で中継する
//
// connect のプロトコル:
//   stdin   4 バイト BE 長 + ペイロード … プリンタへ送る
//   stdout  4 バイト BE 長 + ペイロード … プリンタから受けた
//   stderr  1 行 1 JSON のイベント      … {"event":"open","ok":true,"mtu":660} など

import Foundation
import IOBluetooth

// ---- 標準入出力 ---------------------------------------------------------

let stdoutHandle = FileHandle.standardOutput
let stdinFD: Int32 = 0

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    FileHandle.standardError.write(line.data(using: .utf8)!)
}

func fail(_ message: String, code: Int32 = 1) -> Never {
    emit(["event": "error", "message": message])
    exit(code)
}

/// 4 バイト BE 長のフレームで stdout に流す
func writeFrame(_ bytes: [UInt8]) {
    var header = [UInt8](repeating: 0, count: 4)
    let n = UInt32(bytes.count)
    header[0] = UInt8((n >> 24) & 0xff)
    header[1] = UInt8((n >> 16) & 0xff)
    header[2] = UInt8((n >> 8) & 0xff)
    header[3] = UInt8(n & 0xff)
    stdoutHandle.write(Data(header))
    stdoutHandle.write(Data(bytes))
}

/// 指定バイト数を読み切る。EOF なら nil。
func readExactly(_ count: Int) -> [UInt8]? {
    var buffer = [UInt8](repeating: 0, count: count)
    var filled = 0
    while filled < count {
        let n = buffer[filled...].withUnsafeMutableBytes { raw -> Int in
            read(stdinFD, raw.baseAddress, count - filled)
        }
        if n <= 0 { return nil }
        filled += n
    }
    return buffer
}

// ---- list ---------------------------------------------------------------

/// SDP のサービスクラス UUID (属性 0x0001) を 16 進文字列で並べる
func serviceClasses(_ record: IOBluetoothSDPServiceRecord) -> [String] {
    guard let attrs = record.attributes as? [NSNumber: IOBluetoothSDPDataElement],
          let list = attrs[NSNumber(value: 1)] else { return [] }

    // ServiceClassIDList は要素が 1 つだと配列にならずに UUID が直接入る
    let items = (list.getArrayValue() as? [IOBluetoothSDPDataElement]) ?? [list]

    var out: [String] = []
    for item in items {
        guard let uuid = item.getUUIDValue() else { continue }
        // IOBluetoothSDPUUID は NSData のサブクラス。
        // 16/32/128bit いずれも 16 進文字列にして返す (0x1101 なら "1101")
        let bytes = [UInt8](Data(referencing: uuid))
        out.append(bytes.map { String(format: "%02x", $0) }.joined())
    }
    return out
}

func runList() {
    guard let devices = IOBluetoothDevice.pairedDevices() as? [IOBluetoothDevice] else {
        print("[]")
        return
    }

    var result: [[String: Any]] = []
    for device in devices {
        var services: [[String: Any]] = []
        for record in (device.services as? [IOBluetoothSDPServiceRecord]) ?? [] {
            var channelID: BluetoothRFCOMMChannelID = 0
            // 戻り値を見ないと RFCOMM を持たないレコードでゴミを拾う
            let hasChannel = record.getRFCOMMChannelID(&channelID) == kIOReturnSuccess
            var entry: [String: Any] = ["classes": serviceClasses(record)]
            if hasChannel { entry["channel"] = Int(channelID) }
            if let name = record.getServiceName() { entry["name"] = name }
            services.append(entry)
        }
        result.append([
            "address": device.addressString ?? "",
            "name": device.name ?? device.addressString ?? "",
            "connected": device.isConnected(),
            "services": services,
        ])
    }

    let data = try! JSONSerialization.data(withJSONObject: result)
    stdoutHandle.write(data)
    stdoutHandle.write("\n".data(using: .utf8)!)
}

// ---- connect ------------------------------------------------------------

final class Bridge: NSObject, IOBluetoothRFCOMMChannelDelegate {
    var channel: IOBluetoothRFCOMMChannel?
    var device: IOBluetoothDevice?
    private var closed = false

    func rfcommChannelData(_ rfcommChannel: IOBluetoothRFCOMMChannel!,
                           data dataPointer: UnsafeMutableRawPointer!,
                           length dataLength: Int) {
        guard dataLength > 0 else { return }
        let buffer = UnsafeRawBufferPointer(start: dataPointer, count: dataLength)
        writeFrame([UInt8](buffer))
    }

    func rfcommChannelClosed(_ rfcommChannel: IOBluetoothRFCOMMChannel!) {
        guard !closed else { return }
        closed = true
        emit(["event": "closed"])
        shutdown(0)
    }

    /// プリンタへ送る。MTU ごとに刻み、writeSync で送信完了まで待つ
    /// (writeAsync と違って実際に送り終わるまで返らないのでフロー制御になる)。
    func send(_ bytes: [UInt8]) {
        guard let channel = channel else { return }
        let mtu = Int(channel.getMTU())
        let chunkSize = mtu > 0 ? mtu : 320

        var payload = bytes
        let result: IOReturn = payload.withUnsafeMutableBufferPointer { buffer -> IOReturn in
            guard let base = buffer.baseAddress else { return kIOReturnSuccess }
            var offset = 0
            while offset < buffer.count {
                let size = min(chunkSize, buffer.count - offset)
                let r = channel.writeSync(base + offset, length: UInt16(size))
                if r != kIOReturnSuccess { return r }
                offset += size
            }
            return kIOReturnSuccess
        }

        if result != kIOReturnSuccess {
            emit(["event": "writeError", "code": Int(result)])
            shutdown(2)
        }
    }

    func shutdown(_ code: Int32) {
        if let channel = channel { channel.close() }
        if let device = device { device.closeConnection() }
        channel = nil
        device = nil
        exit(code)
    }
}

func runConnect(address: String, channelID: BluetoothRFCOMMChannelID) {
    guard let device = IOBluetoothDevice(addressString: address) else {
        fail("端末が見つかりません: \(address)")
    }

    // 古いベースバンドリンクが残っていると RFCOMM を開けないことがあるので張り直す
    device.closeConnection()
    Thread.sleep(forTimeInterval: 0.2)
    let aclResult = device.openConnection()
    if aclResult != kIOReturnSuccess {
        fail("Bluetooth リンクを張れません (code \(aclResult))。電源が入っているか確認してください。")
    }

    let bridge = Bridge()
    bridge.device = device

    var channel: IOBluetoothRFCOMMChannel?
    let result = device.openRFCOMMChannelSync(&channel, withChannelID: channelID, delegate: bridge)
    guard result == kIOReturnSuccess, let opened = channel else {
        device.closeConnection()
        fail("RFCOMM ch\(channelID) を開けません (code \(result))")
    }
    bridge.channel = opened

    emit(["event": "open", "ok": true, "channel": Int(channelID), "mtu": Int(opened.getMTU())])

    // stdin は別スレッドで読み、IOBluetooth の操作はメインスレッドへ回す。
    //
    // ここは async ではなく sync で回す。送信が終わるまで次のフレームを読まない
    // ことで stdin のパイプが埋まり、Node 側の write() が false を返す
    // = プリンタまでの背圧がそのまま呼び出し元に伝わる。async にすると
    // 詰まっている間も読み進めてしまい、フロー制御が効かない。
    let reader = Thread {
        while true {
            guard let header = readExactly(4) else { break }
            let length = (Int(header[0]) << 24) | (Int(header[1]) << 16)
                | (Int(header[2]) << 8) | Int(header[3])
            if length == 0 { continue }
            guard let payload = readExactly(length) else { break }
            DispatchQueue.main.sync { bridge.send(payload) }
        }
        // stdin が閉じた = 親が終わった
        DispatchQueue.main.async { bridge.shutdown(0) }
    }
    reader.stackSize = 512 * 1024
    reader.start()

    // メインスレッドで CFRunLoop を回す。IOBluetooth のコールバックはここに来る。
    RunLoop.main.run()
}

// ---- entry --------------------------------------------------------------

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    fail("usage: tepra-bt list | tepra-bt connect <address> <channel>")
}

switch arguments[1] {
case "list":
    runList()
case "connect":
    guard arguments.count >= 4, let channel = UInt8(arguments[3]) else {
        fail("usage: tepra-bt connect <address> <channel>")
    }
    runConnect(address: arguments[2], channelID: BluetoothRFCOMMChannelID(channel))
default:
    fail("unknown command: \(arguments[1])")
}
