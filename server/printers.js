// Saved network printers.
//
// Two sources, merged:
//   - TEPRA_PRINTERS env var (read-only in the UI), comma separated:
//       TEPRA_PRINTERS="192.168.1.50"
//       TEPRA_PRINTERS="Kitchen=192.168.1.50,Garage=192.168.1.51:9100"
//     An entry may end with "@<model>" to pick the model, e.g. "Office=10.0.0.9@SR5900C".
//   - $DATA_DIR/printers.json, edited from the web UI.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_PORT } from './network.js';
import { PRINTERS } from '../app/models.js';

export const DEFAULT_MODEL = 'TEPRA PRO SR5900P';

const HOST_RE = /^[A-Za-z0-9.-]{1,253}$|^\[?[0-9A-Fa-f:]+\]?$/;

/** Maps "SR5900C" / "TEPRA PRO SR5900C" to the full model name. */
export function resolveModel(name) {
  if (!name) return DEFAULT_MODEL;
  const upper = String(name).trim().toUpperCase();
  const hit = PRINTERS.find((p) => p.model.toUpperCase() === upper || p.usbmdl.toUpperCase() === upper);
  return hit ? hit.model : DEFAULT_MODEL;
}

/** Validates and normalises a printer entry. Throws on bad input. */
export function normalizePrinter(input, { idPrefix = 'p' } = {}) {
  let host = String(input.host || '').trim();
  let port = Number(input.port) || DEFAULT_PORT;
  const m = host.match(/^([^:\[\]]+):(\d+)$/);
  if (m) { host = m[1]; port = Number(m[2]); }
  if (!host || !HOST_RE.test(host)) throw new Error('Enter a valid IP address or host name');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1-65535');
  const name = String(input.name || '').trim().slice(0, 60) || host;
  return {
    id: input.id || `${idPrefix}-${crypto.randomBytes(4).toString('hex')}`,
    name,
    host,
    port,
    model: resolveModel(input.model),
  };
}

export function parseEnvPrinters(value) {
  if (!value) return [];
  const out = [];
  for (const [i, raw] of value.split(',').map((s) => s.trim()).filter(Boolean).entries()) {
    let rest = raw;
    let model;
    const at = rest.lastIndexOf('@');
    if (at > 0) { model = rest.slice(at + 1); rest = rest.slice(0, at); }
    let name;
    const eq = rest.indexOf('=');
    if (eq > 0) { name = rest.slice(0, eq); rest = rest.slice(eq + 1); }
    try {
      out.push({ ...normalizePrinter({ id: `env-${i}`, name, host: rest, model }), fromEnv: true });
    } catch (err) {
      console.warn(`Ignoring TEPRA_PRINTERS entry "${raw}": ${err.message}`);
    }
  }
  return out;
}

export class PrinterStore {
  constructor(dataDir, envValue) {
    this.file = path.join(dataDir, 'printers.json');
    this.env = parseEnvPrinters(envValue);
    this.saved = [];
  }

  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.saved = (Array.isArray(data.printers) ? data.printers : [])
        .map((p) => { try { return normalizePrinter(p); } catch { return null; } })
        .filter(Boolean);
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`Could not read ${this.file}: ${err.message}`);
      this.saved = [];
    }
  }

  async _persist() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ printers: this.saved }, null, 2));
    await fs.rename(tmp, this.file);
  }

  list() {
    return [...this.env, ...this.saved];
  }

  find(idOrHost) {
    const all = this.list();
    const key = String(idOrHost).toLowerCase();
    return all.find((p) => p.id === idOrHost || p.host === idOrHost)
      || all.find((p) => p.name.toLowerCase() === key)
      || null;
  }

  async add(input) {
    const p = normalizePrinter(input);
    const dup = this.list().find((x) => x.host === p.host && x.port === p.port);
    if (dup) {
      if (dup.fromEnv) return dup;
      Object.assign(dup, { name: p.name, model: p.model });
      await this._persist();
      return dup;
    }
    this.saved.push(p);
    await this._persist();
    return p;
  }

  async remove(id) {
    const before = this.saved.length;
    this.saved = this.saved.filter((p) => p.id !== id);
    if (this.saved.length === before) {
      if (this.env.some((p) => p.id === id)) throw new Error('This printer comes from TEPRA_PRINTERS and cannot be removed here');
      return false;
    }
    await this._persist();
    return true;
  }
}
