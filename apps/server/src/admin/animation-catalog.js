import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(HERE, '..', '..', '..', 'client', 'public', 'assets');
let manifest = null;

function data() {
  manifest ??= JSON.parse(fs.readFileSync(path.join(ASSETS, 'mobiles-atlas.json'), 'utf8'));
  return manifest;
}

function resolveBody(body) {
  const atlas = data();
  const requested = Math.max(0, body | 0);
  const alias = atlas.aliases?.[requested];
  return { requested, resolved: alias?.trueBody ?? requested, alias: alias ?? null };
}

function requiredActions(info) {
  const uop = ((info?.flags ?? 0) & 0x10000) !== 0;
  switch (String(info?.type ?? '').toUpperCase()) {
    case 'HUMAN': return [0, 2, 4, 9, 20, 21, 22];
    case 'ANIMAL': return uop ? [22, 24, 25, 4, 2, 3] : [0, 1, 2, 5, 8];
    case 'MONSTER': case 'SEA': case 'SEAMONSTER':
      return uop ? [22, 24, 25, 4, 2, 3] : [0, 1, 4, 13, 2, 3];
    default: return [0];
  }
}

export function animationBodySnapshot(body) {
  const atlas = data();
  const resolved = resolveBody(body);
  const bodyData = atlas.bodies?.[resolved.resolved];
  const info = atlas.mobTypes?.[resolved.requested] ?? atlas.mobTypes?.[resolved.resolved] ?? null;
  if (!bodyData) return { ok: false, ...resolved, info, errors: ['Body is absent from mobiles-atlas.json.'], actions: [] };
  const actions = Object.entries(bodyData.actions ?? {}).map(([action, value]) => ({
    action: Number(action),
    directions: Object.entries(value.dirs ?? {}).map(([direction, frames]) => ({ direction: Number(direction), frames: frames.length })),
  })).sort((a, b) => a.action - b.action);
  const errors = [], warnings = [];
  for (const action of requiredActions(info)) {
    const entry = bodyData.actions?.[action];
    if (!entry) { errors.push(`Missing required action ${action}.`); continue; }
    for (let direction = 0; direction < 5; direction++) {
      if (!entry.dirs?.[direction]?.length) errors.push(`Action ${action} direction ${direction} has no frames.`);
    }
  }
  for (const [action, entry] of Object.entries(bodyData.actions ?? {})) {
    for (const [direction, frames] of Object.entries(entry.dirs ?? {})) {
      for (let index = 0; index < frames.length; index++) {
        const frame = frames[index];
        if (frame.page < 0 || frame.page >= atlas.pageCount) errors.push(`Action ${action}/${direction}/${index}: invalid page ${frame.page}.`);
        if (frame.u < 0 || frame.v < 0 || frame.u + frame.w > atlas.atlasW || frame.v + frame.h > atlas.atlasH) {
          errors.push(`Action ${action}/${direction}/${index}: frame exceeds atlas bounds.`);
        }
        if (frame.w <= 0 || frame.h <= 0) warnings.push(`Action ${action}/${direction}/${index}: empty frame.`);
      }
    }
  }
  return { ok: errors.length === 0, ...resolved, info, actions, errors, warnings };
}

export function validateMonsterAnimations(monsters) {
  const results = [];
  for (const kind of monsters?.kinds?.() ?? []) {
    const cfg = monsters.get(kind) ?? {};
    if (!Number.isFinite(cfg.body)) continue;
    const report = animationBodySnapshot(cfg.body);
    results.push({ kind, name: cfg.name ?? kind, body: cfg.body, ok: report.ok, errors: report.errors, warnings: report.warnings, resolved: report.resolved });
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
  const file = path.join(ASSETS, `mobiles-atlas-${String(frame.page).padStart(2, '0')}.png`);
  if (!fs.existsSync(file)) return null;
  return sharp(file).extract({ left: frame.u, top: frame.v, width: frame.w, height: frame.h })
    .extend({ top: 8, bottom: 8, left: 8, right: 8, background: { r: 10, g: 14, b: 20, alpha: 0 } })
    .png().toBuffer();
}
