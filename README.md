# TEPRA Web

A self-hosted web page for printing labels on KING JIM **TEPRA PRO** label printers from any
browser on your home network. It's built mainly for the **SR5900P** (Wi-Fi / LAN), and it keeps
Bluetooth support for the SR-R2500P, SR-MK1 and SR-R7900P.

```
  Phone / laptop browser  ──HTTP──▶  TEPRA Web server (Docker)  ──UDP+TCP 9100──▶  SR5900P
  (label editor, preview,            (print sessions, status,
   raster + command bytes)            saved printers, image API)
```

The browser renders the label, turns it into 1-bit raster rows and builds the printer command
stream. The server opens the print session with the printer and streams the job to it.

> **Scope:** this fork is mainly about getting **Wi-Fi / LAN printing** working on the SR5900P
> family. The Bluetooth path comes unchanged from
> [nikachu2012/tepra_web](https://github.com/nikachu2012/tepra_web), and I don't have a
> Bluetooth TEPRA to test it with, so treat it as untested here. Reports and fixes are welcome.

## Features

- Label editor: multi-line text, any installed font (Chrome/Edge), bold/italic, alignment,
  border, images (with optional dithering), automatic or fixed label length
- **Sections:** put `---` on a line of its own to start a new section. Sections sit side by side
  along the label, and each one sizes its own lines to fill the tape, so a 1-line section gets big
  text next to a 3-line one. Optional divider lines between them. With a fixed label length the
  text shrinks to fit.
- **Icons inside the text:** about 6,000 icons from [Tabler Icons](https://tabler.io/icons),
  [Maki](https://github.com/mapbox/maki) and [Phosphor](https://phosphoricons.com), with search in
  English and Japanese and the TEPRA LINK 2 tabs (Work, Life, Mark, Play, Vehicle, Food, Living
  things, Sign). An icon is written as `[tabler:plug]` in the text and drawn at the size of the
  text around it.
- Live preview of both the design and the actual printed dots
- **Wi-Fi / LAN printing for SR5900P / SR5900C / SR5900GS** (no driver, no Windows PC)
- Reads the loaded tape from the printer and **sets the tape width to match**. The server also
  refuses a job laid out for a different tape, so you don't waste a cartridge.
- Live printer status: state, errors (cover open, tape end, …) and the loaded tape
- Copies, cut after each label / after the job / no cut, half cut, density
- Batch jobs: queue several different labels and print them in one go; save/load as JSON
- Saved printers (kept in a Docker volume), optional pre-configuration via environment variable
- LAN discovery (UDP broadcast)
- Works on phones: responsive layout with a sticky print bar
- English and Japanese UI: follows the browser's language, with a switcher in the page footer
- `POST /api/print/image`: print a PNG from scripts or home automation, no browser needed
- Bluetooth Classic (RFCOMM) for SR-R2500P / SR-MK1 / SR-R7900P when you run the server
  natively (not in Docker)

## Run it in Portainer

1. **Stacks → Add stack**
2. **Repository**: point it at this Git repository, compose path `docker-compose.yml`
   (Portainer builds the image). No prebuilt image is published.
3. Optionally set `TEPRA_PRINTERS` (see below) so the printer is already there on first load.
4. Deploy, then open `http://<docker-host>:8765/`.

The stack uses `network_mode: host`. This lets *Find on network* broadcast to the printer, and
nothing sits between the container and the printer's UDP replies. If you have to use bridge
networking, publish `8765:8765` and enter the printer's IP by hand. Unicast UDP/TCP to the
printer still works through Docker's NAT.

Plain Docker:

```bash
docker compose up -d --build
```

Without Docker (Node 18+, no npm packages needed for Wi-Fi):

```bash
HOST=0.0.0.0 npm start
```

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8765` | HTTP port |
| `HOST` | `0.0.0.0` in Docker, `127.0.0.1` otherwise | Listen address |
| `DATA_DIR` | `/data` in Docker, `./data` otherwise | Where `printers.json` is stored |
| `TEPRA_PRINTERS` | – | Pre-configured printers, comma-separated `Name=IP[:port][@model]`, e.g. `Label printer=192.168.1.50` or `192.168.1.50,Garage=192.168.1.51@SR5900C` |
| `TEPRA_BLUETOOTH` | `0` in Docker | Set to `0` to turn off the Bluetooth bridge |

The server has **no authentication**. Keep it on your home network; don't forward it to the
internet. Put a reverse proxy with auth in front if you need access from outside.

## Printer setup (SR5900P)

1. Connect the SR5900P to your Wi-Fi or LAN (with the printer's own setup tool or front panel).
2. Find its IP address in your router's DHCP client list, or click **Find on network**.
3. Give it a **DHCP reservation** so the IP never changes.
4. In TEPRA Web: **Printer → Wi-Fi / LAN**, type the IP, then **Connect**. The printer is saved.
   Model and tape width are set automatically.

The server needs to reach the printer on **UDP 9100** (control and status) and **TCP 9100** (print
data). If the printer is on a separate VLAN or IoT network, allow both ports from the Docker host.

### Using it

1. Type your text (one row per line) and adjust font, size and alignment. The preview updates live.
2. Check the **Tape width**. It follows the cartridge in the printer while
   *Match the tape loaded in the printer automatically* is ticked.
3. Press **Print**. The progress bar follows the job until the printer reports it has finished.

To print several different labels, use **Batch job → Add current label** for each, then
**Print batch**.

## Image print API

```bash
curl --data-binary @label.png -H 'Content-Type: image/png' \
  'http://docker-host:8765/api/print/image?printer=192.168.1.50&copies=2&cut=each'
```

The image's height goes across the tape. Taller images are scaled down to fit the tape; shorter
ones are centred. Query parameters:

| Param | Values |
|---|---|
| `printer` | saved printer id, name or IP (optional when only one printer is configured) |
| `copies` | 1–99 |
| `cut` | `each` (default), `end`, `none` |
| `halfcut` | `0` / `1` |
| `density` | -5…5 |
| `tape` | tape code (`1`=4mm `2`=6mm `3`=9mm `4`=12mm `5`=18mm `6`=24mm `7`=36mm); default: the loaded tape |
| `fit` | `contain` (default) or `fill` (scale up to the full tape height) |
| `rotate` | `1` rotates the image 90° |
| `invert` | `1` for white-on-black |
| `padding`, `margin` | mm of padding at both ends / leading tape margin |

Other endpoints: `GET /api/net/status?printer=…`, `GET /api/net/discover`, `GET /api/printers`,
`GET /healthz`.

## Testing without the printer

`test/fake-sr5900p.mjs` emulates an SR5900P (UDP control protocol and TCP job intake). It
validates every frame and checksum, and can write each printed label as an image:

```bash
npm run fake-printer -- --port 19100 --tape 5 --dump ./fake-out
TEPRA_PRINTERS="Fake=127.0.0.1:19100" npm start
```

```bash
npm test                                   # protocol, packets, PNG, print session, i18n, text layout
npm run netprobe -- 192.168.1.50           # talk to a real printer: status only, prints nothing
npm run netprobe -- 192.168.1.50 --test    # prints a 30 mm test pattern
npm run netprobe -- --discover
```

`npm run netprobe` is the quickest first check against real hardware. It shows the raw 20-byte
status and whether the tape is detected.

## How Wi-Fi printing works

The SR5900 family listens on port 9100 for both UDP and TCP. Every UDP packet begins with a
32-byte header: `"TPRT"`, `0`, `1`, `0x20`, command, payload length, then two zero words. All
fields are big-endian u32. Replies use `"tprt"`.

| UDP command | Reply | Meaning |
|---|---|---|
| `0x0001` | 20-byte status | `[1]` state (2 = printing), `[2]` error, `[3]` tape code, `[12..13]` labels printed |
| `0x0002` | `02 00 00` | start / lock the print session |
| `0x0101`, `0x0100` | –, `10` | announce the data stream |
| `0x0003` | `03 00 00` | end / unlock the session |

One print is: status (must be idle, no error) → lock → TCP connect → `0x0101` / `0x0100` →
write the job → close → poll status until done → unlock. The server always unlocks, even after
an error. The job on TCP is the normal TEPRA command stream (`@ {ST C D G | L T H s raster FF |
… @`), byte-for-byte what the official software sends. `test/network.test.mjs` checks this
against the capture in hikalium/sr5900p. See `server/network.js` and `buildNetworkJobBytes()` in
`app/protocol.js`.

The full command reference (Japanese) is in [PROTOCOL.md](PROTOCOL.md).

## Known limitations

- **Feed** and **Feed + cut** are Bluetooth-only. The Wi-Fi sequence for them hasn't been
  captured yet. To get a separate cut on Wi-Fi, print with *Cut: after each label*.
- *Load installed fonts* needs Chrome or Edge, and the page must be a secure context
  (`https://` or `localhost`). Over plain `http://<lan-ip>` you get the built-in list of common
  fonts.
- Discovery uses broadcast, so it only works with host networking on the same subnet.
- SR-R5600 series printers (BLE only) and the SR5500P are not supported.

## Credits

- [nikachu2012/tepra_web](https://github.com/nikachu2012/tepra_web) (MIT): the editor, the
  raster/command generation reverse-engineered from TEPRA LINK 2, and the Bluetooth bridge. This
  project is built on that code.
- [takonomura/tepra-web](https://github.com/takonomura/tepra-web) and
  [hikalium/sr5900p](https://github.com/hikalium/sr5900p) (MIT): the SR5900P Wi-Fi protocol
  (UDP control packets and session sequence), based on
  [Mine02C4's analysis](https://github.com/Mine02C4/TEPRA_PRO_SR5900P_analysis). The network
  transport here is a fresh JavaScript implementation of that protocol.

- Icons: [Tabler Icons](https://tabler.io/icons) (MIT), [Maki](https://github.com/mapbox/maki)
  (CC0) and [Phosphor Icons](https://phosphoricons.com) (MIT), without their brand logos. See
  [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md). `app/icons.json` is generated by
  `scripts/build-icons.mjs`; the comment at its top explains how to update the sets.

This is an unofficial tool and is not affiliated with KING JIM.
