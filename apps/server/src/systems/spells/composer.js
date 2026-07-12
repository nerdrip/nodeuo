import fs from 'node:fs';
import path from 'node:path';
import {
  extNodeUOSpellComposer,
  NodeUOCapability,
  NodeUOSpellComposerMessage,
} from '@uo/protocol';

export const SPELL_COMPOSER_CATALOG = Object.freeze({
  schools: ['magery', 'necromancy', 'chivalry', 'mysticism', 'spellweaving', 'custom'],
  targets: ['self', 'mobile', 'location'],
  areaShapes: ['single', 'circle', 'cone', 'line'],
  effects: [
    { id: 'damage', label: 'Damage', fields: ['amount', 'element'] },
    { id: 'heal', label: 'Heal', fields: ['amount'] },
    { id: 'buff', label: 'Buff', fields: ['amount', 'durationMs'] },
    { id: 'visual', label: 'Visual only', fields: ['graphic', 'hue'] },
  ],
  elements: ['physical', 'fire', 'cold', 'poison', 'energy'],
  sequenceKinds: ['visual', 'sound'],
  limits: { mana: [0, 100], range: [0, 18], castTimeMs: [0, 10_000], cooldownMs: [0, 600_000] },
});

function clampInt(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function spellIdFromName(name) {
  return `custom:${name.toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)}`;
}

/** Validate and strip a client-authored draft. No functions/source code are accepted. */
export function validateSpellDraft(raw) {
  const errors = [];
  const name = String(raw?.name ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 3 || name.length > 40) errors.push('Name must contain 3–40 characters.');
  const school = String(raw?.school ?? 'custom').toLowerCase();
  if (!SPELL_COMPOSER_CATALOG.schools.includes(school)) errors.push('Unknown school.');
  const target = String(raw?.target ?? 'mobile').toLowerCase();
  if (!SPELL_COMPOSER_CATALOG.targets.includes(target)) errors.push('Unknown target type.');
  const effectType = String(raw?.effect?.type ?? 'damage').toLowerCase();
  if (!SPELL_COMPOSER_CATALOG.effects.some((effect) => effect.id === effectType)) {
    errors.push('Unknown effect type.');
  }
  const element = String(raw?.effect?.element ?? 'physical').toLowerCase();
  if (!SPELL_COMPOSER_CATALOG.elements.includes(element)) errors.push('Unknown damage element.');
  const areaShape = String(raw?.area?.shape ?? 'single').toLowerCase();
  if (!SPELL_COMPOSER_CATALOG.areaShapes.includes(areaShape)) errors.push('Unknown area shape.');
  if (errors.length) return { ok: false, errors };

  const sequence = [];
  const rawSequence = Array.isArray(raw?.sequence) ? raw.sequence : [];
  if (rawSequence.length > 16) return { ok: false, errors: ['Effect sequence may contain at most 16 cues.'] };
  for (const cue of rawSequence) {
    const kind = String(cue?.kind ?? '').toLowerCase();
    if (!SPELL_COMPOSER_CATALOG.sequenceKinds.includes(kind)) {
      return { ok: false, errors: [`Unknown sequence cue: ${kind || '(empty)'}.`] };
    }
    sequence.push({
      atMs: clampInt(cue?.atMs, 0, 60_000),
      kind,
      graphic: kind === 'visual' ? clampInt(cue?.graphic, 0, 0xffff) : 0,
      sound: kind === 'sound' ? clampInt(cue?.sound, 0, 0xffff) : 0,
      hue: kind === 'visual' ? clampInt(cue?.hue, 0, 0xffff) : 0,
    });
  }
  sequence.sort((a, b) => a.atMs - b.atMs);

  const draft = {
    id: spellIdFromName(name),
    name,
    school,
    target,
    mana: clampInt(raw?.mana, 0, 100),
    range: clampInt(raw?.range, 0, 18),
    castTimeMs: clampInt(raw?.castTimeMs, 0, 10_000),
    cooldownMs: clampInt(raw?.cooldownMs, 0, 600_000),
    effect: {
      type: effectType,
      amount: clampInt(raw?.effect?.amount, 0, 1000),
      durationMs: clampInt(raw?.effect?.durationMs, 0, 600_000),
      element,
      graphic: clampInt(raw?.effect?.graphic, 0, 0xffff),
      hue: clampInt(raw?.effect?.hue, 0, 0xffff),
    },
    area: {
      shape: areaShape,
      radius: areaShape === 'single' ? 0 : clampInt(raw?.area?.radius, 1, 12),
      angle: areaShape === 'cone' ? clampInt(raw?.area?.angle, 15, 180) : 0,
    },
    sequence,
    updatedAt: new Date().toISOString(),
  };
  return { ok: true, draft };
}

export function validateSpellForPublication(raw) {
  const base = validateSpellDraft(raw);
  if (!base.ok) return base;
  const draft = base.draft;
  const errors = [];
  const areaFactor = draft.area.shape === 'single' ? 1
    : draft.area.shape === 'line' ? Math.max(1, draft.area.radius * 0.7)
      : draft.area.shape === 'cone' ? Math.max(1, draft.area.radius * draft.area.radius * 0.35)
        : Math.max(1, draft.area.radius * draft.area.radius * 0.55);
  const mechanicalAmount = ['damage', 'heal', 'buff'].includes(draft.effect.type)
    ? draft.effect.amount : 0;
  const impact = mechanicalAmount * areaFactor;
  const requiredMana = Math.min(100, Math.ceil(Math.sqrt(impact) * 1.8));
  const requiredRecovery = Math.min(10_000, Math.ceil(impact * 8));
  if (draft.effect.type === 'damage' && draft.effect.amount > 150) errors.push('Published damage is capped at 150.');
  if (draft.effect.type === 'heal' && draft.effect.amount > 100) errors.push('Published healing is capped at 100.');
  if (draft.mana < requiredMana) errors.push(`Mana is too low for this footprint (minimum ${requiredMana}).`);
  if (draft.castTimeMs + draft.cooldownMs < requiredRecovery) {
    errors.push(`Cast time plus cooldown is too short (minimum ${requiredRecovery} ms).`);
  }
  const lastCue = draft.sequence.at(-1)?.atMs ?? 0;
  if (lastCue > draft.castTimeMs + 10_000) errors.push('Effect timeline extends too far beyond cast completion.');
  return errors.length ? { ok: false, errors } : { ok: true, draft };
}

export class SpellComposerService {
  constructor(saveDir) {
    this.file = path.join(saveDir, 'custom-spells.json');
    this.drafts = new Map();
    this._nextRequestId = 1;
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const raw of parsed?.spells ?? []) {
        const result = validateSpellDraft(raw);
        if (result.ok) this.drafts.set(result.draft.id, {
          ...result.draft,
          published: raw.published === true,
          publishedAt: raw.publishedAt ?? null,
          updatedAt: raw.updatedAt ?? result.draft.updatedAt,
        });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn(`[spell-composer] load failed: ${error.message}`);
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, spells: [...this.drafts.values()] }, null, 2));
    fs.renameSync(temporary, this.file);
  }

  open(state) {
    if (!state?.supportsNodeUO?.(NodeUOCapability.SpellComposer)) return false;
    const requestId = this._nextRequestId++ >>> 0;
    state.send(extNodeUOSpellComposer({
      kind: NodeUOSpellComposerMessage.Open,
      requestId,
      payload: { catalog: SPELL_COMPOSER_CATALOG, drafts: [...this.drafts.values()] },
    }));
    return true;
  }

  acceptDraft(state, requestId, payload) {
    const result = validateSpellDraft(payload);
    if (result.ok) {
      result.draft.published = false;
      result.draft.publishedAt = null;
      this.drafts.set(result.draft.id, result.draft);
      this.save();
    }
    state.send(extNodeUOSpellComposer({
      kind: NodeUOSpellComposerMessage.Result,
      requestId,
      payload: result.ok
        ? { ok: true, draft: result.draft }
        : { ok: false, errors: result.errors },
    }));
    return result;
  }

  publishDraft(state, requestId, payload) {
    const result = validateSpellForPublication(payload);
    if (result.ok) {
      result.draft.published = true;
      result.draft.publishedAt = new Date().toISOString();
      this.drafts.set(result.draft.id, result.draft);
      this.save();
    }
    state.send(extNodeUOSpellComposer({
      kind: NodeUOSpellComposerMessage.Result,
      requestId,
      payload: result.ok
        ? { ok: true, published: true, draft: result.draft }
        : { ok: false, published: false, errors: result.errors },
    }));
    return result;
  }
}
