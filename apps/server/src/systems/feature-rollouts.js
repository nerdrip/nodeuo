import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STAGES = new Set(['off', 'canary', 'on']);

function safeRules(input = {}, known = null) {
  const rules = {};
  for (const [id, raw] of Object.entries(input ?? {}).slice(0, 512)) {
    if (!/^[a-z0-9][a-z0-9._/-]{0,127}$/i.test(id) || (known && !known.has(id))) continue;
    const stage = STAGES.has(raw?.stage) ? raw.stage : 'on';
    rules[id] = {
      stage,
      percentage: Math.max(0, Math.min(100, Number(raw?.percentage) || (stage === 'canary' ? 5 : 100))),
      minimumSamples: Math.max(10, Math.min(10_000, Number(raw?.minimumSamples) | 0 || 50)),
      maxErrorRate: Math.max(0.001, Math.min(1, Number(raw?.maxErrorRate) || 0.1)),
    };
  }
  return rules;
}

function atomicJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  try { fs.renameSync(temporary, file); }
  catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
}

/** Draft/validate/canary/publish/monitor/rollback with immediate kill switches. */
export class FeatureRolloutController {
  constructor(file, { knownFeatures = [] } = {}) {
    this.file = path.resolve(file);
    this.known = new Set(knownFeatures);
    this.state = { schema: 1, revision: 1, active: {}, draft: null, history: [], killSwitches: {} };
    this.health = new Map();
    try {
      const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.state = { ...this.state, ...loaded, active: safeRules(loaded.active, this.known),
        draft: loaded.draft ? safeRules(loaded.draft, this.known) : null };
    } catch (error) { if (error.code !== 'ENOENT') console.warn(`[feature-rollouts] ${error.message}`); }
  }

  _save() { atomicJson(this.file, this.state); }

  allowed(peer, feature, now = Date.now()) {
    const id = String(feature);
    const killedUntil = Number(this.state.killSwitches?.[id]) || 0;
    if (killedUntil > now || killedUntil === -1) return false;
    const rule = this.state.active[id];
    if (!rule || rule.stage === 'on') return true;
    if (rule.stage === 'off') return false;
    const identity = `${peer?.accountName ?? peer?.remoteAddress ?? peer?.id ?? 'anonymous'}:${id}`;
    const bucket = crypto.createHash('sha256').update(identity).digest().readUInt32BE(0) / 0x1_0000_0000 * 100;
    return bucket < rule.percentage;
  }

  draft(rules) {
    const checked = this.validate(rules);
    if (!checked.ok) return checked;
    this.state.draft = checked.rules;
    this._save();
    return { ...checked, revision: this.state.revision };
  }

  validate(rules = this.state.draft) {
    if (!rules) return { ok: false, errors: ['no rollout draft'] };
    const normalized = safeRules(rules, this.known);
    const unknown = Object.keys(rules).filter((id) => this.known.size && !this.known.has(id));
    return { ok: unknown.length === 0, errors: unknown.map((id) => `unknown feature ${id}`), rules: normalized };
  }

  publish(expectedRevision) {
    if (Number(expectedRevision) !== this.state.revision) return { ok: false, conflict: true, revision: this.state.revision };
    const checked = this.validate();
    if (!checked.ok) return checked;
    this.state.history.push({ revision: this.state.revision, at: Date.now(), active: this.state.active });
    this.state.history = this.state.history.slice(-20);
    this.state.active = checked.rules;
    this.state.draft = null;
    this.state.revision++;
    this._save();
    return { ok: true, ...this.snapshot() };
  }

  rollback(expectedRevision) {
    if (Number(expectedRevision) !== this.state.revision) return { ok: false, conflict: true, revision: this.state.revision };
    const previous = this.state.history.pop();
    if (!previous) return { ok: false, error: 'no rollout revision to restore' };
    this.state.active = previous.active;
    this.state.draft = null;
    this.state.revision++;
    this._save();
    return { ok: true, ...this.snapshot() };
  }

  kill(feature, { durationMs = 0 } = {}) {
    const id = String(feature);
    if (this.known.size && !this.known.has(id)) return { ok: false, error: 'unknown feature' };
    this.state.killSwitches[id] = durationMs > 0 ? Date.now() + Math.min(7 * 24 * 60 * 60_000, durationMs) : -1;
    this._save();
    return { ok: true, feature: id, until: this.state.killSwitches[id] };
  }

  revive(feature) {
    delete this.state.killSwitches[String(feature)];
    this._save();
    return { ok: true, feature: String(feature) };
  }

  observe(feature, ok, now = Date.now()) {
    const id = String(feature);
    let row = this.health.get(id);
    if (!row || now - row.since > 60_000) this.health.set(id, row = { since: now, ok: 0, errors: 0, tripped: 0 });
    if (ok) row.ok++; else row.errors++;
    const rule = this.state.active[id];
    const total = row.ok + row.errors;
    if (rule && total >= rule.minimumSamples && row.errors / total > rule.maxErrorRate) {
      this.state.killSwitches[id] = now + 5 * 60_000;
      row.tripped++;
      row.since = now; row.ok = 0; row.errors = 0;
      this._save();
      return false;
    }
    return true;
  }

  snapshot() {
    const now = Date.now();
    return structuredClone({ ...this.state,
      killSwitches: Object.fromEntries(Object.entries(this.state.killSwitches)
        .filter(([, until]) => until === -1 || until > now)),
      health: Object.fromEntries(this.health),
    });
  }
}
