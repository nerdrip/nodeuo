// Worker-thread JSON.stringify + optional gzip helper for large saves.
//
// Main thread sends `{ basename, snap, useGzip }`; worker replies with
// `{ basename, json | gzip }`. The structured-clone cost of shipping the
// snapshot to the worker is ~30-50 % of the stringify cost, so this is
// only a win for snapshots larger than ~3 MB (typical mobs.json on a
// populated shard). For smaller saves persistence.js uses the inline
// setImmediate-yielding path.

import { parentPort } from 'node:worker_threads';
import zlib from 'node:zlib';

if (!parentPort) throw new Error('persistence-worker.js loaded outside a worker');

parentPort.on('message', (msg) => {
  const { basename, snap, useGzip } = msg ?? {};
  try {
    const json = JSON.stringify(snap);
    if (useGzip) {
      const gz = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 6 });
      parentPort.postMessage({ basename, gz, jsonBytes: json.length });
    } else {
      parentPort.postMessage({ basename, json });
    }
  } catch (e) {
    parentPort.postMessage({ basename, error: e?.message ?? String(e) });
  }
});
