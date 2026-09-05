// Runtime world-content registry.
//
// Script modules register deterministic landmarks here instead of placing
// them unconditionally during server boot.  A freshly wiped shard therefore
// stays empty until `[createworld`, while a populated shard can restore the
// runtime controllers for its persisted landmarks on restart.

const REGISTRY_KEY = 'worldContentSeeds';

function registry(api) {
  if (!api.systems) api.systems = {};
  if (!(api.systems[REGISTRY_KEY] instanceof Map)) {
    api.systems[REGISTRY_KEY] = new Map();
  }
  return api.systems[REGISTRY_KEY];
}

/** Register one independently owned world-content seed. */
export function registerWorldContentSeed(api, id, handlers) {
  const seeds = registry(api);
  const entry = {
    id: String(id),
    apply: typeof handlers?.apply === 'function' ? handlers.apply : () => ({ added: 0 }),
    remove: typeof handlers?.remove === 'function' ? handlers.remove : () => ({ removed: 0 }),
  };
  seeds.set(entry.id, entry);
  return () => {
    if (seeds.get(entry.id) === entry) seeds.delete(entry.id);
  };
}

function run(api, operation, opts) {
  const seeds = registry(api);
  const result = { added: 0, removed: 0, failed: 0, seeds: [] };
  for (const entry of [...seeds.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    try {
      const row = entry[operation](opts) ?? {};
      result.added += Number(row.added ?? 0) || 0;
      result.removed += Number(row.removed ?? 0) || 0;
      result.failed += Number(row.failed ?? 0) || 0;
      result.seeds.push({ id: entry.id, ...row });
    } catch (error) {
      result.failed++;
      result.seeds.push({ id: entry.id, failed: 1, error: error.message });
      api.log?.(`[world-content] ${operation} ${entry.id} failed: ${error.stack ?? error.message}`);
    }
  }
  return result;
}

export function applyRegisteredWorldContent(api, opts = {}) {
  return run(api, 'apply', opts);
}

export function removeRegisteredWorldContent(api, opts = {}) {
  return run(api, 'remove', opts);
}
