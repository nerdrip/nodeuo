import { parentPort } from 'node:worker_threads';
import { applyWorldBatch, openWorldDatabase } from './sqlite-store.js';

const databases = new Map();

function databaseFor(saveDir) {
  let db = databases.get(saveDir);
  if (!db) {
    db = openWorldDatabase(saveDir);
    databases.set(saveDir, db);
  }
  return db;
}

parentPort.on('message', (message) => {
  const { id, operation, saveDir } = message ?? {};
  try {
    if (operation === 'write') {
      const result = applyWorldBatch(databaseFor(saveDir), message.batch);
      parentPort.postMessage({ id, ok: true, result });
      return;
    }
    if (operation === 'checkpoint') {
      const row = databaseFor(saveDir).prepare(`PRAGMA wal_checkpoint(${message.mode === 'TRUNCATE' ? 'TRUNCATE' : 'PASSIVE'})`).get();
      parentPort.postMessage({ id, ok: true, result: row ?? {} });
      return;
    }
    if (operation === 'close') {
      const db = databases.get(saveDir);
      if (db) {
        db.close();
        databases.delete(saveDir);
      }
      parentPort.postMessage({ id, ok: true, result: {} });
      return;
    }
    throw new Error(`unknown SQLite persistence operation: ${operation}`);
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: String(error?.stack ?? error) });
  }
});
