/**
 * NDJSON state store.
 *
 * Why not one big JSON file: a 50k-member group serialised as a single JSON blob
 * is ~10 MB, and git stores a fresh 10 MB blob on every one of the 120 commits a
 * month this repo makes. NDJSON sorted by user id means a snapshot that changes
 * 40 members produces ~40 changed lines, and git's delta compression handles the
 * rest. Repo growth becomes proportional to real churn, not roster size.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

export function readJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJSON(file, data, { pretty = false } = {}) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, pretty ? JSON.stringify(data, null, 2) + '\n' : JSON.stringify(data) + '\n');
}

/** Stream an NDJSON file line by line. Missing file simply yields nothing. */
export async function* readNDJSON(file) {
  if (!fs.existsSync(file)) return;
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed);
    } catch {
      // One corrupt line shouldn't nuke a year of history.
      console.warn(`[store] skipping malformed line ${lineNo} in ${file}`);
    }
  }
}

export async function loadNDJSON(file) {
  const out = [];
  for await (const row of readNDJSON(file)) out.push(row);
  return out;
}

/**
 * Atomic write: build a temp file, then rename. A runner killed mid-write
 * leaves the previous state intact rather than a truncated roster.
 */
export function writeNDJSON(file, rows, { sortKey = null } = {}) {
  ensureDir(path.dirname(file));
  const list = sortKey ? [...rows].sort((a, b) => (a[sortKey] > b[sortKey] ? 1 : a[sortKey] < b[sortKey] ? -1 : 0)) : rows;

  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    const CHUNK = 2000;
    let buf = '';
    let n = 0;
    for (const row of list) {
      buf += JSON.stringify(row) + '\n';
      if (++n % CHUNK === 0) {
        fs.writeSync(fd, buf);
        buf = '';
      }
    }
    if (buf) fs.writeSync(fd, buf);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  return list.length;
}

export function appendNDJSON(file, rows) {
  if (!rows.length) return 0;
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return rows.length;
}

/** Keep an append-only log from growing without bound. */
export async function trimNDJSON(file, maxRows) {
  if (!fs.existsSync(file)) return 0;
  const rows = await loadNDJSON(file);
  if (rows.length <= maxRows) return rows.length;
  writeNDJSON(file, rows.slice(rows.length - maxRows));
  return maxRows;
}

export class Logger {
  constructor(file) {
    this.file = file;
    this.lines = [];
    if (file) ensureDir(path.dirname(file));
  }
  log(...args) {
    const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
    console.log(line);
    this.lines.push(line);
  }
  flush() {
    if (this.file) fs.writeFileSync(this.file, this.lines.join('\n') + '\n');
  }
}
