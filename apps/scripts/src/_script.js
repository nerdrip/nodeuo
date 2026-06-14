function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function callMaybeFactory(value, api) {
  return typeof value === 'function' ? value(api) : value;
}

function fallbackTimer(kind, fn, delay, api) {
  const runner = () => {
    try { fn(api); }
    catch (e) { api.log?.(`script timer ${kind} threw: ${e?.message ?? e}`); }
  };
  const handle = kind === 'interval'
    ? setInterval(runner, delay)
    : setTimeout(runner, delay);
  handle.unref?.();
  return () => (kind === 'interval' ? clearInterval(handle) : clearTimeout(handle));
}

function registerCommand(api, spec, disposers) {
  if (!spec?.name) return;
  if (api.lifecycle?.command) {
    api.lifecycle.command(spec);
    return;
  }
  api.commands?.register?.(spec);
  disposers.push(() => api.commands?.unregister?.(spec.name));
}

function registerEvent(api, name, handler, disposers) {
  if (!name || typeof handler !== 'function') return;
  if (api.lifecycle?.event) {
    api.lifecycle.event(name, (payload) => handler(payload, api));
    return;
  }
  const source = api.world?.events;
  if (!source?.on) return;
  const wrapped = (payload) => handler(payload, api);
  const unsub = source.on(name, wrapped);
  disposers.push(typeof unsub === 'function' ? unsub : () => source.off?.(name, wrapped));
}

function registerInterval(api, spec, disposers) {
  const every = spec?.every ?? spec?.ms ?? spec?.interval;
  const run = spec?.run ?? spec;
  if (!Number.isFinite(every) || every <= 0 || typeof run !== 'function') return;
  if (spec.immediate) run(api);
  if (api.lifecycle?.setInterval) {
    api.lifecycle.setInterval(() => run(api), every);
    return;
  }
  disposers.push(fallbackTimer('interval', run, every, api));
}

function registerTimeout(api, spec, disposers) {
  const after = spec?.after ?? spec?.ms ?? spec?.delay;
  const run = spec?.run ?? spec;
  if (!Number.isFinite(after) || after < 0 || typeof run !== 'function') return;
  if (api.lifecycle?.setTimeout) {
    api.lifecycle.setTimeout(() => run(api), after);
    return;
  }
  disposers.push(fallbackTimer('timeout', run, after, api));
}

/**
 * Declarative wrapper for new first-party scripts.
 *
 * Existing modules can keep `export default function register(api) { ... }`.
 * New/simple modules may prefer:
 *
 *   export default defineScript({
 *     commands: [{ name: 'ping', run(ctx) { ... } }],
 *     events: { 'world:tick': (payload, api) => { ... } },
 *     intervals: [{ every: 60_000, run(api) { ... } }],
 *     init(api) { ... },
 *   });
 */
export function defineScript(definition = {}) {
  return function registerDefinedScript(api) {
    const disposers = [];
    const addDisposer = (fn) => { if (typeof fn === 'function') disposers.push(fn); };

    addDisposer(callMaybeFactory(definition.init, api));

    for (const spec of asArray(callMaybeFactory(definition.commands, api))) {
      registerCommand(api, spec, disposers);
    }

    const events = callMaybeFactory(definition.events, api);
    if (Array.isArray(events)) {
      for (const entry of events) {
        if (Array.isArray(entry)) registerEvent(api, entry[0], entry[1], disposers);
        else registerEvent(api, entry?.name, entry?.run ?? entry?.handler, disposers);
      }
    } else if (events && typeof events === 'object') {
      for (const [name, handler] of Object.entries(events)) {
        registerEvent(api, name, handler, disposers);
      }
    }

    for (const spec of asArray(callMaybeFactory(definition.intervals, api))) {
      registerInterval(api, spec, disposers);
    }
    for (const spec of asArray(callMaybeFactory(definition.timeouts, api))) {
      registerTimeout(api, spec, disposers);
    }

    addDisposer(callMaybeFactory(definition.dispose, api));
    return () => {
      for (let i = disposers.length - 1; i >= 0; i--) {
        try { disposers[i](); }
        catch (e) { api.log?.(`script disposer threw: ${e?.message ?? e}`); }
      }
    };
  };
}
