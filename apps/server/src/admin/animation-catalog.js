import fs from 'node:fs';
import path from 'node:path';
import sharp from './safe-sharp.js';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(HERE, '..', '..', '..', 'client', 'public', 'assets');
let manifest = null;
const loadedShards = new Set();

// Same-family compatibility substitutions used by the web client when a
// legal UO installation ships an incomplete legacy animation archive. These
// keep the audit honest: fallback is explicit and reported, never a silent
// generic daemon/llama chosen by body range.
const BODY_FALLBACK = Object.freeze({
  29: 211, 52: 51, 81: 80, 106: 12, 142: 42, 143: 42,
  235: 234, 236: 277, 239: 241, 260: 24, 268: 780,
});

// Existing schema-v2 manifests do not expose Bodyconv.def provenance. These
// are the canonical bodies used by CUO's Mounts table and must keep their own
// extracted animation rather than an old-client Body.def horse/ostard alias.
const EXACT_MOUNT_BODIES = new Set([
  0x00C3, 0x00C2, 0x00C1, 0x00C0, 0x00BF, 0x0084, 0x007A,
  0x00BC, 0x00BB, 0x0319, 0x0317, 0x031A, 0x031F,
]);

function data() {
  if (!manifest) {
    const index = path.join(ASSETS, 'mobiles-atlas-index.json');
    const file = fs.existsSync(index) ? index : path.join(ASSETS, 'mobiles-atlas.json');
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    manifest.bodies ??= {};
  }
  return manifest;
}

function ensureBodyLoaded(body) {
  const atlas = data();
  if (!atlas.shards || !Number.isInteger(atlas.shardSize)) return;
  const row = atlas.shards[Math.floor((body | 0) / atlas.shardSize)];
  if (!row?.file || loadedShards.has(row.file)) return;
  const shard = JSON.parse(fs.readFileSync(path.join(ASSETS, path.basename(row.file)), 'utf8'));
  if (shard?.schemaVersion !== 1
    || shard.group !== Math.floor((body | 0) / atlas.shardSize)
    || shard.shardSize !== atlas.shardSize) {
    throw new Error(`Invalid mobile animation shard ${row.file}`);
  }
  Object.assign(atlas.bodies, shard.bodies ?? {});
  loadedShards.add(row.file);
}

function resolveBody(body) {
  const atlas = data();
  const requested = Math.max(0, body | 0);
  const alias = atlas.aliases?.[requested];
  const aliasBody = alias?.body ?? alias?.trueBody;
  ensureBodyLoaded(requested);
  if (Number.isInteger(aliasBody)) ensureBodyLoaded(aliasBody);
  const exact = atlas.bodies?.[requested] && (
    atlas.bodyConv?.[requested]
    || (((atlas.mobTypes?.[requested]?.flags | 0) & 0x10000) !== 0)
    || EXACT_MOUNT_BODIES.has(requested)
  );
  if (exact) {
    return { requested, resolved: requested, alias: alias ?? null, resolvedVia: 'exact-source' };
  }
  if (aliasBody != null && atlas.bodies?.[aliasBody]) {
    return { requested, resolved: aliasBody, alias: alias ?? null, resolvedVia: 'alias' };
  }
  if (atlas.bodies?.[requested]) {
    return {
      requested, resolved: requested, alias: alias ?? null,
      resolvedVia: aliasBody != null ? 'broken-alias-direct' : 'direct',
    };
  }
  const fallback = BODY_FALLBACK[requested];
  if (fallback != null) {
    ensureBodyLoaded(fallback);
    const fallbackAlias = atlas.aliases?.[fallback];
    const fallbackAliasBody = fallbackAlias?.body ?? fallbackAlias?.trueBody;
    const resolved = fallbackAliasBody != null && atlas.bodies?.[fallbackAliasBody]
      ? fallbackAliasBody
      : fallback;
    if (atlas.bodies?.[resolved]) {
      return { requested, resolved, alias: alias ?? null, fallback, resolvedVia: 'fallback' };
    }
  }
  return { requested, resolved: aliasBody ?? requested, alias: alias ?? null, resolvedVia: 'missing' };
}

// Animation group ids are body-family specific and the retail data contains
// legitimate omissions. ClassicUO resolves a semantic action through a list
// of compatible groups instead of requiring one hard-coded id. Keep this
// validator aligned with that runtime rule: a body is valid when every core
// semantic has at least one complete renderable alternative.
function requiredSemantics(info) {
  const uop = ((info?.flags ?? 0) & 0x10000) !== 0;
  switch (String(info?.type ?? '').toUpperCase()) {
    case 'HUMAN':
    case 'EQUIPMENT':
      return {
        walk: [0, 1, 15, 2, 3, 4],
        idle: [4, 7, 8, 0],
        attack: [9, 10, 11, 12, 13, 14, 18, 19, 16, 17, 4],
        hit: [20, 4, 0],
        death: [21, 22, 4],
      };
    case 'ANIMAL':
      return uop ? {
        walk: [22, 0, 24, 25], idle: [25, 2, 1, 0],
        attack: [4, 5, 6, 7, 25, 2], death: [2, 3, 8, 12, 25],
      } : {
        walk: [0, 1, 2], idle: [2, 0, 1],
        attack: [5, 6, 7, 2, 0], death: [8, 12, 2, 0],
      };
    case 'MONSTER':
    case 'SEA':
    case 'SEAMONSTER':
      return uop ? {
        walk: [22, 0, 24, 25], idle: [25, 1, 0],
        attack: [4, 5, 6, 7, 8, 9, 10, 11, 12, 25, 1],
        hit: [13, 1, 0], death: [2, 3, 1, 0],
      } : {
        walk: [0, 1], idle: [1, 0, 2],
        attack: [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 0],
        hit: [13, 1, 0], death: [2, 3, 1, 0],
      };
    default:
      return { visible: [0, 1, 2, 4] };
  }
}

function actionCoverage(entry) {
  if (!entry?.dirs) return { directions: 0, frames: 0, complete: false };
  let directions = 0;
  let frames = 0;
  for (let direction = 0; direction < 5; direction++) {
    const usable = (entry.dirs[direction] ?? []).filter((frame) => frame && typeof frame === 'object');
    if (usable.length) directions++;
    frames += usable.length;
  }
  // UO stores five directions and mirrors them for the other three. A body
  // with fewer than five cannot face every direction without morphing into a
  // generic fallback, so treat that as genuinely incomplete.
  return { directions, frames, complete: directions === 5 && frames > 0 };
}

export function animationBodySnapshot(body) {
  const atlas = data();
  const resolved = resolveBody(body);
  ensureBodyLoaded(resolved.resolved);
  const bodyData = atlas.bodies?.[resolved.resolved];
  const info = atlas.mobTypes?.[resolved.requested] ?? atlas.mobTypes?.[resolved.resolved] ?? null;
  if (!bodyData) return { ok: false, ...resolved, info, errors: ['Body is absent from mobiles-atlas.json.'], warnings: [], actions: [] };
  const actions = Object.entries(bodyData.actions ?? {}).map(([action, value]) => ({
    action: Number(action),
    directions: Object.entries(value.dirs ?? {}).map(([direction, frames]) => ({ direction: Number(direction), frames: frames.length })),
  })).sort((a, b) => a.action - b.action);
  const errors = [], warnings = [], resolvedActions = {};
  for (const [semantic, candidates] of Object.entries(requiredSemantics(info))) {
    let chosen = null;
    for (const action of candidates) {
      if (actionCoverage(bodyData.actions?.[action]).complete) { chosen = action; break; }
    }
    if (chosen == null) {
      // ClassicUO ultimately renders the first complete group when a body has
      // non-standard group numbering (birds in several legacy clients are a
      // common example). Record it as a visible compatibility fallback.
      chosen = Object.entries(bodyData.actions ?? {})
        .find(([, entry]) => actionCoverage(entry).complete)?.[0] ?? null;
    }
    if (chosen == null) {
      errors.push(`No complete action for ${semantic} (tried ${candidates.join(', ')}).`);
    } else {
      chosen = Number(chosen);
      resolvedActions[semantic] = chosen;
      if (chosen !== candidates[0]) warnings.push(`${semantic} uses compatible fallback action ${chosen} instead of ${candidates[0]}.`);
    }
  }
  for (const [action, entry] of Object.entries(bodyData.actions ?? {})) {
    for (const [direction, frames] of Object.entries(entry.dirs ?? {})) {
      for (let index = 0; index < frames.length; index++) {
        const frame = frames[index];
        if (!frame || typeof frame !== 'object') {
          warnings.push(`Action ${action}/${direction}/${index}: sparse frame metadata.`);
          continue;
        }
        if (frame.page < 0 || frame.page >= atlas.pageCount) errors.push(`Action ${action}/${direction}/${index}: invalid page ${frame.page}.`);
        if (frame.u < 0 || frame.v < 0 || frame.u + frame.w > atlas.atlasW || frame.v + frame.h > atlas.atlasH) {
          errors.push(`Action ${action}/${direction}/${index}: frame exceeds atlas bounds.`);
        }
        if (frame.w <= 0 || frame.h <= 0) warnings.push(`Action ${action}/${direction}/${index}: empty frame.`);
      }
    }
  }
  return { ok: errors.length === 0, ...resolved, info, actions, resolvedActions, errors, warnings };
}

export function validateMonsterAnimations(monsters) {
  const results = [];
  for (const kind of monsters?.kinds?.() ?? []) {
    const cfg = monsters.get(kind) ?? {};
    if (!Number.isFinite(cfg.body)) continue;
    const report = animationBodySnapshot(cfg.body);
    results.push({
      kind, name: cfg.name ?? kind, body: cfg.body, ok: report.ok,
      errors: report.errors, warnings: report.warnings,
      resolved: report.resolved, resolvedActions: report.resolvedActions ?? {},
    });
  }
  return {
    total: results.length,
    invalid: results.filter((entry) => !entry.ok).length,
    warnings: results.reduce((sum, entry) => sum + entry.warnings.length, 0),
    results,
  };
}

export async function animationFramePng(body, action, direction, frameIndex) {
  const atlas = data();
  const resolved = resolveBody(body);
  const frames = atlas.bodies?.[resolved.resolved]?.actions?.[action]?.dirs?.[direction];
  if (!frames?.length) return null;
  const frame = frames[Math.max(0, frameIndex | 0) % frames.length];
  const pageFile = atlas.pages?.[frame.page]?.file
    ?? `mobiles-atlas-${String(frame.page).padStart(2, '0')}.png`;
  const file = path.join(ASSETS, path.basename(pageFile));
  if (!fs.existsSync(file)) return null;
  return sharp(file).extract({ left: frame.u, top: frame.v, width: frame.w, height: frame.h })
    .extend({ top: 8, bottom: 8, left: 8, right: 8, background: { r: 10, g: 14, b: 20, alpha: 0 } })
    .png().toBuffer();
}
