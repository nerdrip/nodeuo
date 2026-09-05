import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function atomicJson(file, value) {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(temp, file); } catch (error) { try { fs.unlinkSync(temp); } catch {} throw error; }
}

function digestFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export class ContentReleaseManager {
  constructor(file, assetsDir) {
    this.file = path.resolve(file);
    this.assetsDir = path.resolve(assetsDir);
    this.state = { schema: 1, revision: 1, active: null, staged: {}, history: [] };
    try { this.state = { ...this.state, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }; }
    catch (error) { if (error.code !== 'ENOENT') console.warn(`[content-releases] ${error.message}`); }
  }

  _asset(name) {
    const rel = String(name ?? '').replace(/\\/g, '/');
    if (!rel || rel.includes('..') || !/^[a-z0-9_./-]+$/i.test(rel)) throw new Error(`invalid asset path ${rel}`);
    const file = path.resolve(this.assetsDir, rel);
    if (!file.startsWith(`${this.assetsDir}${path.sep}`)) throw new Error('asset path escapes root');
    return { rel, file };
  }

  async stage({ label = '', files = [] } = {}) {
    const requested = [...new Set((Array.isArray(files) ? files : []).map(String))].slice(0, 512);
    if (!requested.length) requested.push('mobiles-atlas-index.json', 'patches.json', 'asset-overrides.json');
    const entries = [];
    for (const name of requested) {
      const asset = this._asset(name);
      let stat;
      try { stat = fs.statSync(asset.file); } catch { continue; }
      if (!stat.isFile()) continue;
      entries.push({ name: asset.rel, bytes: stat.size, sha256: await digestFile(asset.file) });
    }
    if (!entries.length) return { ok: false, error: 'release contains no existing assets' };
    const id = `release-${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
    const release = { id, label: String(label).slice(0, 128), createdAt: Date.now(), files: entries };
    release.fingerprint = crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
    this.state.staged[id] = release;
    atomicJson(this.file, this.state);
    return { ok: true, release };
  }

  async activate(id, expectedRevision) {
    if (Number(expectedRevision) !== this.state.revision) return { ok: false, conflict: true, revision: this.state.revision };
    const release = this.state.staged[String(id)];
    if (!release) return { ok: false, error: 'staged release not found' };
    for (const entry of release.files) {
      const asset = this._asset(entry.name);
      let stat;
      try { stat = fs.statSync(asset.file); }
      catch { return { ok: false, error: `staged asset is missing: ${entry.name}` }; }
      if (!stat.isFile() || stat.size !== entry.bytes || await digestFile(asset.file) !== entry.sha256) {
        return { ok: false, error: `staged asset changed after validation: ${entry.name}` };
      }
    }
    if (this.state.active) this.state.history.push(this.state.active);
    this.state.history = this.state.history.slice(-20);
    this.state.active = { ...release, activatedAt: Date.now(), revision: this.state.revision + 1 };
    delete this.state.staged[String(id)];
    this.state.revision++;
    atomicJson(this.file, this.state);
    return { ok: true, active: this.state.active, revision: this.state.revision };
  }

  _find(id) {
    const key = String(id ?? '');
    if (!key) return this.state.active;
    return this.state.staged[key]
      ?? (this.state.active?.id === key ? this.state.active : null)
      ?? this.state.history.find((entry) => entry.id === key) ?? null;
  }

  /** Cheap operator preflight. Content hashes were already computed while
   * staging; this checks current presence/size and calculates rollout impact
   * without re-reading gigabytes on the admin request path. Activation still
   * performs the authoritative streaming hash verification. */
  preflight(id, clients = []) {
    const release = this._find(id);
    if (!release) return { ok: false, error: 'release not found' };
    const files = (release.files ?? []).map((entry) => {
      const asset = this._asset(entry.name);
      try {
        const stat = fs.statSync(asset.file);
        return { ...entry, present: stat.isFile(), currentBytes: stat.size,
          unchangedSize: stat.isFile() && stat.size === entry.bytes };
      } catch { return { ...entry, present: false, currentBytes: 0, unchangedSize: false }; }
    });
    const profiles = clients.filter(Boolean);
    const bytes = files.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0);
    const cachePressure = profiles.map((profile) => Number(profile.cache?.pressure) || 0);
    const ktx2Clients = profiles.filter((profile) => profile.formats?.includes?.('ktx2')).length;
    const warnings = [];
    if (files.some((entry) => !entry.present)) warnings.push('one or more files are missing');
    if (files.some((entry) => entry.present && !entry.unchangedSize)) warnings.push('one or more files changed size after staging');
    if (cachePressure.some((value) => value > 0.85)) warnings.push('one or more clients report high cache pressure');
    return { ok: !files.some((entry) => !entry.present || !entry.unchangedSize),
      release: { id: release.id, label: release.label, fingerprint: release.fingerprint },
      files, bytes, clients: { reporting: profiles.length, ktx2: ktx2Clients,
        pngFallback: Math.max(0, profiles.length - ktx2Clients),
        highCachePressure: cachePressure.filter((value) => value > 0.85).length },
      blastRadius: { connectedClients: clients.length, estimatedTransferBytes: bytes * clients.length },
      warnings };
  }

  compare(leftId, rightId) {
    const left = this._find(leftId), right = this._find(rightId);
    if (!left || !right) return { ok: false, error: 'both releases are required' };
    const a = new Map((left.files ?? []).map((entry) => [entry.name, entry]));
    const b = new Map((right.files ?? []).map((entry) => [entry.name, entry]));
    const names = [...new Set([...a.keys(), ...b.keys()])].sort();
    const files = names.map((name) => {
      const before = a.get(name), after = b.get(name);
      return { name, status: !before ? 'added' : !after ? 'removed'
        : before.sha256 === after.sha256 ? 'unchanged' : 'changed',
      beforeBytes: before?.bytes ?? 0, afterBytes: after?.bytes ?? 0 };
    });
    return { ok: true, left: left.id, right: right.id, files,
      summary: Object.fromEntries(['added', 'removed', 'changed', 'unchanged']
        .map((status) => [status, files.filter((entry) => entry.status === status).length])) };
  }

  rollback(expectedRevision) {
    if (Number(expectedRevision) !== this.state.revision) return { ok: false, conflict: true, revision: this.state.revision };
    const previous = this.state.history.pop();
    if (!previous) return { ok: false, error: 'no release to restore' };
    if (this.state.active) this.state.staged[this.state.active.id] = this.state.active;
    this.state.active = { ...previous, activatedAt: Date.now(), revision: this.state.revision + 1 };
    this.state.revision++;
    atomicJson(this.file, this.state);
    return { ok: true, active: this.state.active, revision: this.state.revision };
  }

  snapshot() { return structuredClone(this.state); }
}
