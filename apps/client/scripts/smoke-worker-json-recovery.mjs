import assert from 'node:assert/strict';

const workers = [];
globalThis.Worker = class FakeWorker {
  constructor() { this.terminated = false; workers.push(this); }
  postMessage(message) { this.lastMessage = message; }
  terminate() { this.terminated = true; }
};

const { fetchJsonInWorker, shutdownJsonWorker } = await import('../src/assets/worker-json.js');

const first = fetchJsonInWorker('/assets/tiledata.json');
assert.equal(workers.length, 1);
workers[0].onerror({ message: 'decode worker crashed' });
await assert.rejects(first, /decode worker crashed/);
assert.equal(workers[0].terminated, true);

const second = fetchJsonInWorker('/assets/tiledata.json');
assert.equal(workers.length, 2, 'a failed worker should be replaced on retry');
workers[0].onerror({ message: 'late error from retired worker' });
assert.equal(workers[1].terminated, false, 'a retired worker cannot kill its replacement');
workers[1].onmessage({ data: { id: workers[1].lastMessage.id, ok: true, data: { ready: true } } });
assert.deepEqual(await second, { ready: true });

const third = fetchJsonInWorker('/assets/animdata.json');
shutdownJsonWorker();
await assert.rejects(third, /shut down/);
assert.equal(workers[1].terminated, true);

console.log('[smoke:worker-json-recovery] ok');
