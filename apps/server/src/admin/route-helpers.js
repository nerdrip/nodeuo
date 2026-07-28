// Stateless serialization, validation, path, and log helpers shared by admin route groups.

import fs from 'node:fs';
import path from 'node:path';

// ---- snapshot helpers ----------------------------------------------------

export function snapshotMobile(mob) {
  return {
    serial: '0x' + (mob.serial >>> 0).toString(16),
    name: mob.name,
    body: mob.body,
    hue: mob.hue,
    x: mob.x, y: mob.y, z: mob.z, map: mob.map,
    direction: mob.direction,
    notoriety: mob.notoriety,
    hp: mob.hp, hpMax: mob.hpMax,
    mana: mob.mana, manaMax: mob.manaMax,
    stam: mob.stam, stamMax: mob.stamMax,
    str: mob.str, dex: mob.dex, int: mob.int,
    gold: mob.gold,
    sex: mob.sex,
    isPlayer: !!mob.isPlayer,
    online: !!mob.client,
    accountName: mob.accountName,
    client: mob.client ? {
      id: mob.client.id ?? null,
      version: mob.client.clientVersionString ?? null,
      transport: mob.client.nodeUOTransport ? 'nodeuo.v1' : 'standard-uo',
      capabilities: mob.client.nodeUOCapabilities >>> 0,
      pendingBytes: Number(mob.client.ws?.bufferedAmount ?? mob.client.socket?.writableLength ?? 0) || 0,
    } : null,
    // Civic-NPC tag exposed for the admin "Vendors" filter — without
    // it the UI couldn't tell a banker from a wild orc and the
    // operator's "where are my shopkeepers" lookup blended into the
    // monster list.
    vendorKind: mob.vendorKind ?? null,
    kind: mob.kind ?? null,
  };
}

export function snapshotItem(it) {
  return {
    serial: '0x' + (it.serial >>> 0).toString(16),
    definitionId: it.definitionId ?? null,
    artId: it.artId ?? it.itemId,
    itemId: it.itemId, hue: it.hue, amount: it.amount,
    x: it.x, y: it.y, z: it.z, map: it.map,
    parent: it.parent ? '0x' + (it.parent >>> 0).toString(16) : null,
    layer: it.layer,
    name: it.name,
    movable: it.movable,
    gumpId: it.gumpId,
  };
}

export function flattenScriptTree(nodes, out = []) {
  for (const node of nodes ?? []) {
    if (node?.type === 'file') out.push({ name: node.name, path: node.path, size: node.size ?? 0 });
    else if (node?.type === 'dir') flattenScriptTree(node.children, out);
  }
  return out;
}

const STUDIO_GUMP_CONTROL_TYPES = new Set([
  'panel', 'label', 'button', 'textentry', 'checkbox', 'radio', 'image', 'tilepic', 'html', 'page', 'alpha',
]);

function studioDraftRecords(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  const records = [];
  for (const value of Object.values(data)) {
    if (Array.isArray(value)) records.push(...value);
    else records.push(value);
  }
  return records;
}

export function validateStudioDraft(domain, data, catalogs = {}) {
  const errors = [];
  const warnings = [];
  const records = studioDraftRecords(data);
  const identities = new Map();
  const finite = (value) => Number.isFinite(Number(value));
  const duplicate = (identity, index) => {
    if (identity == null || identity === '') return;
    const key = String(identity);
    if (identities.has(key)) errors.push(`Record ${index + 1}: duplicate identity '${key}' (also record ${identities.get(key) + 1}).`);
    else identities.set(key, index);
  };

  records.forEach((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      errors.push(`Record ${index + 1}: expected an object.`);
      return;
    }
    if (record._comment || record._schema) return;
    if (domain === 'gumps') {
      const id = record.definitionId ?? record.id;
      duplicate(id, index);
      if (!String(id ?? '').trim()) errors.push(`Gump ${index + 1}: definitionId is required.`);
      if (record.scope === 'client') {
        if (!String(record.className ?? '').trim() && !String(record.type ?? '').trim()) errors.push(`${id ?? `Gump ${index + 1}`}: className or type is required.`);
        if (!record.frame || typeof record.frame !== 'object' || Array.isArray(record.frame)) errors.push(`${id}: frame must be an object.`);
        else if (record.frame.enabled) {
          const width = Number(record.frame.width), height = Number(record.frame.height);
          if (!finite(width) || width < 1 || width > 8192) errors.push(`${id}: frame.width must be between 1 and 8192.`);
          if (!finite(height) || height < 1 || height > 8192) errors.push(`${id}: frame.height must be between 1 and 8192.`);
          const opacity = Number(record.frame.opacity ?? 1);
          if (!finite(opacity) || opacity < 0 || opacity > 1) errors.push(`${id}: frame.opacity must be between 0 and 1.`);
        }
        if (!Array.isArray(record.controlOverrides)) errors.push(`${id}: controlOverrides must be an array.`);
        else {
          if (record.controlOverrides.length > 512) errors.push(`${id}: at most 512 control overrides are allowed.`);
          record.controlOverrides.forEach((override, overrideIndex) => {
            const label = `${id} override ${overrideIndex + 1}`;
            if (!override || typeof override !== 'object' || Array.isArray(override)) errors.push(`${label}: expected an object.`);
            else if (!String(override.path ?? '').trim() && !String(override.className ?? '').trim()) errors.push(`${label}: path or className is required.`);
          });
        }
        return;
      }
      const width = Number(record.width), height = Number(record.height);
      if (!finite(width) || width < 40 || width > 1600) errors.push(`${id ?? `Gump ${index + 1}`}: width must be between 40 and 1600.`);
      if (!finite(height) || height < 40 || height > 1200) errors.push(`${id ?? `Gump ${index + 1}`}: height must be between 40 and 1200.`);
      if (!Array.isArray(record.controls)) errors.push(`${id ?? `Gump ${index + 1}`}: controls must be an array.`);
      else {
        if (record.controls.length > 512) errors.push(`${id}: at most 512 controls are allowed.`);
        const buttonIds = new Set();
        const entryIds = new Set();
        record.controls.forEach((control, controlIndex) => {
          const label = `${id ?? `Gump ${index + 1}`} control ${controlIndex + 1}`;
          if (!control || typeof control !== 'object') { errors.push(`${label}: expected an object.`); return; }
          if (!STUDIO_GUMP_CONTROL_TYPES.has(control.type)) errors.push(`${label}: unsupported type '${control.type}'.`);
          for (const key of ['x', 'y']) if (!finite(control[key] ?? 0)) errors.push(`${label}: ${key} must be numeric.`);
          const x = Number(control.x ?? 0), y = Number(control.y ?? 0);
          const w = Number(control.width ?? control.w ?? (control.type === 'label' ? 120 : 24));
          const h = Number(control.height ?? control.h ?? (control.type === 'label' ? 20 : 24));
          if (x < 0 || y < 0) warnings.push(`${label}: lies partly above/left of the gump.`);
          if (finite(w) && finite(h) && (x + w > width || y + h > height)) warnings.push(`${label}: overflows the ${width}×${height} canvas.`);
          if (control.type === 'button') {
            if (!finite(control.buttonId)) errors.push(`${label}: buttonId is required.`);
            else if (buttonIds.has(Number(control.buttonId))) warnings.push(`${label}: duplicate buttonId ${control.buttonId}.`);
            else buttonIds.add(Number(control.buttonId));
          }
          if (control.type === 'textentry') {
            if (!finite(control.entryId)) errors.push(`${label}: entryId is required.`);
            else if (entryIds.has(Number(control.entryId))) errors.push(`${label}: duplicate entryId ${control.entryId}.`);
            else entryIds.add(Number(control.entryId));
          }
        });
      }
    } else if (domain === 'items') {
      const id = record.definitionId ?? record.id;
      duplicate(id, index);
      if (!String(id ?? '').trim()) errors.push(`Item ${index + 1}: definitionId is required.`);
      const artId = record.artId ?? record.itemId;
      if (!finite(artId) || Number(artId) < 0 || Number(artId) > 0xffff) errors.push(`${id ?? `Item ${index + 1}`}: artId must be a UO graphic in range 0..65535.`);
      if (record.script && !catalogs.itemScripts?.has?.(String(record.script))) warnings.push(`${id}: item script '${record.script}' is not registered in the live runtime.`);
    } else if (domain === 'mobiles') {
      const id = record.kind ?? record.id;
      duplicate(id, index);
      if (!String(id ?? '').trim()) errors.push(`Mobile ${index + 1}: kind is required.`);
      if (!finite(record.body) || Number(record.body) < 0) errors.push(`${id ?? `Mobile ${index + 1}`}: body must be a non-negative number.`);
      if (record.ai && !catalogs.aiNames?.has?.(String(record.ai))) warnings.push(`${id}: AI behavior '${record.ai}' is not registered in the live runtime.`);
      if (finite(record.dmgMin) && finite(record.dmgMax) && Number(record.dmgMin) > Number(record.dmgMax)) errors.push(`${id}: dmgMin cannot exceed dmgMax.`);
      if (finite(record.hp) && Number(record.hp) < 0) errors.push(`${id}: hp cannot be negative.`);
    } else {
      duplicate(record.definitionId ?? record.id ?? record.kind ?? record.type, index);
    }
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'number' && !Number.isFinite(value)) errors.push(`Record ${index + 1}.${key}: value is not finite.`);
    }
  });
  return { ok: errors.length === 0, errors, warnings, records: records.length, domain };
}

export function parseSerial(s) {
  if (!s) return 0;
  if (typeof s === 'string' && (s.startsWith('0x') || s.startsWith('0X'))) return parseInt(s, 16) >>> 0;
  return Number(s) >>> 0;
}

export function safeJoin(root, rel) {
  if (!rel) return null;
  // Reject path traversal.
  const normalized = path.normalize(rel).replace(/^[/\\]+/, '');
  if (normalized.includes('..')) return null;
  const abs = path.join(root, normalized);
  if (!abs.startsWith(root)) return null;
  return abs;
}

export function walkScriptTree(dir, base = '') {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push({ type: 'dir', name: e.name, path: rel, children: walkScriptTree(path.join(dir, e.name), rel) });
    } else if (e.isFile()) {
      let size = 0;
      try { size = fs.statSync(path.join(dir, e.name)).size; } catch { /* ignore */ }
      out.push({ type: 'file', name: e.name, path: rel, size });
    }
  }
  return out;
}

// Tiny ring buffer hooked from main.js via `attachLogHook(line)`.
const LOG_RING = [];
const LOG_MAX = 500;
export function pushLogLine(line) {
  LOG_RING.push({ ts: Date.now(), line: String(line).slice(0, 1024) });
  while (LOG_RING.length > LOG_MAX) LOG_RING.shift();
}
export function getLogTail(limit = 200) { return LOG_RING.slice(-Math.max(1, Math.min(LOG_MAX, limit | 0))); }

