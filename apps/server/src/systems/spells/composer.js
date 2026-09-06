import fs from 'node:fs';
import path from 'node:path';
import {
  EffectKind, healthUpdate, huedEffect, playSound, removeEntity, containerContentUpdate,
  worldItemSA,
} from '@uo/protocol';
import { NodeUOFeature, NodeUOSpellComposerMessage } from '@uo/nodeuo-protocol';
import { sendNodeUOEvent } from '../../net/handlers/nodeuo-modern.js';
import { getSpell, registerSpell, unregisterSpell } from './registry.js';
import { containerChildrenRecursive, destroyItem } from '../../world/items.js';

const MAX_DRAFTS = 2048;
const MAX_NODES = 64;
const MAX_EDGES = 128;
const MAX_EXECUTED_TARGETS = 8192;
const MAX_SCHEMA_RANGE = 1024;
const MAX_SCHEMA_RADIUS = 1024;
const CUSTOM_SPELL_ID_MIN = 10_000;
const CUSTOM_SPELL_ID_MAX = 19_999;
const INSCRIPTION_SKILL_ID = 24;
const PRACTICE_XP_COOLDOWN_MS = 60_000;
const AUTHORING_SESSION_MS = 30 * 60_000;

const NODE_TYPES = Object.freeze([
  { id: 'start', label: 'Start', category: 'flow', inputs: [], outputs: ['flow'], requiredRank: 1 },
  { id: 'damage', label: 'Damage', category: 'effect', inputs: ['flow'], outputs: ['flow'], requiredRank: 1 },
  { id: 'heal', label: 'Heal', category: 'effect', inputs: ['flow'], outputs: ['flow'], requiredRank: 2, unlock: 'node:heal' },
  { id: 'mana', label: 'Restore mana', category: 'effect', inputs: ['flow'], outputs: ['flow'], requiredRank: 2, unlock: 'node:mana' },
  { id: 'stamina', label: 'Restore stamina', category: 'effect', inputs: ['flow'], outputs: ['flow'], requiredRank: 2, unlock: 'node:stamina' },
  { id: 'modifier', label: 'Stat modifier', category: 'effect', inputs: ['flow'], outputs: ['flow'], requiredRank: 3, unlock: 'node:modifier' },
  { id: 'shield', label: 'Arcane shield', category: 'effect', inputs: ['flow'], outputs: ['flow'], requiredRank: 3, unlock: 'node:shield' },
  { id: 'poison', label: 'Poison', category: 'effect', inputs: ['flow'], outputs: ['flow'], requiredRank: 3, unlock: 'node:poison' },
  { id: 'cleanse', label: 'Cleanse', category: 'effect', inputs: ['flow'], outputs: ['flow'], requiredRank: 3, unlock: 'node:cleanse' },
  { id: 'time-gate', label: 'Time gate', category: 'logic', inputs: ['flow'], outputs: ['flow'], requiredRank: 4, unlock: 'node:time-gate' },
  { id: 'chance-gate', label: 'Chance gate', category: 'logic', inputs: ['flow'], outputs: ['flow'], requiredRank: 4, unlock: 'node:chance-gate' },
  { id: 'transform', label: 'Transform item', category: 'world', inputs: ['flow'], outputs: ['flow'], requiredRank: 5, unlock: 'node:transform' },
  { id: 'visual', label: 'Visual effect', category: 'presentation', inputs: ['flow'], outputs: ['flow'], requiredRank: 1 },
  { id: 'sound', label: 'Sound', category: 'presentation', inputs: ['flow'], outputs: ['flow'], requiredRank: 1 },
  { id: 'delay', label: 'Delay', category: 'flow', inputs: ['flow'], outputs: ['flow'], requiredRank: 1 },
]);

const SPELLCRAFT_RANKS = Object.freeze([
  Object.freeze({ level: 1, name: 'Initiate', xp: 0, inscription: 0,
    maxDrafts: 2, maxNodes: 6, maxEdges: 8, maxImpact: 35,
    maxDamage: 25, maxHealing: 0, maxModifier: 0, maxRadius: 0,
    maxRange: 8, maxDurationMs: 10_000 }),
  Object.freeze({ level: 2, name: 'Apprentice', xp: 75, inscription: 25,
    maxDrafts: 4, maxNodes: 10, maxEdges: 14, maxImpact: 60,
    maxDamage: 40, maxHealing: 30, maxModifier: 0, maxRadius: 0,
    maxRange: 10, maxDurationMs: 30_000 }),
  Object.freeze({ level: 3, name: 'Adept', xp: 200, inscription: 50,
    maxDrafts: 7, maxNodes: 14, maxEdges: 22, maxImpact: 90,
    maxDamage: 60, maxHealing: 50, maxModifier: 15, maxRadius: 4,
    maxRange: 12, maxDurationMs: 60_000 }),
  Object.freeze({ level: 4, name: 'Master', xp: 450, inscription: 75,
    maxDrafts: 12, maxNodes: 22, maxEdges: 38, maxImpact: 120,
    maxDamage: 80, maxHealing: 75, maxModifier: 25, maxRadius: 7,
    maxRange: 15, maxDurationMs: 120_000 }),
  Object.freeze({ level: 5, name: 'Grandmaster', xp: 900, inscription: 100,
    maxDrafts: 20, maxNodes: 40, maxEdges: 80, maxImpact: 5000,
    maxDamage: 500, maxHealing: 500, maxModifier: 100, maxRadius: 32,
    maxRange: 64, maxDurationMs: 3_600_000 }),
  Object.freeze({ level: 6, name: 'Archmage', xp: 2500, inscription: 120,
    maxDrafts: 40, maxNodes: MAX_NODES, maxEdges: MAX_EDGES, maxImpact: 50_000_000_000,
    maxDamage: 10_000, maxHealing: 10_000, maxModifier: 500, maxRadius: MAX_SCHEMA_RADIUS,
    maxRange: MAX_SCHEMA_RANGE, maxDurationMs: 7 * 24 * 60 * 60_000 }),
]);

const SPELLCRAFT_DISCOVERIES = Object.freeze({
  'node:heal': Object.freeze({ label: 'Restoration block', requiredRank: 2 }),
  'node:modifier': Object.freeze({ label: 'Alteration block', requiredRank: 3 }),
  'node:mana': Object.freeze({ label: 'Mana channel block', requiredRank: 2 }),
  'node:stamina': Object.freeze({ label: 'Vigor channel block', requiredRank: 2 }),
  'node:shield': Object.freeze({ label: 'Arcane shield block', requiredRank: 3 }),
  'node:poison': Object.freeze({ label: 'Venom block', requiredRank: 3 }),
  'node:cleanse': Object.freeze({ label: 'Purification block', requiredRank: 3 }),
  'node:time-gate': Object.freeze({ label: 'Astral clock block', requiredRank: 4 }),
  'node:chance-gate': Object.freeze({ label: 'Fate gate block', requiredRank: 4 }),
  'node:transform': Object.freeze({ label: 'World transmutation block', requiredRank: 5 }),
  'scope:area': Object.freeze({ label: 'Area shaping', requiredRank: 3 }),
  'element:fire': Object.freeze({ label: 'Fire attunement', requiredRank: 2 }),
  'element:cold': Object.freeze({ label: 'Cold attunement', requiredRank: 2 }),
  'element:poison': Object.freeze({ label: 'Poison attunement', requiredRank: 3 }),
  'element:energy': Object.freeze({ label: 'Energy attunement', requiredRank: 4 }),
});

export const SPELLCRAFT_PROGRESSION = Object.freeze({
  ranks: SPELLCRAFT_RANKS,
  discoveries: SPELLCRAFT_DISCOVERIES,
});

export const SPELL_COMPOSER_CATALOG = Object.freeze({
  graphVersion: 1,
  schools: ['magery', 'necromancy', 'chivalry', 'mysticism', 'spellweaving', 'custom'],
  targets: ['self', 'mobile', 'location'],
  areaShapes: ['single', 'circle', 'cone', 'line'],
  nodeTypes: NODE_TYPES,
  scopes: ['target', 'caster', 'area'],
  elements: ['physical', 'fire', 'cold', 'poison', 'energy'],
  modifierAttributes: ['str', 'dex', 'int', 'armor'],
  limits: {
    nodes: MAX_NODES, edges: MAX_EDGES,
    mana: [0, 10_000], range: [0, MAX_SCHEMA_RANGE], radius: [0, MAX_SCHEMA_RADIUS],
    castTimeMs: [0, 60_000], cooldownMs: [0, 7 * 24 * 60 * 60_000],
    delayMs: [0, 24 * 60 * 60_000],
  },
});

function isSpellcraftAdmin(value) {
  const access = value?.account?.accessLevel ?? value?.accessLevel;
  return access === 'Admin' || access === 'Administrator';
}

function normalizedSkill(mobile, skillId) {
  const value = Number(mobile?.skills?.[skillId] ?? mobile?.skills?.[String(skillId)] ?? 0) || 0;
  return value > 120 ? value / 10 : value;
}

function ensureSpellcraftState(mobile) {
  if (!mobile) return { version: 1, xp: 0, discoveries: [], lastPracticeAt: 0 };
  const raw = mobile.spellcraft && typeof mobile.spellcraft === 'object' ? mobile.spellcraft : {};
  const discoveries = [...new Set((Array.isArray(raw.discoveries) ? raw.discoveries : [])
    .map(String).filter((key) => SPELLCRAFT_DISCOVERIES[key]))];
  mobile.spellcraft = {
    version: 1,
    xp: clampInt(raw.xp, 0, 100_000),
    discoveries,
    lastPracticeAt: Math.max(0, Number(raw.lastPracticeAt) || 0),
  };
  return mobile.spellcraft;
}

export function getSpellcraftProfile(value) {
  const mobile = value?.mobile ?? value;
  const admin = isSpellcraftAdmin(value) || isSpellcraftAdmin(mobile?.client);
  const state = ensureSpellcraftState(mobile);
  const inscription = normalizedSkill(mobile, INSCRIPTION_SKILL_ID);
  let rank = SPELLCRAFT_RANKS[0];
  if (admin) rank = SPELLCRAFT_RANKS.at(-1);
  else {
    for (const candidate of SPELLCRAFT_RANKS) {
      if (state.xp >= candidate.xp && inscription >= candidate.inscription) rank = candidate;
    }
  }
  const discoveries = new Set(admin ? Object.keys(SPELLCRAFT_DISCOVERIES) : state.discoveries);
  const allowed = (key) => admin || (
    discoveries.has(key) && rank.level >= (SPELLCRAFT_DISCOVERIES[key]?.requiredRank ?? 1)
  );
  const nodeTypes = NODE_TYPES.filter((entry) => (
    rank.level >= entry.requiredRank && (!entry.unlock || allowed(entry.unlock))
  )).map((entry) => entry.id);
  const elements = ['physical'];
  for (const element of ['fire', 'cold', 'poison', 'energy']) {
    if (allowed(`element:${element}`)) elements.push(element);
  }
  const area = allowed('scope:area');
  const next = admin ? null : SPELLCRAFT_RANKS.find((candidate) => candidate.level > rank.level) ?? null;
  return {
    admin,
    level: rank.level,
    rank: rank.name,
    xp: state.xp,
    inscription,
    next: next ? { level: next.level, rank: next.name, xp: next.xp, inscription: next.inscription } : null,
    discoveries: [...discoveries],
    nodeTypes,
    elements,
    scopes: area ? ['target', 'caster', 'area'] : ['target', 'caster'],
    targets: area ? ['self', 'mobile', 'location'] : ['self', 'mobile'],
    areaShapes: area ? ['single', 'circle', 'cone', 'line'] : ['single'],
    limits: { ...rank },
  };
}

export function learnSpellcraft(mobile, unlock = null, xp = 0) {
  const before = getSpellcraftProfile(mobile);
  // getSpellcraftProfile normalizes the persisted shape, so take the live
  // reference afterwards rather than mutating a replaced pre-normalization object.
  const state = ensureSpellcraftState(mobile);
  const key = unlock && SPELLCRAFT_DISCOVERIES[unlock] ? String(unlock) : null;
  const discovered = !!key && !state.discoveries.includes(key);
  if (discovered) state.discoveries.push(key);
  const requestedXp = clampInt(xp, 0, 10_000);
  const gainedXp = key && !discovered ? Math.min(20, requestedXp) : requestedXp;
  state.xp = Math.min(100_000, state.xp + gainedXp);
  const after = getSpellcraftProfile(mobile);
  return {
    ok: discovered || gainedXp > 0,
    discovered,
    unlock: key,
    xpGained: gainedXp,
    leveledUp: after.level > before.level,
    profile: after,
  };
}

function awardPracticeXp(caster) {
  if (!caster || isSpellcraftAdmin(caster.client)) return null;
  const state = ensureSpellcraftState(caster);
  const now = Date.now();
  if (now - state.lastPracticeAt < PRACTICE_XP_COOLDOWN_MS) return null;
  state.lastPracticeAt = now;
  return learnSpellcraft(caster, null, 1);
}

function composerCatalog(profile) {
  return {
    ...SPELL_COMPOSER_CATALOG,
    nodeTypes: NODE_TYPES.map((entry) => ({
      ...entry,
      unlocked: profile.admin || profile.nodeTypes.includes(entry.id),
    })),
    availableElements: profile.elements,
    availableScopes: profile.scopes,
    availableTargets: profile.targets,
    availableAreaShapes: profile.areaShapes,
    limits: {
      ...SPELL_COMPOSER_CATALOG.limits,
      nodes: profile.admin ? MAX_NODES : profile.limits.maxNodes,
      edges: profile.admin ? MAX_EDGES : profile.limits.maxEdges,
      range: [0, profile.admin ? MAX_SCHEMA_RANGE : profile.limits.maxRange],
      radius: [0, profile.admin ? MAX_SCHEMA_RADIUS : profile.limits.maxRadius],
    },
  };
}

function clampInt(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function slugFromName(name) {
  const slug = name.toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return `custom:${slug || 'spell'}`;
}

function stableDraftId(rawId, name) {
  const id = String(rawId ?? '');
  return /^custom:[a-z0-9][a-z0-9-]{0,47}$/.test(id) ? id : slugFromName(name);
}

function defaultGraph() {
  return {
    version: 1,
    nodes: [
      { id: 'start', type: 'start', x: 30, y: 110, config: {} },
      { id: 'visual-1', type: 'visual', x: 230, y: 55,
        config: { scope: 'target', graphic: 0x36BD, hue: 0 } },
      { id: 'damage-1', type: 'damage', x: 430, y: 110,
        config: { scope: 'target', amount: 20, element: 'physical' } },
    ],
    edges: [
      { from: 'start', to: 'visual-1' },
      { from: 'visual-1', to: 'damage-1' },
    ],
  };
}

function legacyGraph(raw) {
  if (!raw?.effect && !Array.isArray(raw?.sequence)) return defaultGraph();
  const nodes = [{ id: 'start', type: 'start', x: 30, y: 100, config: {} }];
  const edges = [];
  let previous = 'start';
  let x = 190;
  const add = (type, config) => {
    const id = `${type}-${nodes.length}`;
    nodes.push({ id, type, x, y: 100, config });
    edges.push({ from: previous, to: id });
    previous = id;
    x += 160;
  };
  for (const cue of Array.isArray(raw.sequence) ? raw.sequence : []) {
    if ((cue.atMs | 0) > 0) add('delay', { ms: cue.atMs | 0 });
    if (cue.kind === 'visual') add('visual', {
      scope: 'target', graphic: cue.graphic, hue: cue.hue,
    });
    if (cue.kind === 'sound') add('sound', { scope: 'target', sound: cue.sound });
  }
  const effect = raw.effect ?? {};
  if (['damage', 'heal'].includes(effect.type)) add(effect.type, {
    scope: raw?.area?.shape && raw.area.shape !== 'single' ? 'area' : 'target',
    amount: effect.amount, element: effect.element,
  });
  else if (effect.type === 'buff') add('modifier', {
    scope: 'target', attribute: 'str', amount: effect.amount, durationMs: effect.durationMs,
  });
  else if (effect.type === 'visual') add('visual', {
    scope: 'target', graphic: effect.graphic, hue: effect.hue,
  });
  return { version: 1, nodes, edges };
}

function sanitizeNode(raw, index, errors) {
  const id = String(raw?.id ?? `node-${index + 1}`).trim();
  const type = String(raw?.type ?? '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) errors.push(`Node ${index + 1} has an invalid id.`);
  if (!NODE_TYPES.some((entry) => entry.id === type)) errors.push(`Node ${id || index + 1} has an unknown type.`);
  const cfg = raw?.config && typeof raw.config === 'object' ? raw.config : {};
  const scope = SPELL_COMPOSER_CATALOG.scopes.includes(String(cfg.scope)) ? String(cfg.scope) : 'target';
  let config = {};
  if (type === 'damage') config = {
    scope,
    amount: clampInt(cfg.amount, 0, 10_000),
    element: SPELL_COMPOSER_CATALOG.elements.includes(String(cfg.element)) ? String(cfg.element) : 'physical',
  };
  if (type === 'heal') config = { scope, amount: clampInt(cfg.amount, 0, 10_000) };
  if (type === 'mana' || type === 'stamina') config = {
    scope, amount: clampInt(cfg.amount, 0, 10_000),
  };
  if (type === 'modifier') config = {
    scope,
    attribute: SPELL_COMPOSER_CATALOG.modifierAttributes.includes(String(cfg.attribute))
      ? String(cfg.attribute) : 'str',
    amount: clampInt(cfg.amount, -500, 500),
    durationMs: clampInt(cfg.durationMs, 1000, 300_000),
  };
  if (type === 'shield') config = {
    scope,
    amount: clampInt(cfg.amount, 0, 500),
    durationMs: clampInt(cfg.durationMs, 1000, 7 * 24 * 60 * 60_000),
  };
  if (type === 'poison') config = {
    scope,
    amount: clampInt(cfg.amount, 1, 5),
    durationMs: clampInt(cfg.durationMs, 1000, 60 * 60_000),
  };
  if (type === 'cleanse') config = { scope };
  if (type === 'time-gate') config = {
    phase: ['day', 'night', 'dawn', 'dusk'].includes(String(cfg.phase)) ? String(cfg.phase) : 'night',
  };
  if (type === 'chance-gate') config = { chance: clampInt(cfg.chance ?? cfg.amount, 1, 100) };
  if (type === 'transform') config = {
    artId: clampInt(cfg.artId ?? cfg.graphic, 0, 0xffff),
    hue: clampInt(cfg.hue, 0, 0xffff),
  };
  if (type === 'visual') config = {
    scope,
    graphic: clampInt(cfg.graphic, 0, 0xffff),
    hue: clampInt(cfg.hue, 0, 0xffff),
  };
  if (type === 'sound') config = { scope, sound: clampInt(cfg.sound, 0, 0xffff) };
  if (type === 'delay') config = { ms: clampInt(cfg.ms, 0, 24 * 60 * 60_000) };
  return {
    id, type,
    x: clampInt(raw?.x, 0, 4000),
    y: clampInt(raw?.y, 0, 4000),
    config,
  };
}

function sanitizeGraph(rawGraph, errors) {
  if (!rawGraph || typeof rawGraph !== 'object') {
    errors.push('A spell graph is required.');
    return null;
  }
  const rawNodes = Array.isArray(rawGraph.nodes) ? rawGraph.nodes : [];
  const rawEdges = Array.isArray(rawGraph.edges) ? rawGraph.edges : [];
  if (rawNodes.length < 2 || rawNodes.length > MAX_NODES) errors.push(`A graph must contain 2–${MAX_NODES} nodes.`);
  if (rawEdges.length < 1 || rawEdges.length > MAX_EDGES) errors.push(`A graph must contain 1–${MAX_EDGES} connections.`);
  const nodes = rawNodes.slice(0, MAX_NODES).map((node, index) => sanitizeNode(node, index, errors));
  const ids = new Set();
  for (const node of nodes) {
    if (ids.has(node.id)) errors.push(`Duplicate node id: ${node.id}.`);
    ids.add(node.id);
  }
  const starts = nodes.filter((node) => node.type === 'start');
  if (starts.length !== 1) errors.push('A graph must contain exactly one Start node.');
  const edgeKeys = new Set();
  const edges = [];
  for (const raw of rawEdges.slice(0, MAX_EDGES)) {
    const from = String(raw?.from ?? '');
    const to = String(raw?.to ?? '');
    const fromPort = String(raw?.fromPort ?? 'flow');
    const toPort = String(raw?.toPort ?? 'flow');
    const key = `${from}.${fromPort}>${to}.${toPort}`;
    if (!ids.has(from) || !ids.has(to)) errors.push(`Connection ${key} references a missing node.`);
    else if (from === to) errors.push(`Node ${from} cannot connect to itself.`);
    else if (edgeKeys.has(key)) errors.push(`Duplicate connection: ${key}.`);
    else {
      const fromType = NODE_TYPES.find((entry) => entry.id === nodes.find((node) => node.id === from)?.type);
      const toType = NODE_TYPES.find((entry) => entry.id === nodes.find((node) => node.id === to)?.type);
      if (!fromType?.outputs?.includes(fromPort) || !toType?.inputs?.includes(toPort)) {
        errors.push(`Connection ${key} uses incompatible or unknown ports.`);
      } else {
        edgeKeys.add(key);
        edges.push({ from, fromPort, to, toPort });
      }
    }
  }

  if (starts.length === 1 && ids.size === nodes.length) {
    const outgoing = new Map(nodes.map((node) => [node.id, []]));
    const indegree = new Map(nodes.map((node) => [node.id, 0]));
    for (const edge of edges) {
      outgoing.get(edge.from)?.push(edge.to);
      if (indegree.has(edge.to)) indegree.set(edge.to, indegree.get(edge.to) + 1);
    }
    const reachable = new Set([starts[0].id]);
    const stack = [starts[0].id];
    while (stack.length) {
      for (const next of outgoing.get(stack.pop()) ?? []) {
        if (!reachable.has(next)) { reachable.add(next); stack.push(next); }
      }
    }
    if (reachable.size !== nodes.length) errors.push('Every node must be reachable from Start.');
    const queue = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
    let visited = 0;
    while (queue.length) {
      const id = queue.shift(); visited++;
      for (const next of outgoing.get(id) ?? []) {
        const degree = indegree.get(next) - 1;
        indegree.set(next, degree);
        if (degree === 0) queue.push(next);
      }
    }
    if (visited !== nodes.length) errors.push('Spell graphs cannot contain cycles.');
  }
  return { version: 1, nodes, edges };
}

/** Validate and strip a client-authored graph. No code/callback fields survive. */
export function validateSpellDraft(raw) {
  const errors = [];
  const name = String(raw?.name ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 3 || name.length > 40) errors.push('Name must contain 3–40 characters.');
  const school = String(raw?.school ?? 'custom').toLowerCase();
  if (!SPELL_COMPOSER_CATALOG.schools.includes(school)) errors.push('Unknown school.');
  const target = String(raw?.target ?? 'mobile').toLowerCase();
  if (!SPELL_COMPOSER_CATALOG.targets.includes(target)) errors.push('Unknown target type.');
  const areaShape = String(raw?.area?.shape ?? 'single').toLowerCase();
  if (!SPELL_COMPOSER_CATALOG.areaShapes.includes(areaShape)) errors.push('Unknown area shape.');
  if (raw?.effect?.type && !['damage', 'heal', 'buff', 'visual'].includes(String(raw.effect.type))) {
    errors.push('Unknown legacy effect type.');
  }
  const graph = sanitizeGraph(raw?.graph ?? legacyGraph(raw), errors);
  if (errors.length) return { ok: false, errors: [...new Set(errors)] };
  return {
    ok: true,
    draft: {
      id: stableDraftId(raw?.id, name),
      spellId: Number.isInteger(raw?.spellId) ? clampInt(raw.spellId, CUSTOM_SPELL_ID_MIN, CUSTOM_SPELL_ID_MAX) : null,
      name, school, target,
      mana: clampInt(raw?.mana, 0, 10_000),
      range: clampInt(raw?.range, 0, MAX_SCHEMA_RANGE),
      castTimeMs: clampInt(raw?.castTimeMs, 0, 60_000),
      cooldownMs: clampInt(raw?.cooldownMs, 0, 7 * 24 * 60 * 60_000),
      area: {
        shape: areaShape,
        radius: areaShape === 'single' ? 0 : clampInt(raw?.area?.radius, 1, MAX_SCHEMA_RADIUS),
        angle: areaShape === 'cone' ? clampInt(raw?.area?.angle, 15, 180) : 0,
      },
      graph,
      updatedAt: new Date().toISOString(),
    },
  };
}

function areaFactor(draft) {
  if (draft.area.shape === 'single') return 1;
  if (draft.area.shape === 'line') return Math.max(1, draft.area.radius * 0.7);
  if (draft.area.shape === 'cone') return Math.max(1, draft.area.radius * draft.area.radius * 0.35);
  return Math.max(1, draft.area.radius * draft.area.radius * 0.55);
}

function spellMetrics(draft) {
  let damage = 0, healing = 0, resources = 0, modifiers = 0, delays = 0;
  let maxDamage = 0, maxHealing = 0, maxModifier = 0, maxDurationMs = 0;
  for (const node of draft.graph.nodes) {
    const multiplier = node.config.scope === 'area' ? areaFactor(draft) : 1;
    if (node.type === 'damage') {
      damage += node.config.amount * multiplier;
      maxDamage = Math.max(maxDamage, node.config.amount);
    }
    if (node.type === 'heal') {
      healing += node.config.amount * multiplier;
      maxHealing = Math.max(maxHealing, node.config.amount);
    }
    if (node.type === 'mana' || node.type === 'stamina') {
      resources += node.config.amount * multiplier;
    }
    if (node.type === 'poison') {
      damage += node.config.amount * 12 * multiplier;
      maxDamage = Math.max(maxDamage, node.config.amount * 12);
      maxDurationMs = Math.max(maxDurationMs, node.config.durationMs);
    }
    if (node.type === 'shield') {
      modifiers += node.config.amount * multiplier * Math.max(1, node.config.durationMs / 10_000);
      maxModifier = Math.max(maxModifier, node.config.amount);
      maxDurationMs = Math.max(maxDurationMs, node.config.durationMs);
    }
    if (node.type === 'transform') modifiers += 250;
    if (node.type === 'modifier') {
      modifiers += Math.abs(node.config.amount) * multiplier * Math.max(1, node.config.durationMs / 10_000);
      maxModifier = Math.max(maxModifier, Math.abs(node.config.amount));
      maxDurationMs = Math.max(maxDurationMs, node.config.durationMs);
    }
    if (node.type === 'delay') delays += node.config.ms;
  }
  return {
    damage, healing, resources, modifiers, delays,
    impact: damage + healing * 0.8 + resources * 0.55 + modifiers * 0.7,
    maxDamage, maxHealing, maxModifier, maxDurationMs,
  };
}

const SCHEMA_MATERIALS = Object.freeze({
  blank: Object.freeze({ definitionId: 'blank-scroll', artId: 0x0E34, name: 'blank scroll' }),
  ruby: Object.freeze({ definitionId: 'ruby', artId: 4217, name: 'ruby' }),
  focus: Object.freeze({ definitionId: 'reagent-black-pearl', artId: 3962, name: 'black pearl' }),
  fire: Object.freeze({ definitionId: 'reagent-sulfurous-ash', artId: 3980, name: 'sulfurous ash' }),
  cold: Object.freeze({ definitionId: 'reagent-mandrake', artId: 3974, name: 'mandrake root' }),
  poison: Object.freeze({ definitionId: 'reagent-nightshade', artId: 3976, name: 'nightshade' }),
  energy: Object.freeze({ definitionId: 'reagent-spider-silk', artId: 3981, name: "spiders' silk" }),
});

/** Physical bill paid when a published program is written to a scroll.
 *  Small utility schemas need only parchment. Large/area/logic programs
 *  scale into substantial gem and reagent costs instead of being rejected
 *  by a small arbitrary damage cap. */
export function schemaScribingRequirements(draft) {
  const metrics = spellMetrics(draft);
  const requirements = [{ ...SCHEMA_MATERIALS.blank, amount: 1 }];
  const scale = Math.floor(Math.max(0, metrics.impact - 50) / 100);
  if (scale > 0) requirements.push({ ...SCHEMA_MATERIALS.ruby, amount: Math.min(9999, scale) });
  const logic = draft.graph.nodes.filter((node) => node.type.endsWith('-gate')).length;
  if (logic) requirements.push({ ...SCHEMA_MATERIALS.focus, amount: logic });
  const elementalDamage = new Map();
  for (const node of draft.graph.nodes) {
    if (node.type !== 'damage' || node.config.element === 'physical') continue;
    const footprint = node.config.amount * (node.config.scope === 'area' ? areaFactor(draft) : 1);
    elementalDamage.set(node.config.element,
      (elementalDamage.get(node.config.element) ?? 0) + footprint);
  }
  for (const [element, footprint] of elementalDamage) {
    const material = SCHEMA_MATERIALS[element];
    if (material) requirements.push({ ...material, amount: Math.min(9999, Math.max(1, Math.ceil(footprint / 100))) });
  }
  return requirements;
}

export function validateSpellForPublication(raw) {
  const base = validateSpellDraft(raw);
  if (!base.ok) return base;
  const draft = base.draft;
  const errors = [];
  const { damage, healing, delays, impact } = spellMetrics(draft);
  const complexity = draft.graph.nodes.filter((node) => node.type !== 'start').length;
  const requiredMana = Math.min(10_000, Math.ceil(Math.sqrt(impact) * 2 + complexity));
  // Even cue-only graphs need a small recovery gate; otherwise a zero-mana
  // visual/sound schema can be packet-spammed into a broadcast flood.
  const requiredRecovery = Math.min(7 * 24 * 60 * 60_000,
    Math.max(250, Math.ceil(Math.sqrt(impact) * 90 + complexity * 40)));
  // Power is governed by resources, not an arbitrary low damage ceiling.
  // A city-scale graph is legal, but its mana/recovery/material bill grows
  // with the complete affected footprint and the executor remains bounded.
  if (draft.mana < requiredMana) {
    const footprint = damage > 150 ? 'damage footprint' : healing > 100 ? 'healing footprint' : 'graph';
    errors.push(`The ${footprint} requires at least ${requiredMana} mana.`);
  }
  if (draft.castTimeMs + draft.cooldownMs < requiredRecovery) errors.push(`Cast time plus cooldown is too short (minimum ${requiredRecovery} ms).`);
  if (delays > 24 * 60 * 60_000) errors.push('The graph contains more than 24 hours of delay.');
  if (draft.target === 'location' && draft.area.shape === 'single'
      && draft.graph.nodes.some((node) => ['damage', 'heal', 'modifier'].includes(node.type))) {
    errors.push('Location-targeted mechanical spells require an area shape.');
  }
  if (draft.area.shape === 'single'
      && draft.graph.nodes.some((node) => node.config.scope === 'area')) {
    errors.push('Area-scoped nodes require a non-single area shape.');
  }
  return errors.length ? { ok: false, errors } : { ok: true, draft };
}

function progressionErrors(draft, profile) {
  if (profile.admin) return [];
  const errors = [];
  const limits = profile.limits;
  if (draft.graph.nodes.length > limits.maxNodes) errors.push(`${profile.rank} permits at most ${limits.maxNodes} blocks.`);
  if (draft.graph.edges.length > limits.maxEdges) errors.push(`${profile.rank} permits at most ${limits.maxEdges} connections.`);
  if (draft.range > limits.maxRange) errors.push(`${profile.rank} permits range ${limits.maxRange} or lower.`);
  if (!profile.targets.includes(draft.target)) errors.push(`Target mode ${draft.target} has not been unlocked.`);
  if (!profile.areaShapes.includes(draft.area.shape)) errors.push(`Area shape ${draft.area.shape} has not been unlocked.`);
  if (draft.area.radius > limits.maxRadius) errors.push(`${profile.rank} permits area radius ${limits.maxRadius} or lower.`);
  for (const node of draft.graph.nodes) {
    if (!profile.nodeTypes.includes(node.type)) errors.push(`Block ${node.type} has not been unlocked.`);
    if (node.config.scope && !profile.scopes.includes(node.config.scope)) {
      errors.push(`Scope ${node.config.scope} has not been unlocked.`);
    }
    if (node.type === 'damage' && !profile.elements.includes(node.config.element)) {
      errors.push(`Element ${node.config.element} has not been unlocked.`);
    }
  }
  const metrics = spellMetrics(draft);
  if (metrics.impact > limits.maxImpact) errors.push(`${profile.rank} permits a power footprint of ${limits.maxImpact} or lower.`);
  if (metrics.maxDamage > limits.maxDamage) errors.push(`${profile.rank} permits at most ${limits.maxDamage} damage per block.`);
  if (metrics.maxHealing > limits.maxHealing) errors.push(`${profile.rank} permits at most ${limits.maxHealing} healing per block.`);
  if (metrics.maxModifier > limits.maxModifier) errors.push(`${profile.rank} permits stat modifiers up to ${limits.maxModifier}.`);
  if (metrics.maxDurationMs > limits.maxDurationMs) errors.push(`${profile.rank} permits modifier duration up to ${limits.maxDurationMs} ms.`);
  return [...new Set(errors)];
}

function requiredRankForDraft(draft) {
  const metrics = spellMetrics(draft);
  let featureLevel = 1;
  for (const node of draft.graph.nodes) {
    const descriptor = NODE_TYPES.find((entry) => entry.id === node.type);
    featureLevel = Math.max(featureLevel, descriptor?.requiredRank ?? 1);
  }
  if (draft.area.shape !== 'single' || draft.target === 'location'
      || draft.graph.nodes.some((node) => node.config.scope === 'area')) featureLevel = Math.max(featureLevel, 3);
  for (const node of draft.graph.nodes) {
    if (node.type !== 'damage') continue;
    if (node.config.element === 'fire' || node.config.element === 'cold') featureLevel = Math.max(featureLevel, 2);
    if (node.config.element === 'poison') featureLevel = Math.max(featureLevel, 3);
    if (node.config.element === 'energy') featureLevel = Math.max(featureLevel, 4);
  }
  let numericLevel = SPELLCRAFT_RANKS.at(-1).level;
  for (const rank of SPELLCRAFT_RANKS) {
    if (draft.graph.nodes.length <= rank.maxNodes && draft.graph.edges.length <= rank.maxEdges
        && draft.range <= rank.maxRange && draft.area.radius <= rank.maxRadius
        && metrics.impact <= rank.maxImpact && metrics.maxDamage <= rank.maxDamage
        && metrics.maxHealing <= rank.maxHealing && metrics.maxModifier <= rank.maxModifier
        && metrics.maxDurationMs <= rank.maxDurationMs) {
      numericLevel = rank.level;
      break;
    }
  }
  return Math.min(SPELLCRAFT_RANKS.length, Math.max(featureLevel, numericLevel));
}

function pointOf(value, fallback) {
  return {
    x: value?.x ?? fallback?.x ?? 0, y: value?.y ?? fallback?.y ?? 0,
    z: value?.z ?? fallback?.z ?? 0, map: value?.map ?? fallback?.map ?? 1,
  };
}

function mobilesNear(world, center, range) {
  const out = [];
  const serials = world?.sectors?.mobileSerialsNear
    ? world.sectors.mobileSerialsNear(center.map | 0, center.x | 0, center.y | 0, range)
    : world?.mobiles?.keys?.() ?? [];
  for (const serial of serials) {
    const mob = world.mobiles.get(serial);
    if (!mob || mob.map !== center.map || (mob.hp ?? 0) <= 0) continue;
    if (Math.max(Math.abs(mob.x - center.x), Math.abs(mob.y - center.y)) > range) continue;
    out.push(mob);
    if (out.length >= MAX_EXECUTED_TARGETS) break;
  }
  return out;
}

function targetsFor(node, draft, ctx) {
  if (node.config.scope === 'caster') return [ctx.caster];
  const target = ctx.target?.serial ? ctx.world.mobiles.get(ctx.target.serial >>> 0) : null;
  if (node.config.scope !== 'area') return [target ?? (draft.target === 'self' ? ctx.caster : null)].filter(Boolean);
  const center = pointOf(ctx.target, ctx.caster);
  const range = draft.area.radius || 1;
  let targets = mobilesNear(ctx.world, center, range);
  if (draft.area.shape === 'line') {
    const dx = Math.sign(center.x - ctx.caster.x), dy = Math.sign(center.y - ctx.caster.y);
    targets = targets.filter((mob) => Math.abs((mob.x - ctx.caster.x) * dy - (mob.y - ctx.caster.y) * dx) <= 1);
  } else if (draft.area.shape === 'cone') {
    const ax = center.x - ctx.caster.x, ay = center.y - ctx.caster.y;
    const al = Math.hypot(ax, ay) || 1;
    const cosMin = Math.cos((draft.area.angle * Math.PI / 180) / 2);
    targets = targets.filter((mob) => {
      const bx = mob.x - ctx.caster.x, by = mob.y - ctx.caster.y;
      const bl = Math.hypot(bx, by) || 1;
      return (ax * bx + ay * by) / (al * bl) >= cosMin;
    });
  }
  return targets.slice(0, MAX_EXECUTED_TARGETS);
}

function sendNear(world, center, packet, range = 18) {
  for (const mob of mobilesNear(world, center, range)) mob.client?.send?.(packet);
}

function runGraphNode(draft, node, ctx) {
  const targets = targetsFor(node, draft, ctx);
  if (node.type === 'damage') {
    for (const target of targets) ctx.deps?.damage?.(ctx.world, target, node.config.amount, {
      attacker: ctx.caster, damageType: { [node.config.element]: 100 },
    });
  } else if (node.type === 'heal') {
    for (const target of targets) {
      target.hp = Math.min(target.hpMax ?? target.hp ?? 1, (target.hp ?? 0) + node.config.amount);
      sendNear(ctx.world, target, healthUpdate({ serial: target.serial, current: target.hp, max: target.hpMax ?? target.hp }));
    }
  } else if (node.type === 'mana' || node.type === 'stamina') {
    const key = node.type === 'mana' ? 'mana' : 'stam';
    const maxKey = node.type === 'mana' ? 'manaMax' : 'stamMax';
    for (const target of targets) {
      target[key] = Math.min(target[maxKey] ?? target[key] ?? 0,
        (target[key] ?? 0) + node.config.amount);
    }
  } else if (node.type === 'modifier') {
    for (const target of targets) {
      const attribute = node.config.attribute;
      const amount = node.config.amount;
      target[attribute] = (target[attribute] ?? 0) + amount;
      const applied = ctx.deps?.statusEffects?.apply?.(target, {
        name: `${draft.id}:${node.id}`, durationMs: node.config.durationMs,
        data: { attribute, amount },
        onRemove(mob) { mob[attribute] = (mob[attribute] ?? 0) - amount; },
      });
      // Tests and lightweight embedding may omit the shared status manager.
      // Never leave a permanent stat mutation in that case.
      if (!applied) {
        const serial = target.serial >>> 0;
        const timer = setTimeout(() => {
          const current = ctx.world?.mobiles?.get?.(serial);
          if (current) current[attribute] = (current[attribute] ?? 0) - amount;
        }, node.config.durationMs);
        timer.unref?.();
      }
    }
  } else if (node.type === 'shield') {
    for (const target of targets) {
      const amount = node.config.amount;
      target.armor = (target.armor ?? 0) + amount;
      const remove = (mob) => { mob.armor = Math.max(0, (mob.armor ?? 0) - amount); };
      const applied = ctx.deps?.statusEffects?.apply?.(target, {
        name: `${draft.id}:${node.id}`, durationMs: node.config.durationMs,
        data: { attribute: 'armor', amount }, onRemove: remove,
      });
      if (!applied) {
        const serial = target.serial >>> 0;
        const timer = setTimeout(() => {
          const current = ctx.world?.mobiles?.get?.(serial);
          if (current) remove(current);
        }, node.config.durationMs);
        timer.unref?.();
      }
    }
  } else if (node.type === 'poison') {
    for (const target of targets) {
      target.poisoned = true;
      target.poisonLevel = Math.max(target.poisonLevel ?? 0, node.config.amount);
      const serial = target.serial >>> 0;
      const timer = setTimeout(() => {
        const current = ctx.world?.mobiles?.get?.(serial);
        if (current) { current.poisoned = false; current.poisonLevel = 0; }
      }, node.config.durationMs);
      timer.unref?.();
    }
  } else if (node.type === 'cleanse') {
    for (const target of targets) {
      target.poisoned = false;
      target.poisonLevel = 0;
    }
  } else if (node.type === 'transform') {
    // World mutation deliberately targets one explicitly selected item. Area
    // transmutation would let a house automation rewrite a neighbour's
    // decorations and is therefore not inferred from the graph area scope.
    const item = ctx.target?.serial
      ? ctx.world?.items?.get?.(ctx.target.serial >>> 0)
      : (ctx.target?.itemId != null ? ctx.target : null);
    if (item && item.parent == null) {
      item.artId = node.config.artId;
      item.itemId = node.config.artId;
      item.hue = node.config.hue;
      const packet = worldItemSA({
        serial: item.serial, itemId: item.itemId, amount: item.amount ?? 1,
        x: item.x, y: item.y, z: item.z, hue: item.hue,
        flags: (item.movable ?? true) ? 0x20 : 0,
      });
      sendNear(ctx.world, item, packet);
    }
  } else if (node.type === 'visual') {
    const visualTargets = targets.length ? targets : [pointOf(ctx.target, ctx.caster)];
    for (const target of visualTargets) {
      const point = pointOf(target, ctx.caster);
      sendNear(ctx.world, point, huedEffect({
        kind: target?.serial ? EffectKind.FromSource : EffectKind.Stationary,
        from: target?.serial ?? 0, to: target?.serial ?? 0,
        itemId: node.config.graphic,
        fromX: point.x, fromY: point.y, fromZ: point.z,
        toX: point.x, toY: point.y, toZ: point.z,
        speed: 10, duration: 15, hue: node.config.hue,
      }));
    }
  } else if (node.type === 'sound') {
    const centers = targets.length ? targets : [pointOf(ctx.target, ctx.caster)];
    for (const center of centers) sendNear(ctx.world, center, playSound({
      soundId: node.config.sound, volume: 0xff, x: center.x, y: center.y, z: center.z,
    }));
  }
}

/** Execute an already validated acyclic graph with bounded, unref'd timers. */
export function executeSpellGraph(draft, ctx) {
  const nodes = new Map(draft.graph.nodes.map((node) => [node.id, node]));
  const incoming = new Map(draft.graph.nodes.map((node) => [node.id, []]));
  const outgoing = new Map(draft.graph.nodes.map((node) => [node.id, []]));
  for (const edge of draft.graph.edges) {
    incoming.get(edge.to).push(edge.from);
    outgoing.get(edge.from).push(edge.to);
  }
  const queue = draft.graph.nodes.filter((node) => incoming.get(node.id).length === 0).map((node) => node.id);
  const at = new Map(queue.map((id) => [id, 0]));
  const enabled = new Map(queue.map((id) => [id, true]));
  while (queue.length) {
    const id = queue.shift();
    const node = nodes.get(id);
    const ownAt = at.get(id) ?? 0;
    const after = ownAt + (node.type === 'delay' ? node.config.ms : 0);
    const active = enabled.get(id) !== false;
    let branchOpen = active;
    if (active && node.type === 'time-gate') {
      const hour = Number(ctx.gameHour ?? ctx.deps?.gameHour?.()
        ?? ctx.world?.gameTime?.hour ?? new Date().getUTCHours()) | 0;
      const phase = node.config.phase;
      branchOpen = phase === 'day' ? hour >= 6 && hour < 18
        : phase === 'night' ? hour < 6 || hour >= 18
          : phase === 'dawn' ? hour >= 5 && hour < 8
            : hour >= 17 && hour < 20;
    } else if (active && node.type === 'chance-gate') {
      branchOpen = Math.random() * 100 < node.config.chance;
    }
    if (active && !['start', 'delay', 'time-gate', 'chance-gate'].includes(node.type)) {
      const invoke = () => {
        const caster = ctx.world?.mobiles?.get?.(ctx.caster.serial >>> 0);
        if (!caster || (caster.hp ?? 0) <= 0) return;
        const target = ctx.target?.serial
          ? ctx.world.mobiles.get(ctx.target.serial >>> 0) ?? ctx.world.items?.get?.(ctx.target.serial >>> 0)
          : ctx.target;
        runGraphNode(draft, node, { ...ctx, caster, target });
      };
      if (ownAt > 0) {
        const timer = setTimeout(invoke, ownAt);
        timer.unref?.();
      } else invoke();
    }
    for (const next of outgoing.get(id)) {
      at.set(next, Math.max(at.get(next) ?? 0, after));
      enabled.set(next, (enabled.get(next) ?? false) || branchOpen);
      incoming.set(next, incoming.get(next).filter((source) => source !== id));
      if (incoming.get(next).length === 0) queue.push(next);
    }
  }
}

function spellDefinition(draft) {
  const mechanical = draft.graph.nodes.reduce((sum, node) => (
    sum + (['damage', 'heal'].includes(node.type) ? node.config.amount : 0)
  ), 0);
  return {
    id: draft.spellId, name: draft.name, school: 'custom', authoredSchool: draft.school,
    skillId: 26,
    minSkill: Math.min(120, Math.max(0, Math.ceil(20 + mechanical * areaFactor(draft) / 4))),
    mana: draft.mana, delayMs: draft.castTimeMs, cooldownMs: draft.cooldownMs,
    range: draft.range, requiresTarget: draft.target !== 'self',
    targetKind: draft.target === 'location' ? 'location' : 'mobile',
    areaCast: draft.area.shape !== 'single', customDraftId: draft.id,
    requiredSpellcraftRank: draft.requiredRank ?? requiredRankForDraft(draft),
    canCast: (ctx) => {
      if (isSpellcraftAdmin({ accessLevel: ctx.accessLevel })) return { ok: true };
      const profile = getSpellcraftProfile(ctx.caster);
      const requiredRank = draft.requiredRank ?? requiredRankForDraft(draft);
      return profile.level >= requiredRank
        ? { ok: true }
        : { ok: false, reason: 'spellcraft-rank', requiredRank };
    },
    effect: (ctx) => {
      executeSpellGraph(draft, ctx);
      const progress = awardPracticeXp(ctx.caster);
      if (progress?.leveledUp) {
        ctx.caster?.client?.sendSystemMessage?.(`Your arcane research advances to ${progress.profile.rank}.`);
      }
    },
  };
}

function accountKey(state) {
  const raw = state?.account?.username ?? state?.accountName ?? state?.mobile?.accountName
    ?? `mobile-${state?.mobile?.serial ?? 0}`;
  return String(raw).trim().toLowerCase();
}

function playerDraftId(owner, name) {
  const ownerText = String(owner);
  const ownerSlug = ownerText.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 10) || 'player';
  let hash = 0x811C9DC5;
  for (const char of ownerText) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  const accountTag = hash.toString(36).slice(0, 6);
  const spellSlug = slugFromName(name).slice('custom:'.length, 'custom:'.length + 25);
  return `custom:${ownerSlug}-${accountTag}-${spellSlug}`;
}

export class SpellComposerService {
  constructor(saveDir) {
    this.file = path.join(saveDir, 'custom-spells.json');
    this.drafts = new Map();
    this._registered = new Map();
    this._sessions = new Map();
    this._nextRequestId = 1;
    this.load();
  }

  _allocateSpellId(preferred = null) {
    if (preferred >= CUSTOM_SPELL_ID_MIN && preferred <= CUSTOM_SPELL_ID_MAX
        && ![...this.drafts.values()].some((draft) => draft.spellId === preferred)
        && !getSpell(preferred)) return preferred;
    for (let id = CUSTOM_SPELL_ID_MIN; id <= CUSTOM_SPELL_ID_MAX; id++) {
      if (![...this.drafts.values()].some((draft) => draft.spellId === id) && !getSpell(id)) return id;
    }
    throw new Error('The custom spell id range is exhausted.');
  }

  _register(draft) {
    const previous = this._registered.get(draft.id);
    if (previous) unregisterSpell(previous.id, previous);
    if (!draft.published || !draft.spellId) { this._registered.delete(draft.id); return; }
    const definition = spellDefinition(draft);
    registerSpell(definition);
    this._registered.set(draft.id, definition);
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const raw of (parsed?.spells ?? []).slice(0, MAX_DRAFTS)) {
        const result = validateSpellDraft(raw);
        if (!result.ok) continue;
        // Treat persisted ids as preferences, not authority.  A hand-edited or
        // partially recovered file may contain duplicates; registering both
        // would make one scroll silently cast the other draft.
        const spellId = this._allocateSpellId(raw.spellId);
        const requiredRank = clampInt(
          raw.requiredRank ?? requiredRankForDraft(result.draft), 1, SPELLCRAFT_RANKS.length,
        );
        const draft = {
          ...result.draft, spellId, published: raw.published === true,
          publishedAt: raw.publishedAt ?? null,
          updatedAt: raw.updatedAt ?? result.draft.updatedAt,
          ownerAccount: raw.ownerAccount ?? null,
          creatorName: raw.creatorName ?? null,
          researchAwarded: raw.researchAwarded === true,
          requiredRank,
          minScribeSkill: clampInt(
            raw.minScribeSkill ?? SPELLCRAFT_RANKS[requiredRank - 1].inscription, 0, 120,
          ),
        };
        this.drafts.set(draft.id, draft);
        this._register(draft);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn(`[spell-composer] load failed: ${error.message}`);
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 3, spells: [...this.drafts.values()] }, null, 2));
    fs.renameSync(temporary, this.file);
  }

  _commit(draft) {
    const previous = this.drafts.get(draft.id);
    if (!previous && this.drafts.size >= MAX_DRAFTS) throw new Error(`At most ${MAX_DRAFTS} custom spells may be stored.`);
    if (!draft.spellId) draft.spellId = previous?.spellId ?? this._allocateSpellId();
    this.drafts.set(draft.id, draft);
    try { this.save(); }
    catch (error) {
      if (previous) this.drafts.set(draft.id, previous); else this.drafts.delete(draft.id);
      throw error;
    }
    this._register(draft);
  }

  _sendResult(state, requestId, payload) {
    return sendNodeUOEvent(state, {
      feature: NodeUOFeature.SpellComposer,
      eventKind: NodeUOSpellComposerMessage.Result, requestId, payload,
    });
  }

  profile(value) { return getSpellcraftProfile(value); }

  learn(mobile, unlock, xp) { return learnSpellcraft(mobile, unlock, xp); }

  _pruneSessions(now = Date.now()) {
    for (const [id, session] of this._sessions) {
      if (session.expiresAt <= now) this._sessions.delete(id);
    }
  }

  _authoringContext(state, requestId) {
    const admin = isSpellcraftAdmin(state);
    const mobile = state?.mobile;
    const owner = accountKey(state);
    const profile = getSpellcraftProfile(state);
    if (admin) return { ok: true, admin, mobile, owner, profile };
    this._pruneSessions();
    const session = this._sessions.get(requestId >>> 0);
    if (!mobile || !session || session.state !== state || session.owner !== owner) {
      return { ok: false, errors: ['Open your Arcane Schema Codex before editing spells.'] };
    }
    const source = state.ctx?.world?.items?.get?.(session.sourceSerial);
    if (!source || source.script !== 'spell-schema-codex'
        || !state.ctx?.game?.inventory?.isInPack?.(source, mobile)) {
      return { ok: false, errors: ['Keep the Arcane Schema Codex in your backpack while editing.'] };
    }
    session.expiresAt = Date.now() + AUTHORING_SESSION_MS;
    return { ok: true, admin, mobile, owner, profile };
  }

  _prepareDraft(state, requestId, payload, { publish = false } = {}) {
    const auth = this._authoringContext(state, requestId);
    if (!auth.ok) return auth;
    const result = publish ? validateSpellForPublication(payload) : validateSpellDraft(payload);
    if (!result.ok) return result;
    const errors = progressionErrors(result.draft, auth.profile);
    const requestedId = String(payload?.id ?? '');
    let existing = requestedId ? this.drafts.get(requestedId) : null;
    if (existing && !auth.admin && existing.ownerAccount !== auth.owner) {
      errors.push('You may edit only your own spell schemas.');
    }
    let id = existing?.id ?? result.draft.id;
    if (!existing && !auth.admin) {
      id = playerDraftId(auth.owner, result.draft.name);
      existing = this.drafts.get(id);
      if (existing && existing.ownerAccount !== auth.owner) errors.push('That schema name is already reserved.');
    }
    const ownedDrafts = [...this.drafts.values()].filter((draft) => draft.ownerAccount === auth.owner).length;
    if (!auth.admin && !existing && ownedDrafts >= auth.profile.limits.maxDrafts) {
      errors.push(`${auth.profile.rank} may keep at most ${auth.profile.limits.maxDrafts} spell schemas.`);
    }
    if (errors.length) return { ok: false, errors: [...new Set(errors)] };
    const draft = {
      ...result.draft,
      id,
      spellId: existing?.spellId ?? result.draft.spellId,
      ownerAccount: existing?.ownerAccount ?? auth.owner,
      creatorName: existing?.creatorName ?? auth.mobile?.name ?? state?.account?.username ?? auth.owner,
      researchAwarded: existing?.researchAwarded === true,
      requiredRank: requiredRankForDraft(result.draft),
      minScribeSkill: SPELLCRAFT_RANKS[requiredRankForDraft(result.draft) - 1].inscription,
      scribingRequirements: schemaScribingRequirements(result.draft),
    };
    return { ok: true, draft, auth, existing };
  }

  open(state, options = {}) {
    if (!state?.supportsNodeUO?.(NodeUOFeature.SpellComposer)) return false;
    const admin = isSpellcraftAdmin(state);
    const sourceSerial = options.sourceSerial >>> 0;
    if (!admin) {
      const source = state.ctx?.world?.items?.get?.(sourceSerial);
      if (!state.mobile || !source || source.script !== 'spell-schema-codex'
          || !state.ctx?.game?.inventory?.isInPack?.(source, state.mobile)) {
        state.sendSystemMessage?.('You must carry an Arcane Schema Codex to research spells.');
        return false;
      }
    }
    this._pruneSessions();
    for (const [id, session] of this._sessions) {
      if (session.state === state) this._sessions.delete(id);
    }
    const requestId = this._nextRequestId++ >>> 0;
    const owner = accountKey(state);
    const profile = getSpellcraftProfile(state);
    this._sessions.set(requestId, {
      state, owner, sourceSerial,
      expiresAt: Date.now() + AUTHORING_SESSION_MS,
    });
    const drafts = [];
    let truncated = false;
    const visibleDrafts = [...this.drafts.values()]
      .filter((draft) => admin || draft.ownerAccount === owner)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    for (const draft of visibleDrafts) {
      const candidate = [...drafts, draft];
      const bytes = new TextEncoder().encode(JSON.stringify({ catalog: composerCatalog(profile), drafts: candidate })).length;
      if (bytes > 30 * 1024) { truncated = true; break; }
      drafts.push(draft);
    }
    const payload = {
      catalog: composerCatalog(profile), drafts, truncated, progression: profile,
      permissions: { edit: true, publish: true, scribe: admin || !!sourceSerial },
      sourceSerial,
    };
    sendNodeUOEvent(state, {
      feature: NodeUOFeature.SpellComposer,
      eventKind: NodeUOSpellComposerMessage.Open, requestId, payload,
    });
    return true;
  }

  acceptDraft(state, requestId, payload) {
    const result = this._prepareDraft(state, requestId, payload);
    try {
      if (result.ok) {
        result.draft.spellId = result.existing?.spellId ?? this._allocateSpellId();
        result.draft.published = false;
        result.draft.publishedAt = null;
        this._commit(result.draft);
      }
    } catch (error) { return this._fail(state, requestId, result, error); }
    this._sendResult(state, requestId, result.ok
      ? { ok: true, draft: result.draft, progression: getSpellcraftProfile(state) }
      : { ok: false, errors: result.errors });
    return result;
  }

  publishDraft(state, requestId, payload) {
    const result = this._prepareDraft(state, requestId, payload, { publish: true });
    try {
      if (result.ok) {
        result.draft.spellId = result.existing?.spellId ?? this._allocateSpellId();
        result.draft.published = true;
        result.draft.publishedAt = new Date().toISOString();
        const rewardResearch = !result.auth.admin && !result.draft.researchAwarded;
        if (rewardResearch) result.draft.researchAwarded = true;
        this._commit(result.draft);
        if (rewardResearch) {
          const xp = Math.min(50, Math.max(15, Math.ceil(spellMetrics(result.draft).impact / 3)));
          result.progression = learnSpellcraft(result.auth.mobile, null, xp);
        }
      }
    } catch (error) { return this._fail(state, requestId, result, error); }
    this._sendResult(state, requestId, result.ok
      ? { ok: true, published: true, draft: result.draft,
          progression: getSpellcraftProfile(state), xpGained: result.progression?.xpGained ?? 0 }
      : { ok: false, published: false, errors: result.errors });
    return result;
  }

  _fail(state, requestId, result, error) {
    const failed = { ok: false, errors: [error?.message ?? String(error)] };
    this._sendResult(state, requestId, failed);
    return Object.assign(result, failed);
  }

  getPublished(id) {
    const byDraft = this.drafts.get(String(id));
    if (byDraft?.published) return byDraft;
    return [...this.drafts.values()].find((draft) => draft.published && draft.spellId === (id | 0)) ?? null;
  }

  /** Execute a published graph from an external mana source such as an
   * Arcane Schema Pedestal. The caller owns charge, cadence and target
   * authorization; this method keeps graph semantics in one implementation. */
  executePublished(id, ctx) {
    const draft = this.getPublished(id);
    if (!draft) return { ok: false, reason: 'missing-schema' };
    executeSpellGraph(draft, ctx);
    return { ok: true, draft };
  }

  scribeDraft(state, requestId, payload) {
    const admin = isSpellcraftAdmin(state);
    const mobile = state?.mobile;
    const world = state?.ctx?.world;
    const game = state?.ctx?.game;
    const source = world?.items?.get?.((payload?.sourceSerial ?? 0) >>> 0);
    const draft = this.getPublished(payload?.id ?? payload?.spellId);
    const inPack = (item) => !!game?.inventory?.isInPack?.(item, mobile);
    if (!mobile || (!admin && (!source || source.script !== 'spell-schema-codex' || !inPack(source)))) {
      const result = { ok: false, errors: ['You must carry the Arcane Schema Codex.'] };
      this._sendResult(state, requestId, result);
      return result;
    }
    if (!draft) {
      const result = { ok: false, errors: ['That spell has not been published.'] };
      this._sendResult(state, requestId, result);
      return result;
    }
    const profile = getSpellcraftProfile(state);
    if (!profile.admin && (profile.level < (draft.requiredRank ?? 1)
        || profile.inscription < (draft.minScribeSkill ?? 0))) {
      const result = {
        ok: false,
        errors: [`Scribing this schema requires spellcraft rank ${draft.requiredRank}`
          + ` and Inscription ${draft.minScribeSkill}.`],
      };
      this._sendResult(state, requestId, result);
      return result;
    }
    const requirements = draft.scribingRequirements ?? schemaScribingRequirements(draft);
    const packSerial = mobile.backpack?.serial ?? mobile.equipment?.get?.(21)?.serial
      ?? source?.parent ?? mobile.serial;
    const carried = [...containerChildrenRecursive(world, packSerial)];
    const matches = (item, material) => item.definitionId === material.definitionId
      || (item.itemId | 0) === (material.artId | 0)
      || (material.definitionId === 'blank-scroll' && item.category === 'blank-scroll');
    if (!admin) {
      const missing = requirements.filter((material) => carried
        .filter((item) => matches(item, material))
        .reduce((sum, item) => sum + Math.max(1, item.amount | 0), 0) < material.amount);
      if (missing.length) {
        const result = { ok: false, errors: [`Scribing requires ${missing
          .map((material) => `${material.amount} ${material.name}`)
          .join(', ')}.`] };
        this._sendResult(state, requestId, result);
        return result;
      }
    }
    const scroll = game?.mobile?.giveItem?.(mobile, {
      definitionId: 'custom-spell-scroll', artId: 0x1F2D,
      name: `Schema Scroll: ${draft.name}`, hue: 0x0481,
      script: 'custom-spell-scroll', customSpellId: draft.spellId,
      stackable: false, weight: 1,
    });
    if (!scroll) {
      const result = { ok: false, errors: ['The scroll could not be placed in your backpack.'] };
      this._sendResult(state, requestId, result);
      return result;
    }
    if (!admin) {
      // Consume only after the output scroll exists, and only after the full
      // bill was verified. This makes the transaction atomic from a player's
      // perspective and supports costs spread across multiple stacks/bags.
      for (const material of requirements) {
        let remaining = material.amount;
        for (const item of carried) {
          if (remaining <= 0 || !matches(item, material)) continue;
          const have = Math.max(1, item.amount | 0);
          const take = Math.min(have, remaining);
          remaining -= take;
          if (take >= have) {
            game.item?.destroy?.(item);
            if (world.items?.has?.(item.serial)) destroyItem(world, item.serial);
            const packet = state.ctx?.protocol?.removeEntity?.(item.serial) ?? removeEntity(item.serial);
            if (packet) state.send?.(packet);
          } else {
            item.amount = have - take;
            const packet = state.ctx?.protocol?.containerContentUpdate?.(item, item.parent ?? packSerial)
              ?? containerContentUpdate(item, item.parent ?? packSerial);
            if (packet) state.send?.(packet);
          }
        }
      }
    }
    const result = {
      ok: true, scribed: true, draft, scrollSerial: scroll.serial,
      progression: profile,
    };
    this._sendResult(state, requestId, result);
    return result;
  }

  dispose() {
    for (const definition of this._registered.values()) unregisterSpell(definition.id, definition);
    this._registered.clear();
    this._sessions.clear();
  }
}
