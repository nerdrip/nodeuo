const REGION_TYPES = new Set(['base', 'guarded', 'town', 'dungeon', 'nomurder']);

function finiteInt(value) { return Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : null; }

export function validateRegionDraft(raw) {
  const errors = [];
  const name = String(raw?.name ?? '').trim();
  if (!name || name.length > 80) errors.push('name must contain 1-80 characters');
  const map = finiteInt(raw?.map);
  if (map == null || map < 0 || map > 5) errors.push('map must be 0..5');
  const type = String(raw?.type ?? 'base').toLowerCase();
  if (!REGION_TYPES.has(type)) errors.push(`unsupported region type: ${type}`);
  const rects = Array.isArray(raw?.rects) ? raw.rects.map((rect, index) => {
    const values = ['x1', 'y1', 'x2', 'y2'].map((key) => finiteInt(rect?.[key]));
    if (values.some((value) => value == null)) {
      errors.push(`rect ${index} needs integer x1,y1,x2,y2`);
      return null;
    }
    const [x1, y1, x2, y2] = values;
    if (x1 < 0 || y1 < 0 || x2 > 65535 || y2 > 65535) errors.push(`rect ${index} is outside map bounds`);
    return { x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2) };
  }).filter(Boolean) : [];
  if (!rects.length) errors.push('at least one rect is required');
  const blockedSpells = Array.isArray(raw?.blockedSpells)
    ? [...new Set(raw.blockedSpells.map(String).map((value) => value.trim()).filter(Boolean))].slice(0, 128) : [];
  const value = {
    name, map: map ?? 1, type, rects,
    priority: Math.max(-1000, Math.min(1000, finiteInt(raw?.priority) ?? 0)),
    guarded: raw?.guarded == null ? (type === 'guarded' || type === 'town') : !!raw.guarded,
    noKill: !!raw?.noKill,
    noMurder: raw?.noMurder == null ? (type === 'town' || type === 'nomurder') : !!raw.noMurder,
    allowGate: raw?.allowGate !== false, pvp: !!raw?.pvp,
    blockedSpells,
    music: String(raw?.music ?? '').slice(0, 80) || undefined,
    ambientSound: String(raw?.ambientSound ?? '').slice(0, 80) || undefined,
    season: raw?.season == null ? undefined : Math.max(0, Math.min(4, finiteInt(raw.season) ?? 0)),
  };
  return { ok: errors.length === 0, errors, value };
}

function rectOverlap(a, b) {
  const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2), y2 = Math.min(a.y2, b.y2);
  if (x1 > x2 || y1 > y2) return null;
  return { x1, y1, x2, y2, tiles: (x2 - x1 + 1) * (y2 - y1 + 1) };
}

export function regionDiagnostics(registry) {
  const regions = registry?.all?.() ?? registry?.regions ?? [];
  const overlaps = [];
  const invalid = [];
  for (let i = 0; i < regions.length; i++) {
    const checked = validateRegionDraft(regions[i]);
    if (!checked.ok) invalid.push({ name: regions[i].name, map: regions[i].map, errors: checked.errors });
    for (let j = i + 1; j < regions.length; j++) {
      if (regions[i].map !== regions[j].map) continue;
      for (const a of regions[i].rects ?? []) for (const b of regions[j].rects ?? []) {
        const area = rectOverlap(a, b);
        if (area) overlaps.push({ a: regions[i].name, b: regions[j].name, map: regions[i].map, ...area,
          priorityConflict: (regions[i].priority | 0) === (regions[j].priority | 0) });
      }
    }
  }
  return { count: regions.length, invalid, overlaps };
}

export function validateSpawnerDraft(raw, monsterKinds = []) {
  const errors = [], warnings = [];
  const known = new Set(monsterKinds);
  const id = String(raw?.id ?? '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(id)) errors.push('invalid spawner id');
  const values = ['x1', 'y1', 'x2', 'y2'].map((key) => finiteInt(raw?.rect?.[key]));
  if (values.some((value) => value == null)) errors.push('rect needs x1,y1,x2,y2');
  const kinds = Array.isArray(raw?.kinds) ? raw.kinds : [];
  if (!kinds.length) errors.push('at least one monster kind is required');
  for (const entry of kinds) {
    const kind = Array.isArray(entry) ? entry[0] : typeof entry === 'object' ? entry.kind ?? entry.name : entry;
    if (!kind) errors.push('empty kind entry');
    else if (known.size && !known.has(kind)) warnings.push(`unknown monster kind: ${kind}`);
  }
  const maxCount = finiteInt(raw?.maxCount);
  if (maxCount == null || maxCount < 1 || maxCount > 500) errors.push('maxCount must be 1..500');
  const respawn = raw?.respawnMs;
  if (!Array.isArray(respawn) || respawn.length < 2 || respawn.some((value) => !Number.isFinite(Number(value)))) {
    errors.push('respawnMs needs [min,max]');
  } else if (+respawn[0] > +respawn[1]) warnings.push('respawn bounds will be swapped');
  return { ok: errors.length === 0, errors, warnings };
}

export function spawnerHeatmap(spawner, world, { map = 1, cellSize = 64 } = {}) {
  const cells = new Map();
  const groups = [];
  for (const group of spawner?.groups?.values?.() ?? []) {
    if ((group.map | 0) !== (map | 0) || !group.rect) continue;
    const centerX = ((group.rect.x1 + group.rect.x2) / 2) | 0;
    const centerY = ((group.rect.y1 + group.rect.y2) / 2) | 0;
    const key = `${Math.floor(centerX / cellSize)}|${Math.floor(centerY / cellSize)}`;
    const cell = cells.get(key) ?? { x: Math.floor(centerX / cellSize) * cellSize, y: Math.floor(centerY / cellSize) * cellSize,
      groups: 0, capacity: 0, active: 0 };
    cell.groups++; cell.capacity += group.maxCount | 0; cell.active += group.spawnedSerials?.size ?? 0; cells.set(key, cell);
    groups.push({ id: group.id, centerX, centerY, capacity: group.maxCount | 0, active: group.spawnedSerials?.size ?? 0,
      density: Number(((group.maxCount | 0) / Math.max(1, (group.rect.x2 - group.rect.x1 + 1) * (group.rect.y2 - group.rect.y1 + 1))).toFixed(4)) });
  }
  return { map: map | 0, cellSize, cells: [...cells.values()].sort((a, b) => b.capacity - a.capacity), groups,
    liveMobiles: [...(world?.mobiles?.values?.() ?? [])].filter((mob) => (mob.map | 0) === (map | 0)).length };
}

export function validateLootDraft(registry, raw) {
  const errors = [], warnings = [];
  const name = String(raw?.name ?? '').trim();
  const entries = Array.isArray(raw?.entries) ? raw.entries : [];
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(name)) errors.push('invalid loot table name');
  if (!entries.length) warnings.push('loot table is empty');
  entries.forEach((entry, index) => {
    const outputs = ['template', 'itemId', 'table', 'artifact', 'magicItem'].filter((key) => entry?.[key] != null);
    if (outputs.length !== 1) errors.push(`entry ${index} needs exactly one output type`);
    if (entry?.chance != null && (!Number.isFinite(+entry.chance) || +entry.chance < 0 || +entry.chance > 1)) errors.push(`entry ${index} chance must be 0..1`);
    if (entry?.table && !registry?.get?.(entry.table) && entry.table !== name) warnings.push(`entry ${index} references missing table ${entry.table}`);
  });
  return { ok: errors.length === 0, errors, warnings, value: { ...raw, name, entries } };
}

export function validateQuestDraft(raw) {
  const errors = [], warnings = [];
  const id = String(raw?.id ?? '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(id)) errors.push('invalid quest id');
  if (!String(raw?.name ?? '').trim()) errors.push('quest name is required');
  const objectives = Array.isArray(raw?.objectives) ? raw.objectives : [];
  if (!objectives.length) warnings.push('quest has no objectives');
  objectives.forEach((objective, index) => {
    if (!['kill', 'gather', 'visit', 'deliver', 'talk', 'collect'].includes(objective?.kind)) warnings.push(`objective ${index} uses custom kind ${objective?.kind}`);
    if (!(objective?.target ?? objective?.resource ?? objective?.region ?? objective?.npc)) errors.push(`objective ${index} has no target`);
    if ((finiteInt(objective?.count) ?? 0) < 1) errors.push(`objective ${index} count must be positive`);
  });
  const dialog = raw?.dialog;
  if (dialog && typeof dialog === 'object') {
    const nodes = new Set(Object.keys(dialog));
    for (const [nodeId, node] of Object.entries(dialog)) for (const option of node?.options ?? []) {
      if (option.goto && !nodes.has(option.goto)) errors.push(`dialog ${nodeId} points to missing node ${option.goto}`);
    }
  }
  return { ok: errors.length === 0, errors, warnings, value: { ...raw, id, objectives } };
}
