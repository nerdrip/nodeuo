import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage ?? {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
globalThis.document = globalThis.document ?? {
  addEventListener: () => {},
  removeEventListener: () => {},
};

const { bus } = await import('../src/core/event-bus.js');
const { macroManager } = await import('../src/managers/macro-manager.js');

let runs = 0;
const originalRunAsync = macroManager.runAsync.bind(macroManager);
macroManager.runAsync = async () => { runs += 1; };

macroManager.macros = [{
  key: 'f1',
  actions: [{ kind: 'say', arg: 'ready' }],
  trigger: {
    event: 'combat:damage',
    when: [{ field: 'amount', op: '>', value: '50' }],
  },
}];
macroManager.attachTriggers();

const [summary] = macroManager.triggerSummaries();
assert.equal(summary.label, 'F1');
assert.equal(summary.event, 'combat:damage');
assert.equal(summary.predicate, 'amount > 50');
assert.equal(summary.action, 'say');

bus.emit('combat:damage', { amount: 25 });
assert.equal(runs, 0, 'symbolic trigger predicate should reject low values');
bus.emit('combat:damage', { amount: 75 });
assert.equal(runs, 1, 'symbolic trigger predicate should accept high values');

macroManager.clearTriggers();
macroManager.runAsync = originalRunAsync;

console.log('[smoke:macro-triggers] ok');
