import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 1;
const DEFAULT_ID = 'factory-defaults';

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, text, 'utf8');
  try { fs.renameSync(temporary, file); }
  catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    throw error;
  }
}

function cleanLabel(value, fallback = 'Working profile') {
  const label = String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
  return label || fallback;
}

function publicProfile(profile, baseline) {
  let changedFiles = 0;
  for (const [key, hash] of Object.entries(profile.files ?? {})) {
    if (baseline?.files?.[key] !== hash) changedFiles++;
  }
  return {
    id: profile.id,
    label: profile.label,
    locked: profile.locked === true,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    revision: profile.revision | 0,
    fileCount: Object.keys(profile.files ?? {}).length,
    changedFiles,
    basedOn: profile.basedOn ?? null,
    history: (profile.history ?? []).slice(-40).reverse(),
  };
}

/**
 * Tiny content-addressed profile store for Content Studio. Canonical files
 * remain where the runtime expects them; profiles keep immutable blobs under
 * the save directory so a checkout update or browser reset cannot erase them.
 */
export class ContentProfileStore {
  constructor({ rootDir, sources = [] }) {
    this.root = path.resolve(rootDir);
    this.indexFile = path.join(this.root, 'index.json');
    this.objectsDir = path.join(this.root, 'objects');
    this.sources = new Map(sources.map((entry) => [String(entry.key), path.resolve(entry.file)]));
    this.index = null;
  }

  _objectFile(hash) {
    if (!/^[a-f0-9]{64}$/.test(String(hash))) throw new Error('invalid content object hash');
    return path.join(this.objectsDir, `${hash}.json`);
  }

  _putText(text) {
    JSON.parse(text);
    const normalized = `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
    const hash = crypto.createHash('sha256').update(normalized).digest('hex');
    const file = this._objectFile(hash);
    if (!fs.existsSync(file)) atomicWrite(file, normalized);
    return { hash, bytes: Buffer.byteLength(normalized) };
  }

  _snapshotCanonical() {
    const files = {};
    for (const [key, file] of this.sources) {
      if (!fs.existsSync(file)) continue;
      files[key] = this._putText(fs.readFileSync(file, 'utf8')).hash;
    }
    return files;
  }

  _save() {
    this.index.updatedAt = Date.now();
    atomicWrite(this.indexFile, `${JSON.stringify(this.index, null, 2)}\n`);
  }

  ensure() {
    if (this.index) return this.index;
    fs.mkdirSync(this.objectsDir, { recursive: true });
    try { this.index = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')); }
    catch {
      const now = Date.now();
      const baseline = {
        id: DEFAULT_ID,
        label: 'Factory defaults',
        locked: true,
        createdAt: now,
        updatedAt: now,
        revision: 1,
        basedOn: null,
        files: this._snapshotCanonical(),
        history: [{ revision: 1, at: now, actor: 'system', message: 'Immutable baseline captured' }],
      };
      this.index = {
        schemaVersion: SCHEMA_VERSION,
        activeProfileId: DEFAULT_ID,
        createdAt: now,
        updatedAt: now,
        profiles: { [DEFAULT_ID]: baseline },
        audit: [],
      };
      this._save();
      return this.index;
    }
    if (this.index?.schemaVersion !== SCHEMA_VERSION || !this.index.profiles?.[DEFAULT_ID]) {
      throw new Error('unsupported or damaged Content Studio profile index');
    }
    // A software update may add a new Studio source. Add only that previously
    // unknown file to the baseline; existing baseline objects are immutable.
    const baseline = this.index.profiles[DEFAULT_ID];
    let added = false;
    for (const [key, file] of this.sources) {
      if (baseline.files[key] || !fs.existsSync(file)) continue;
      baseline.files[key] = this._putText(fs.readFileSync(file, 'utf8')).hash;
      added = true;
    }
    if (added) {
      baseline.updatedAt = Date.now();
      baseline.revision++;
      baseline.history.push({ revision: baseline.revision, at: baseline.updatedAt,
        actor: 'system', message: 'Registered newly shipped Studio sources' });
      this._save();
    }
    return this.index;
  }

  _newId(label) {
    const slug = cleanLabel(label).toLowerCase().normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'profile';
    return `${slug}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
  }

  _createFromCanonical(label, actor, basedOn = this.index.activeProfileId) {
    const now = Date.now();
    const id = this._newId(label);
    this.index.profiles[id] = {
      id,
      label: cleanLabel(label),
      locked: false,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      basedOn,
      files: this._snapshotCanonical(),
      history: [{ revision: 1, at: now, actor: String(actor ?? 'admin'), message: 'Profile created' }],
    };
    this.index.activeProfileId = id;
    this._save();
    return this.index.profiles[id];
  }

  _canonicalChanges(profile) {
    const changes = [];
    for (const [key, file] of this.sources) {
      if (!fs.existsSync(file)) continue;
      const { hash } = this._putText(fs.readFileSync(file, 'utf8'));
      if (profile.files?.[key] !== hash) changes.push({ key, hash, beforeHash: profile.files?.[key] ?? null });
    }
    return changes;
  }

  ensureWritableProfile({ actor } = {}) {
    this.ensure();
    const active = this.index.profiles[this.index.activeProfileId] ?? this.index.profiles[DEFAULT_ID];
    if (!active.locked) return active;
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    return this._createFromCanonical(`Working copy ${stamp}`, actor, active.id);
  }

  recordFile(key, { actor, message } = {}) {
    this.ensure();
    const file = this.sources.get(String(key));
    if (!file || !fs.existsSync(file)) throw new Error(`unknown Content Studio source: ${key}`);
    const active = this.ensureWritableProfile({ actor });
    const beforeHash = active.files?.[key] ?? null;
    const { hash, bytes } = this._putText(fs.readFileSync(file, 'utf8'));
    if (beforeHash === hash) return { changed: false, profile: publicProfile(active, this.index.profiles[DEFAULT_ID]) };
    active.files ??= {};
    active.files[key] = hash;
    active.revision++;
    active.updatedAt = Date.now();
    active.history ??= [];
    active.history.push({ revision: active.revision, at: active.updatedAt,
      actor: String(actor ?? 'admin'), file: String(key), beforeHash, afterHash: hash, bytes,
      message: cleanLabel(message, `Published ${key}`) });
    this._save();
    return { changed: true, profile: publicProfile(active, this.index.profiles[DEFAULT_ID]) };
  }

  checkpoint({ actor, message = 'Automatic checkpoint before profile restore' } = {}) {
    this.ensure();
    let active = this.index.profiles[this.index.activeProfileId] ?? this.index.profiles[DEFAULT_ID];
    let changes = this._canonicalChanges(active);
    if (!changes.length) return { changed: false, profileId: active.id };
    if (active.locked) {
      active = this._createFromCanonical(`Recovered work ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, actor, active.id);
      return { changed: true, profileId: active.id, files: changes.length };
    }
    active.files ??= {};
    for (const change of changes) active.files[change.key] = change.hash;
    active.revision++;
    active.updatedAt = Date.now();
    active.history.push({ revision: active.revision, at: active.updatedAt,
      actor: String(actor ?? 'admin'), files: changes.map((entry) => entry.key), message });
    this._save();
    return { changed: true, profileId: active.id, files: changes.length };
  }

  create(label, { actor } = {}) {
    this.ensure();
    this.checkpoint({ actor, message: 'Checkpoint before creating a profile' });
    const profile = this._createFromCanonical(label, actor);
    return { ok: true, profile: publicProfile(profile, this.index.profiles[DEFAULT_ID]), state: this.state() };
  }

  restore(profileId, { actor } = {}) {
    this.ensure();
    const target = this.index.profiles[String(profileId)];
    if (!target) return { error: 'profile not found' };
    const preserved = this.checkpoint({ actor });
    const staged = [];
    try {
      for (const [key, hash] of Object.entries(target.files ?? {})) {
        const destination = this.sources.get(key);
        if (!destination) continue;
        const object = this._objectFile(hash);
        const text = fs.readFileSync(object, 'utf8');
        JSON.parse(text);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const temporary = `${destination}.profile-${process.pid}-${Date.now()}`;
        fs.writeFileSync(temporary, text, 'utf8');
        staged.push({ key, destination, temporary });
      }
      for (const entry of staged) fs.renameSync(entry.temporary, entry.destination);
    } catch (error) {
      for (const entry of staged) try { fs.unlinkSync(entry.temporary); } catch { /* best effort */ }
      return { error: `profile restore failed before activation: ${error.message}` };
    }
    this.index.activeProfileId = target.id;
    this.index.audit ??= [];
    this.index.audit.push({ at: Date.now(), actor: String(actor ?? 'admin'), action: 'restore',
      profileId: target.id, preservedProfileId: preserved.profileId, files: staged.map((entry) => entry.key) });
    this._save();
    return { ok: true, restored: staged.length, activeProfileId: target.id,
      preservedProfileId: preserved.profileId, state: this.state() };
  }

  remove(profileId, { actor } = {}) {
    this.ensure();
    const id = String(profileId);
    if (id === DEFAULT_ID) return { error: 'factory defaults cannot be deleted' };
    if (id === this.index.activeProfileId) return { error: 'the active profile cannot be deleted' };
    if (!this.index.profiles[id]) return { error: 'profile not found' };
    delete this.index.profiles[id];
    this.index.audit ??= [];
    this.index.audit.push({ at: Date.now(), actor: String(actor ?? 'admin'), action: 'delete', profileId: id });
    this._save();
    return { ok: true, state: this.state() };
  }

  export(profileId) {
    this.ensure();
    const profile = this.index.profiles[String(profileId)];
    if (!profile) return { error: 'profile not found' };
    const files = {};
    for (const [key, hash] of Object.entries(profile.files ?? {})) {
      files[key] = JSON.parse(fs.readFileSync(this._objectFile(hash), 'utf8'));
    }
    return {
      format: 'nodeuo.content-profile', schemaVersion: 1, exportedAt: Date.now(),
      profile: publicProfile(profile, this.index.profiles[DEFAULT_ID]), files,
    };
  }

  state() {
    this.ensure();
    const baseline = this.index.profiles[DEFAULT_ID];
    const profiles = Object.values(this.index.profiles)
      .map((profile) => publicProfile(profile, baseline))
      .sort((a, b) => Number(b.locked) - Number(a.locked) || b.updatedAt - a.updatedAt);
    return {
      schemaVersion: SCHEMA_VERSION,
      root: this.root,
      defaultProfileId: DEFAULT_ID,
      activeProfileId: this.index.activeProfileId,
      profiles,
    };
  }
}
