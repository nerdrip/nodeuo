import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import sharp from './safe-sharp.js';
import { WorkerTaskPool } from '../systems/worker-pool.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ASSETS_DIR = path.resolve(HERE, '..', '..', '..', 'client', 'public', 'assets');
const WORKER_FILE = new URL('./asset-worker.js', import.meta.url);
const MAX_GRAPHIC_BYTES = 6 * 1024 * 1024;
const assetWorkers = new WorkerTaskPool(WORKER_FILE, {
  name: 'assets', size: 2, maxQueue: 64, defaultTimeoutMs: 30_000,
});

const ASSET_KINDS = Object.freeze({
  land:       { label: 'Land Art', file: 'tiledata.json', path: ['land'], editable: true, preview: 'land', atlas: 'land-atlas.json' },
  static:     { label: 'Static Art / Items', file: 'tiledata.json', path: ['statics'], editable: true, preview: 'static', atlas: 'static-atlas.json' },
  gump:       { label: 'Gump graphics', file: 'gump-atlas.json', path: ['tiles'], editable: false, preview: 'gump', atlas: 'gump-atlas.json' },
  texture:    { label: 'Terrain textures', file: 'texmap-atlas.json', path: ['tiles'], editable: false, preview: 'texmap', atlas: 'texmap-atlas.json' },
  animation:  { label: 'Mobile animations', file: 'mobiles-atlas.json', path: ['bodies'], editable: false, preview: 'animation' },
  animdata:   { label: 'AnimData', file: 'animdata.json', path: ['entries'], editable: true },
  hue:        { label: 'Hues', file: 'hues.json', path: ['hues'], editable: true, preview: 'hue' },
  multi:      { label: 'Multis', file: 'multi.json', path: ['multis'], editable: true },
  'radar-land':   { label: 'Radar colors — land', file: 'radarcol.json', path: ['land'], editable: true },
  'radar-static': { label: 'Radar colors — statics', file: 'radarcol.json', path: ['static'], editable: true },
  cliloc:     { label: 'Cliloc strings', file: 'cliloc.json', path: ['entries'], editable: true },
  sound:      { label: 'Sounds', file: 'sounds.json', path: ['entries'], editable: true, preview: 'sound' },
  music:      { label: 'Music', file: 'music.json', path: ['entries'], editable: true, preview: 'music' },
  light:      { label: 'Lights', file: 'lights.json', path: ['entries'], editable: false },
  font:       { label: 'ASCII fonts', file: 'fonts.json', path: ['fonts'], editable: false, preview: 'font' },
  cursor:     { label: 'Cursors', file: 'cursors.json', path: ['cursors'], editable: true, preview: 'cursor' },
});

function workerTask(task, options) {
  return assetWorkers.run(task, options);
}

function parseId(raw) {
  const text = String(raw ?? '').trim();
  const id = /^0x/i.test(text) ? Number.parseInt(text.slice(2), 16) : Number(text);
  return Number.isInteger(id) && id >= 0 && id <= 0xffff_ffff ? id : null;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && !Object.keys(value).some((key) => key === '__proto__' || key === 'constructor' || key === 'prototype');
}

function finiteInt(value, min, max, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback;
}

function cleanString(value, max = 128) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);
}

function sanitizeEntry(kind, value) {
  if (kind === 'cliloc') return { value: cleanString(value, 8192), merge: false };
  if (kind === 'radar-land' || kind === 'radar-static') {
    return { value: finiteInt(value, 0, 0xffff), merge: false };
  }
  if (!plainObject(value)) throw new Error('entry must be a plain JSON object');
  if (kind === 'land') return {
    value: {
      flags: finiteInt(value.flags, 0, 0xffff_ffff),
      flagsHi: finiteInt(value.flagsHi, 0, 0xffff_ffff),
      texId: finiteInt(value.texId, 0, 0xffff),
      name: cleanString(value.name, 64),
    }, merge: true,
  };
  if (kind === 'static') {
    const allowed = ['flags', 'flagsHi', 'weight', 'quality', 'quantity', 'animId', 'hue', 'stackingOffset', 'height'];
    const out = { name: cleanString(value.name, 64) };
    for (const key of allowed) if (value[key] != null) out[key] = finiteInt(value[key], 0, 0xffff_ffff);
    return { value: out, merge: true };
  }
  if (kind === 'hue') return {
    value: {
      name: cleanString(value.name, 128),
      tableStart: finiteInt(value.tableStart, 0, 0xffff),
      tableEnd: finiteInt(value.tableEnd, 0, 0xffff),
    }, merge: true,
  };
  if (kind === 'animdata') {
    const frames = Array.isArray(value.frames) ? value.frames.slice(0, 64).map((frame) => finiteInt(frame, -128, 127)) : [];
    return { value: {
      start: finiteInt(value.start, -128, 127),
      count: finiteInt(value.count ?? frames.length, 0, 64),
      interval: finiteInt(value.interval, 0, 255),
      frames,
    }, merge: true };
  }
  if (kind === 'multi') {
    const source = Array.isArray(value.components) ? value.components : Array.isArray(value) ? value : null;
    if (!source || source.length > 20_000) throw new Error('multi must be an array of at most 20000 components');
    return { value: source.map((entry) => ({
      id: finiteInt(entry?.id, 0, 0xffff),
      x: finiteInt(entry?.x, -32768, 32767), y: finiteInt(entry?.y, -32768, 32767),
      z: finiteInt(entry?.z, -128, 127), visible: entry?.visible !== false,
    })), merge: false };
  }
  if (kind === 'sound') return { value: { name: cleanString(value.name, 256) }, merge: true };
  if (kind === 'music') {
    const file = path.basename(cleanString(value.file, 260));
    if (!/\.(mp3|ogg|wav)$/i.test(file)) throw new Error('music file must end in .mp3, .ogg or .wav');
    return { value: { file, name: cleanString(value.name, 128), loop: value.loop === true }, merge: true };
  }
  if (kind === 'cursor') return { value: {
    hotspotX: finiteInt(value.hotspotX, -4096, 4096),
    hotspotY: finiteInt(value.hotspotY, -4096, 4096),
  }, merge: true };
  throw new Error(`${kind} entries are read-only; use a graphic override where supported`);
}

function safeFile(assetsDir, name) {
  const file = path.resolve(assetsDir, name);
  if (!file.startsWith(`${path.resolve(assetsDir)}${path.sep}`)) throw new Error('invalid asset path');
  return file;
}

function kindSpec(kind, assetsDir) {
  const spec = ASSET_KINDS[kind];
  if (!spec) throw new Error(`unknown asset kind: ${kind}`);
  return { ...spec, absoluteFile: safeFile(assetsDir, spec.file) };
}

function manifestCounts(text) {
  const values = {};
  for (const key of ['count', 'landCount', 'staticCount', 'fontCount', 'pageCount']) {
    const match = new RegExp(`"${key}"\\s*:\\s*(\\d+)`).exec(text);
    if (match) values[key] = Number(match[1]);
  }
  return values;
}

function catalog(assetsDir) {
  const byFile = new Map();
  const modules = [];
  for (const [kind, spec] of Object.entries(ASSET_KINDS)) {
    const file = safeFile(assetsDir, spec.file);
    let status = byFile.get(file);
    if (!status) {
      try {
        const stat = fs.statSync(file);
        const fd = fs.openSync(file, 'r');
        const sample = Buffer.allocUnsafe(Math.min(4096, stat.size));
        const bytes = fs.readSync(fd, sample, 0, sample.length, 0);
        fs.closeSync(fd);
        status = { present: true, size: stat.size, mtime: Math.trunc(stat.mtimeMs), ...manifestCounts(sample.subarray(0, bytes).toString('utf8')) };
      } catch (error) { status = { present: false, error: error?.code ?? error?.message }; }
      byFile.set(file, status);
    }
    modules.push({ kind, ...spec, ...status });
  }
  const extraFiles = ['verdata.json', 'professions.json', 'speeches.json', 'housedata.json', 'multimap.json', 'unifont.json'];
  return {
    root: assetsDir,
    workers: assetWorkers.snapshot(),
    modules,
    supplemental: extraFiles.map((name) => {
      try { const stat = fs.statSync(safeFile(assetsDir, name)); return { name, present: true, size: stat.size, mtime: Math.trunc(stat.mtimeMs) }; }
      catch { return { name, present: false }; }
    }),
    mobileAtlas: mobileAtlasShardStatus(assetsDir),
    editors: [
      { id: 'content-studio', label: 'Content Studio', href: '/studio', purpose: 'scripted gumps, NPCs, quests and server content' },
      { id: 'script-studio', label: 'Script Studio', href: '/script-studio', purpose: 'commands, AI, item hooks, mobile events and region automation' },
      { id: 'data-editor', label: 'Data Editor', href: '/data-editor', purpose: 'structured server JSON' },
      { id: 'iso-editor', label: 'Iso World Editor', href: '/editor', purpose: 'terrain and placed world statics' },
      { id: 'animations', label: 'Animation Inspector', href: '/#animations', purpose: 'body actions, frames and definition validation' },
    ],
  };
}

function readMobileAtlasIndex(assetsDir) {
  try {
    const index = JSON.parse(fs.readFileSync(safeFile(assetsDir, 'mobiles-atlas-index.json'), 'utf8'));
    return index?.format === 'nodeuo.mobile-atlas-shards' ? index : null;
  } catch { return null; }
}

function mobileAtlasShardStatus(assetsDir) {
  const index = readMobileAtlasIndex(assetsDir);
  if (!index) return { mode: 'monolithic', present: fs.existsSync(safeFile(assetsDir, 'mobiles-atlas.json')) };
  const rows = Object.values(index.shards ?? {});
  const pages = Object.values(index.pages ?? {});
  const compressed = pages.map((row) => row.ktx2).filter(Boolean);
  return {
    mode: 'sharded', revision: index.revision, shardSize: index.shardSize,
    shards: rows.length, bodies: rows.reduce((sum, row) => sum + (row.bodyCount | 0), 0),
    pages: pages.length,
    bytes: [...rows, ...pages, ...compressed].reduce((sum, row) => sum + (Number(row.bytes) || 0), 0),
    ktx2Pages: compressed.length,
    missing: [...rows, ...pages, ...compressed]
      .filter((row) => !fs.existsSync(safeFile(assetsDir, path.basename(row.file))))
      .map((row) => row.file),
  };
}

function mobileShardForId(assetsDir, id) {
  const index = readMobileAtlasIndex(assetsDir);
  if (!index || !Number.isInteger(index.shardSize)) return null;
  const row = index.shards?.[Math.floor(id / index.shardSize)];
  return row ? { index, row, file: safeFile(assetsDir, path.basename(row.file)) } : null;
}

function overrideManifestFile(assetsDir) { return safeFile(assetsDir, 'asset-overrides.json'); }
function readOverrideManifest(assetsDir) {
  try { return JSON.parse(fs.readFileSync(overrideManifestFile(assetsDir), 'utf8')); }
  catch { return { schemaVersion: 1, land: {}, static: {}, gump: {}, texmap: {} }; }
}
function writeOverrideManifest(assetsDir, value) {
  const file = overrideManifestFile(assetsDir);
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

/** Register the decoded client-resource editor API. Large JSON parsing and
 * serialization happens in Worker Threads, outside the shard tick. */
export function registerAssetRoutes(routes, {
  assetsDir = DEFAULT_ASSETS_DIR, onChanged = null, isMultiInUse = null,
} = {}) {
  const root = path.resolve(assetsDir || DEFAULT_ASSETS_DIR);
  const validationJobs = new Map();
  let atlasValidationCache = { revision: null, fingerprints: {} };
  const changed = (event) => { try { onChanged?.(event); } catch { /* editor write remains committed */ } };

  async function validateAssets({ signal, onProgress = () => {} } = {}) {
    const started = performance.now();
    const checks = [];
    const entries = Object.entries(ASSET_KINDS);
    let completed = 0;
    await Promise.all(entries.map(async ([kind, base]) => {
      const file = safeFile(root, base.file);
      try {
        if (kind === 'animation') {
          const index = readMobileAtlasIndex(root);
          if (index) {
            const cache = atlasValidationCache.revision === index.revision
              ? atlasValidationCache.fingerprints : {};
            const result = await workerTask({
              action: 'mobile-integrity', root,
              indexFile: 'mobiles-atlas-index.json', cache,
            }, {
              timeoutMs: 120_000, signal,
              onProgress: (progress) => onProgress({ ...progress, kind }),
            });
            atlasValidationCache = { revision: result.revision, fingerprints: result.fingerprints };
            checks.push({ kind, file: 'mobiles-atlas-index.json', ok: true,
              count: result.count, size: result.size, files: result.files,
              cached: result.cached, revision: result.revision });
            return;
          }
        }
        const result = await workerTask({ action: 'summary', file, collectionPath: base.path }, { signal });
        checks.push({ kind, file: base.file, ok: true, count: result.count, size: result.size });
      } catch (error) {
        checks.push({ kind, file: base.file, ok: false, cancelled: error?.name === 'AbortError', error: error.message });
      } finally {
        completed++;
        onProgress({ phase: 'collections', completed, total: entries.length, kind });
      }
    }));
    if (signal?.aborted) {
      const error = new Error(String(signal.reason ?? 'asset validation cancelled'));
      error.name = 'AbortError';
      throw error;
    }
    checks.sort((a, b) => entries.findIndex(([kind]) => kind === a.kind)
      - entries.findIndex(([kind]) => kind === b.kind));
    return { ok: checks.every((check) => check.ok), checks,
      workers: assetWorkers.snapshot(), ms: Math.round(performance.now() - started) };
  }

  function startValidationJob() {
    const id = crypto.randomUUID();
    const controller = new AbortController();
    const job = { id, status: 'running', createdAt: Date.now(), updatedAt: Date.now(),
      progress: { phase: 'queued', completed: 0, total: 1 }, result: null, error: null, controller };
    validationJobs.set(id, job);
    job.promise = validateAssets({
      signal: controller.signal,
      onProgress(progress) { job.progress = progress; job.updatedAt = Date.now(); },
    }).then((result) => {
      job.status = result.ok ? 'completed' : 'failed'; job.result = result; job.updatedAt = Date.now();
      return result;
    }, (error) => {
      job.status = error?.name === 'AbortError' ? 'cancelled' : 'failed';
      job.error = error?.message ?? String(error); job.updatedAt = Date.now();
      return null;
    });
    for (const [oldId, old] of validationJobs) {
      if (oldId !== id && old.status !== 'running' && Date.now() - old.updatedAt > 60 * 60_000) validationJobs.delete(oldId);
    }
    return job;
  }

  const publicJob = (job) => job && ({ id: job.id, status: job.status,
    createdAt: job.createdAt, updatedAt: job.updatedAt, progress: job.progress,
    result: job.result, error: job.error });

  routes.push({ method: 'GET', path: '/api/assets/editor/catalog', run: () => catalog(root) });
  routes.push({
    method: 'POST', path: '/api/assets/editor/validate',
    run: async ({ req }) => {
      const controller = new AbortController();
      const abort = () => controller.abort('admin request disconnected');
      req?.once?.('aborted', abort);
      try { return await validateAssets({ signal: controller.signal }); }
      finally { req?.off?.('aborted', abort); }
    },
  });
  routes.push({ method: 'POST', path: '/api/assets/editor/validation-jobs',
    run: () => ({ ok: true, job: publicJob(startValidationJob()) }) });
  routes.push({ method: 'GET', path: '/api/assets/editor/validation-jobs/:id',
    run: ({ params }) => {
      const job = validationJobs.get(params.id);
      return job ? { ok: true, job: publicJob(job) } : { error: 'validation job not found' };
    } });
  routes.push({ method: 'DELETE', path: '/api/assets/editor/validation-jobs/:id',
    run: ({ params }) => {
      const job = validationJobs.get(params.id);
      if (!job) return { error: 'validation job not found' };
      if (job.status === 'running') {
        job.progress = { ...job.progress, phase: 'cancelling' };
        job.updatedAt = Date.now(); job.controller.abort('cancelled by operator');
      }
      return { ok: true, job: publicJob(job) };
    } });
  routes.push({
    method: 'GET', path: '/api/assets/editor/entries/:kind',
    run: async ({ params, query }) => {
      try {
        if (params.kind === 'animation') {
          const index = readMobileAtlasIndex(root);
          if (index) {
            const q = String(query.get('q') ?? '').trim().toLowerCase();
            const offset = finiteInt(query.get('offset'), 0, 1_000_000);
            const limit = finiteInt(query.get('limit'), 1, 500, 100);
            const all = Object.values(index.shards ?? {}).flatMap((row) => row.bodyIds ?? [])
              .filter((id) => !q || String(id).includes(q) || `0x${id.toString(16)}`.includes(q))
              .sort((a, b) => a - b);
            return { kind: 'animation', label: ASSET_KINDS.animation.label, editable: false,
              preview: 'animation', total: all.length, offset, limit,
              entries: all.slice(offset, offset + limit).map((id) => ({ id, value: { shard: Math.floor(id / index.shardSize) } })),
              revision: index.revision };
          }
        }
        const spec = kindSpec(params.kind, root);
        if (!fs.existsSync(spec.absoluteFile)) return { error: `${spec.file} is missing` };
        return {
          kind: params.kind, label: spec.label, editable: spec.editable, preview: spec.preview ?? null,
          ...(await workerTask({
            action: 'entries', file: spec.absoluteFile, collectionPath: spec.path,
            query: query.get('q'), offset: query.get('offset'), limit: query.get('limit'),
          })),
        };
      } catch (error) { return { error: error.message }; }
    },
  });
  routes.push({
    method: 'GET', path: '/api/assets/editor/entry/:kind/:id',
    run: async ({ params }) => {
      try {
        if (params.kind === 'animation') {
          const id = parseId(params.id);
          const shard = id == null ? null : mobileShardForId(root, id);
          if (shard) return { kind: 'animation', editable: false, ...(await workerTask({
            action: 'entry', file: shard.file, collectionPath: ['bodies'], id: params.id,
          })), revision: shard.index.revision, shard: shard.row.file };
        }
        const spec = kindSpec(params.kind, root);
        return { kind: params.kind, editable: spec.editable, ...(await workerTask({
          action: 'entry', file: spec.absoluteFile, collectionPath: spec.path, id: params.id,
        })) };
      } catch (error) { return { error: error.message }; }
    },
  });
  routes.push({
    method: 'PUT', path: '/api/assets/editor/entry/:kind/:id',
    run: async ({ params, body }) => {
      try {
        const spec = kindSpec(params.kind, root);
        if (!spec.editable) return { error: 'this manifest is read-only; import a graphic override instead' };
        if (params.kind === 'multi') {
          const id = parseId(params.id);
          if (id != null && isMultiInUse?.(id)) {
            return { error: 'this multi is used by a placed structure; demolish or migrate those instances before changing its blueprint', conflict: true };
          }
        }
        const clean = sanitizeEntry(params.kind, body?.value);
        if (Buffer.byteLength(JSON.stringify(clean.value)) > 1024 * 1024) return { error: 'entry exceeds 1 MiB' };
        const result = await workerTask({
          action: 'update-entry', file: spec.absoluteFile, collectionPath: spec.path, id: params.id,
          value: clean.value, merge: clean.merge, expectedMtime: body?.expectedMtime,
        });
        if (result.ok) changed({ type: 'metadata', kind: params.kind, id: parseId(params.id) });
        return result;
      } catch (error) {
        return { error: error.message, conflict: error.code === 'CONFLICT', actual: error.before ?? null };
      }
    },
  });
  routes.push({
    method: 'GET', path: '/api/assets/editor/patches',
    run: async () => {
      const file = safeFile(root, 'patches.json');
      try { return await workerTask({ action: 'document', file }); }
      catch (error) { return { error: error.message }; }
    },
  });
  routes.push({
    method: 'PUT', path: '/api/assets/editor/patches',
    run: async ({ body }) => {
      try {
        const input = body?.value;
        if (!plainObject(input)) return { error: 'patch manifest must be an object' };
        const parseMap = (source) => {
          if (!plainObject(source ?? {})) throw new Error('patch groups must be objects');
          const out = {};
          for (const [from, to] of Object.entries(source ?? {})) {
            const sourceId = parseId(from), targetId = parseId(to);
            if (sourceId == null || targetId == null) throw new Error(`invalid remap ${from} -> ${to}`);
            out[String(sourceId)] = targetId;
            if (Object.keys(out).length > 20_000) throw new Error('too many patch entries');
          }
          return out;
        };
        const value = {
          _doc: 'NodeUO reversible runtime resource remaps. Managed by Admin > Assets.',
          gumps: parseMap(input.gumps), statics: parseMap(input.statics),
          hues: plainObject(input.hues ?? {}) ? input.hues : {},
        };
        const result = await workerTask({
          action: 'write-document', file: safeFile(root, 'patches.json'), value,
          expectedMtime: body?.expectedMtime,
        });
        if (result.ok) changed({ type: 'patches' });
        return result;
      } catch (error) { return { error: error.message, conflict: error.code === 'CONFLICT', actual: error.before ?? null }; }
    },
  });
  routes.push({
    method: 'GET', path: '/api/assets/editor/overrides',
    run: () => ({ value: readOverrideManifest(root) }),
  });
  routes.push({
    method: 'PUT', path: '/api/assets/editor/override/:kind/:id',
    run: async ({ params, body }) => {
      const kind = params.kind === 'texture' ? 'texmap' : params.kind;
      if (!['land', 'static', 'gump', 'texmap'].includes(kind)) return { error: 'graphic overrides support land, static, gump and texture' };
      const id = parseId(params.id);
      if (id == null) return { error: 'invalid resource id' };
      const encoded = String(body?.pngBase64 ?? '').replace(/^data:image\/png;base64,/i, '');
      let input;
      try { input = Buffer.from(encoded, 'base64'); } catch { return { error: 'invalid base64 PNG' }; }
      if (!input.length || input.length > MAX_GRAPHIC_BYTES) return { error: 'PNG must be between 1 byte and 6 MiB' };
      try {
        const image = sharp(input, { limitInputPixels: 4096 * 4096 });
        const meta = await image.metadata();
        if (meta.format !== 'png' || !meta.width || !meta.height || meta.width > 4096 || meta.height > 4096) {
          return { error: 'expected a PNG up to 4096x4096' };
        }
        const dir = safeFile(root, 'overrides');
        fs.mkdirSync(dir, { recursive: true });
        const name = `${kind}-${id}.png`;
        const output = safeFile(dir, name);
        const temporary = `${output}.tmp-${process.pid}-${Date.now()}.png`;
        await image.png({ compressionLevel: 9, palette: true }).toFile(temporary);
        fs.renameSync(temporary, output);
        const manifest = readOverrideManifest(root);
        manifest.schemaVersion = 1;
        manifest[kind] = plainObject(manifest[kind]) ? manifest[kind] : {};
        manifest[kind][String(id)] = { file: `overrides/${name}`, width: meta.width, height: meta.height };
        writeOverrideManifest(root, manifest);
        const result = { ok: true, kind, id, file: manifest[kind][String(id)].file, width: meta.width, height: meta.height };
        changed({ type: 'override', action: 'upsert', kind, id });
        return result;
      } catch (error) { return { error: `PNG import failed: ${error.message}` }; }
    },
  });
  routes.push({
    method: 'DELETE', path: '/api/assets/editor/override/:kind/:id',
    run: ({ params }) => {
      const kind = params.kind === 'texture' ? 'texmap' : params.kind;
      const id = parseId(params.id);
      if (id == null || !['land', 'static', 'gump', 'texmap'].includes(kind)) return { error: 'invalid override target' };
      const manifest = readOverrideManifest(root);
      const relative = manifest?.[kind]?.[String(id)];
      if (!relative) return { error: 'override not found' };
      const file = safeFile(root, typeof relative === 'string' ? relative : relative.file);
      delete manifest[kind][String(id)];
      writeOverrideManifest(root, manifest);
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') return { error: error.message }; }
      changed({ type: 'override', action: 'remove', kind, id });
      return { ok: true, kind, id, removed: relative };
    },
  });
  routes.push({
    method: 'GET', path: '/api/assets/editor/preview/:kind/:id',
    run: async ({ params, res }) => {
      try {
        const kind = params.kind === 'texture' ? 'texmap' : params.kind;
        if (!['land', 'static', 'gump', 'texmap'].includes(kind)) throw new Error('preview is unavailable for this kind');
        const id = parseId(params.id);
        if (id == null) throw new Error('invalid resource id');
        const override = readOverrideManifest(root)?.[kind]?.[String(id)];
        if (override) {
          const file = safeFile(root, typeof override === 'string' ? override : override.file);
          const stat = fs.statSync(file);
          res.writeHead(200, { 'content-type': 'image/png', 'content-length': stat.size, 'cache-control': 'private, no-cache' });
          fs.createReadStream(file).pipe(res);
          return undefined;
        }
        const manifestName = kind === 'texmap' ? 'texmap-atlas.json' : `${kind}-atlas.json`;
        const manifestFile = safeFile(root, manifestName);
        let tileRecord;
        try {
          tileRecord = await workerTask({ action: 'entry', file: manifestFile, collectionPath: ['tiles'], id });
        } catch (error) {
          if (kind !== 'static') throw error;
          tileRecord = await workerTask({
            action: 'entry', file: manifestFile, collectionPath: ['tiles'], id: id + 0x4000,
          });
        }
        const tile = tileRecord.value;
        const width = kind === 'land' ? 44 : tile.w;
        const height = kind === 'land' ? 44 : tile.h;
        const padding = { land: 2, static: 3, gump: 3, texmap: 2 }[kind];
        const page = safeFile(root, `${kind}-atlas-${String(tile.page).padStart(padding, '0')}.png`);
        const png = await sharp(page).extract({ left: tile.u, top: tile.v, width, height }).png().toBuffer();
        res.writeHead(200, {
          'content-type': 'image/png', 'content-length': png.length,
          'cache-control': 'private, max-age=300',
        });
        res.end(png);
      } catch (error) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return undefined;
    },
  });
  routes.push({
    method: 'GET', path: '/api/assets/editor/sound/:id',
    run: async ({ params, res }) => {
      try {
        const spec = kindSpec('sound', root);
        const record = await workerTask({ action: 'entry', file: spec.absoluteFile, collectionPath: spec.path, id: params.id });
        const offset = Number(record.value?.offset), size = Number(record.value?.size);
        const binary = safeFile(root, 'sounds.bin');
        const stat = fs.statSync(binary);
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size <= 0 || offset + size > stat.size) {
          throw new Error('invalid sound offset/size');
        }
        res.writeHead(200, {
          'content-type': 'audio/wav', 'content-length': size,
          'cache-control': 'private, max-age=300', 'accept-ranges': 'none',
        });
        fs.createReadStream(binary, { start: offset, end: offset + size - 1 }).pipe(res);
      } catch (error) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return undefined;
    },
  });
}

export { ASSET_KINDS, DEFAULT_ASSETS_DIR, sanitizeEntry };
