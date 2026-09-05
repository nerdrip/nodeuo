import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';

function collectionAt(document, collectionPath = []) {
  let value = document;
  for (const segment of collectionPath) value = value?.[segment];
  if (value == null || typeof value !== 'object') throw new Error('asset collection is missing');
  return value;
}

function keyFor(collection, rawId) {
  if (!Array.isArray(collection)) return String(rawId);
  const id = Number(rawId);
  if (!Number.isInteger(id) || id < 0) throw new Error('asset id must be a non-negative integer');
  return id;
}

function searchText(id, value) {
  let body = '';
  try { body = typeof value === 'string' ? value : JSON.stringify(value); }
  catch { body = ''; }
  return `${id} ${body}`.toLowerCase();
}

function statShape(file) {
  const stat = fs.statSync(file);
  return { size: stat.size, mtime: Math.trunc(stat.mtimeMs) };
}

function rotateBackups(file, keep = 5) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.bak.${stamp}`;
  fs.copyFileSync(file, backup);
  const base = path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(`^${base}\\.bak\\.`);
  const backups = fs.readdirSync(path.dirname(file))
    .filter((name) => matcher.test(name))
    .map((name) => ({ name, mtime: fs.statSync(path.join(path.dirname(file), name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const old of backups.slice(keep)) fs.unlinkSync(path.join(path.dirname(file), old.name));
  return path.basename(backup);
}

function atomicWriteJson(file, document) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = `${JSON.stringify(document, null, 2)}\n`;
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, text, 'utf8');
  try { fs.renameSync(temporary, file); }
  catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

function readDocument(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function checkRevision(file, expectedMtime) {
  const before = fs.existsSync(file) ? statShape(file) : null;
  if (before && Number.isFinite(expectedMtime)
      && before.mtime !== Math.trunc(expectedMtime)) {
    const error = new Error('asset file changed since it was opened');
    error.code = 'CONFLICT';
    error.before = before;
    throw error;
  }
  return before;
}

function safeChild(root, file) {
  const base = path.resolve(root);
  const absolute = path.resolve(base, path.basename(String(file ?? '')));
  if (!absolute.startsWith(`${base}${path.sep}`)) throw new Error('invalid atlas file path');
  return absolute;
}

function hashFile(file) {
  const fd = fs.openSync(file, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      bytes += read;
    }
  } finally { fs.closeSync(fd); }
  return { bytes, sha256: hash.digest('hex') };
}

function validateMobileAtlas(task, report = () => {}) {
  const root = path.resolve(task.root);
  const indexFile = safeChild(root, task.indexFile ?? 'mobiles-atlas-index.json');
  const index = readDocument(indexFile);
  if (index?.format !== 'nodeuo.mobile-atlas-shards') throw new Error('mobile atlas shard index is invalid');
  const files = [];
  for (const [page, row] of Object.entries(index.pages ?? {})) {
    files.push({ kind: 'png', label: `page ${page}`, ...row });
    if (row.ktx2) files.push({ kind: 'ktx2', label: `page ${page}`, ...row.ktx2 });
  }
  for (const [shard, row] of Object.entries(index.shards ?? {})) {
    files.push({ kind: 'shard', label: `shard ${shard}`, ...row });
  }
  let bytes = 0;
  let cached = 0;
  const fingerprints = {};
  for (let i = 0; i < files.length; i++) {
    const row = files[i];
    const file = safeChild(root, row.file);
    const stat = fs.statSync(file);
    const cacheKey = path.basename(row.file);
    const prior = task.cache?.[cacheKey];
    let actual;
    if (prior?.mtime === Math.trunc(stat.mtimeMs) && prior?.size === stat.size
        && prior?.expected === row.sha256) {
      actual = { bytes: stat.size, sha256: prior.sha256 };
      cached++;
    } else actual = hashFile(file);
    if (actual.bytes !== Number(row.bytes) || actual.sha256 !== row.sha256) {
      throw new Error(`${row.kind === 'ktx2' ? 'KTX2 ' : ''}${row.label} integrity mismatch: ${row.file}`);
    }
    bytes += actual.bytes;
    fingerprints[cacheKey] = {
      size: stat.size, mtime: Math.trunc(stat.mtimeMs), expected: row.sha256,
      sha256: actual.sha256,
    };
    report({ phase: 'mobile-atlas', completed: i + 1, total: files.length,
      bytes, file: path.basename(row.file), cached });
  }
  return {
    count: Object.values(index.shards ?? {}).reduce((sum, row) => sum + (row.bodyCount | 0), 0),
    size: bytes, files: files.length, cached, revision: index.revision, fingerprints,
  };
}

function perform(task, report = () => {}) {
  if (task.action === 'mobile-integrity') return validateMobileAtlas(task, report);
  if (task.action === 'entries') {
    const document = readDocument(task.file);
    const collection = collectionAt(document, task.collectionPath);
    const all = Object.entries(collection);
    const query = String(task.query ?? '').trim().toLowerCase();
    const filtered = query ? all.filter(([id, value]) => searchText(id, value).includes(query)) : all;
    const offset = Math.max(0, Number(task.offset) | 0);
    const limit = Math.max(1, Math.min(250, Number(task.limit) | 0 || 80));
    return {
      entries: filtered.slice(offset, offset + limit).map(([id, value]) => ({ id, value })),
      total: all.length,
      filtered: filtered.length,
      offset,
      limit,
      ...statShape(task.file),
    };
  }
  if (task.action === 'entry') {
    const document = readDocument(task.file);
    const collection = collectionAt(document, task.collectionPath);
    const key = keyFor(collection, task.id);
    if (!Object.prototype.hasOwnProperty.call(collection, key)) throw new Error('asset entry not found');
    return { id: String(task.id), value: collection[key], ...statShape(task.file) };
  }
  if (task.action === 'document') {
    return { value: readDocument(task.file), ...statShape(task.file) };
  }
  if (task.action === 'summary') {
    const document = readDocument(task.file);
    const collection = collectionAt(document, task.collectionPath);
    return { count: Object.keys(collection).length, ...statShape(task.file) };
  }
  if (task.action === 'update-entry') {
    const before = checkRevision(task.file, Number(task.expectedMtime));
    const document = readDocument(task.file);
    const collection = collectionAt(document, task.collectionPath);
    const key = keyFor(collection, task.id);
    if (!Object.prototype.hasOwnProperty.call(collection, key) && !task.allowCreate) {
      throw new Error('asset entry not found');
    }
    const previous = collection[key];
    collection[key] = task.merge && previous && typeof previous === 'object' && !Array.isArray(previous)
      ? { ...previous, ...task.value }
      : task.value;
    const backup = rotateBackups(task.file);
    atomicWriteJson(task.file, document);
    return {
      ok: true, id: String(task.id), previous, value: collection[key], backup,
      before, after: statShape(task.file),
    };
  }
  if (task.action === 'write-document') {
    const before = checkRevision(task.file, Number(task.expectedMtime));
    const backup = rotateBackups(task.file);
    atomicWriteJson(task.file, task.value);
    return { ok: true, backup, before, after: statShape(task.file) };
  }
  throw new Error(`unknown asset worker action: ${task.action}`);
}

function execute(task, id = undefined) {
  const report = (progress) => parentPort.postMessage({ id, progress });
  try { parentPort.postMessage({ id, ok: true, result: perform(task, report) }); }
  catch (error) {
    parentPort.postMessage({
      id, ok: false,
      error: error?.message ?? String(error),
      code: error?.code,
      before: error?.before,
    });
  }
}

if (workerData != null) execute(workerData);
else parentPort.on('message', (message) => execute(message?.payload, message?.id));
