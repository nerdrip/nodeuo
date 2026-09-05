// Stable boundary between the activity orchestrator and older gameplay
// engines.  Existing engines have intentionally different APIs; this adapter
// layer never guesses method names or lets a catalog edit execute arbitrary
// functions.  Engines may opt into lifecycle hooks through `gameSystemHook`.

const ADAPTER_ALIASES = Object.freeze({
  worldCodex: 'itemRegistry',
  spectatorReplay: 'trace',
});

function resolveService(systems, id) {
  const serviceId = ADAPTER_ALIASES[id] ?? id;
  return { serviceId, service: systems?.[serviceId] ?? null };
}

function invokeOptIn(service, phase, context) {
  const hook = service?.gameSystemHook;
  if (!hook) return { ok: true, handled: false };
  const fn = typeof hook === 'function' ? hook : hook?.[phase];
  if (typeof fn !== 'function') return { ok: true, handled: false };
  const result = fn({ phase, ...context });
  return result && typeof result === 'object' ? { ok: result.ok !== false, handled: true, ...result }
    : { ok: result !== false, handled: true };
}

export class GameSystemAdapterRegistry {
  constructor(systems = {}) {
    this.systems = systems;
    this.stats = new Map();
  }

  validate(definitions) {
    const errors = [];
    const warnings = [];
    for (const definition of definitions) {
      if (!definition.adapter) continue;
      const { serviceId, service } = resolveService(this.systems, definition.adapter);
      if (!service) errors.push(`${definition.id}: adapter "${definition.adapter}" requires engineSystems.${serviceId}.`);
      else if (!service.gameSystemHook) warnings.push(`${definition.id}: ${serviceId} is linked for event/state interoperability but has no lifecycle hook.`);
    }
    return { ok: errors.length === 0, errors, warnings };
  }

  lifecycle(phase, definition, context = {}) {
    if (!definition?.adapter) return { ok: true, handled: false };
    const { serviceId, service } = resolveService(this.systems, definition.adapter);
    const row = this.stats.get(definition.adapter) ?? { calls: 0, handled: 0, failures: 0, lastError: '', lastCallAt: 0 };
    row.calls++; row.lastCallAt = Date.now();
    if (!service) {
      row.failures++; row.lastError = `Missing engineSystems.${serviceId}`;
      this.stats.set(definition.adapter, row);
      return { ok: false, handled: false, error: row.lastError };
    }
    try {
      const result = invokeOptIn(service, phase, { definition, service, serviceId, ...context });
      if (result.handled) row.handled++;
      if (!result.ok) { row.failures++; row.lastError = String(result.error ?? 'Adapter rejected lifecycle event.'); }
      this.stats.set(definition.adapter, row);
      return { ...result, serviceId };
    } catch (error) {
      row.failures++; row.lastError = String(error?.message ?? error);
      this.stats.set(definition.adapter, row);
      return { ok: false, handled: true, serviceId, error: row.lastError };
    }
  }

  diagnostics(definitions = []) {
    const used = new Map(definitions.filter((row) => row.adapter).map((row) => [row.adapter, row]));
    return [...used].map(([id]) => {
      const { serviceId, service } = resolveService(this.systems, id);
      return {
        id, serviceId, available: Boolean(service), optInLifecycle: Boolean(service?.gameSystemHook),
        systems: definitions.filter((row) => row.adapter === id).map((row) => row.id),
        ...(this.stats.get(id) ?? { calls: 0, handled: 0, failures: 0, lastError: '', lastCallAt: 0 }),
      };
    }).sort((a, b) => a.id.localeCompare(b.id));
  }
}

export function createGameSystemAdapterRegistry(systems) {
  return new GameSystemAdapterRegistry(systems);
}
