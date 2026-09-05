import fs from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

export const WORLD_DATABASE_FILE = 'world.sqlite';
export const WORLD_DATABASE_SCHEMA_VERSION = 1;

const APPLICATION_ID = 0x4e554f; // "NUO"

export function worldDatabasePath(saveDir) {
  return path.join(path.resolve(saveDir), WORLD_DATABASE_FILE);
}

/**
 * Open the shard database and enforce the durability/performance profile used
 * by both the startup loader and the dedicated persistence worker.
 *
 * WAL is intentionally local-only: copying a live database must include its
 * -wal/-shm siblings or use SQLite's backup API. The admin backup path closes
 * or checkpoints the writer before copying.
 */
export function openWorldDatabase(saveDir) {
  fs.mkdirSync(saveDir, { recursive: true });
  const db = new DatabaseSync(worldDatabasePath(saveDir), {
    timeout: Math.max(1000, Number(process.env.UO_SQLITE_BUSY_TIMEOUT_MS) || 5000),
  });
  db.exec(`
    PRAGMA application_id = ${APPLICATION_ID};
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = ${process.env.UO_SQLITE_SYNCHRONOUS === 'FULL' ? 'FULL' : 'NORMAL'};
    PRAGMA foreign_keys = ON;
    PRAGMA temp_store = MEMORY;
    PRAGMA busy_timeout = ${Math.max(1000, Number(process.env.UO_SQLITE_BUSY_TIMEOUT_MS) || 5000)};
    PRAGMA wal_autocheckpoint = ${Math.max(128, Number(process.env.UO_SQLITE_WAL_PAGES) || 2048)};

    CREATE TABLE IF NOT EXISTS schema_info (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS entities (
      serial INTEGER PRIMARY KEY,
      kind INTEGER NOT NULL CHECK (kind IN (0, 1)),
      revision INTEGER NOT NULL DEFAULT 0,
      parent INTEGER,
      map INTEGER,
      x INTEGER,
      y INTEGER,
      z INTEGER,
      player_owned INTEGER NOT NULL DEFAULT 0 CHECK (player_owned IN (0, 1)),
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS entities_kind_idx ON entities(kind);
    CREATE INDEX IF NOT EXISTS entities_parent_idx ON entities(parent) WHERE parent IS NOT NULL;
    CREATE INDEX IF NOT EXISTS entities_location_idx ON entities(map, x, y) WHERE parent IS NULL;
    CREATE INDEX IF NOT EXISTS entities_player_owned_idx ON entities(player_owned) WHERE player_owned = 1;

    CREATE TABLE IF NOT EXISTS world_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      generation INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounts (
      username_key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) WITHOUT ROWID;
  `);
  const schema = db.prepare('SELECT value FROM schema_info WHERE key = ?').get('schema_version');
  if (schema && Number(schema.value) > WORLD_DATABASE_SCHEMA_VERSION) {
    db.close();
    throw new Error(`world.sqlite schema ${schema.value} is newer than supported ${WORLD_DATABASE_SCHEMA_VERSION}`);
  }
  db.prepare(`INSERT INTO schema_info(key, value) VALUES('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(WORLD_DATABASE_SCHEMA_VERSION));
  db.exec(`PRAGMA user_version = ${WORLD_DATABASE_SCHEMA_VERSION}`);
  return db;
}

function jsonStringify(value) {
  return JSON.stringify(value, (_key, entry) => {
    if (entry instanceof Set) return { $set: [...entry] };
    if (entry instanceof Map) return { $map: [...entry] };
    if (typeof entry === 'bigint') return { $bigint: String(entry) };
    return entry;
  });
}

function jsonParse(value) {
  return JSON.parse(value, (_key, entry) => {
    if (entry?.$set) return new Set(entry.$set);
    if (entry?.$map) return new Map(entry.$map);
    if (entry?.$bigint != null) return BigInt(entry.$bigint);
    return entry;
  });
}

/** Apply one ordered mutation batch. The caller owns and reuses `db`. */
export function applyWorldBatch(db, {
  rows = [], removals = [], meta = null, replaceAll = false, generation = 0,
} = {}) {
  const started = performance.now();
  const now = Date.now();
  let changes = 0;
  const upsert = db.prepare(`
    INSERT INTO entities(serial, kind, revision, parent, map, x, y, z, player_owned, payload, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(serial) DO UPDATE SET
      kind=excluded.kind,
      revision=excluded.revision,
      parent=excluded.parent,
      map=excluded.map,
      x=excluded.x,
      y=excluded.y,
      z=excluded.z,
      player_owned=excluded.player_owned,
      payload=excluded.payload,
      updated_at=excluded.updated_at
  `);
  const remove = db.prepare('DELETE FROM entities WHERE serial = ?');
  const writeMeta = db.prepare(`
    INSERT INTO world_meta(id, generation, payload, updated_at) VALUES(1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      generation=excluded.generation,
      payload=excluded.payload,
      updated_at=excluded.updated_at
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    if (replaceAll) {
      changes += Number(db.prepare('DELETE FROM entities').run().changes) || 0;
    }
    for (const serial of removals) {
      changes += Number(remove.run(Number(serial) >>> 0).changes) || 0;
    }
    for (const row of rows) {
      const entity = row.data;
      if (!entity || !Number(entity.serial)) continue;
      changes += Number(upsert.run(
        Number(entity.serial) >>> 0,
        row.kind === 'mobile' ? 0 : 1,
        Math.max(0, Number(row.revision) || 0),
        entity.parent == null ? null : Number(entity.parent) >>> 0,
        entity.map == null ? null : Number(entity.map) | 0,
        entity.x == null ? null : Number(entity.x) | 0,
        entity.y == null ? null : Number(entity.y) | 0,
        entity.z == null ? null : Number(entity.z) | 0,
        row.playerOwned ? 1 : 0,
        jsonStringify(entity),
        now,
      ).changes) || 0;
    }
    if (meta) writeMeta.run(
      Math.max(0, Number(generation ?? meta?.worldMeta?.saveGeneration) || 0),
      jsonStringify(meta),
      now,
    );
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve original failure */ }
    throw error;
  }
  return {
    rows: rows.length,
    removals: removals.length,
    changes,
    bytes: rows.reduce((total, row) => total + Buffer.byteLength(jsonStringify(row.data)), 0),
    ms: Number((performance.now() - started).toFixed(3)),
  };
}

export function writeWorldBatchSync(saveDir, batch) {
  const db = openWorldDatabase(saveDir);
  try { return applyWorldBatch(db, batch); }
  finally { db.close(); }
}

export function loadWorldSnapshotSync(saveDir) {
  const db = openWorldDatabase(saveDir);
  try {
    const metaRow = db.prepare('SELECT generation, payload FROM world_meta WHERE id = 1').get();
    const mobiles = [];
    const items = [];
    let corruptRows = 0;
    for (const row of db.prepare('SELECT kind, payload FROM entities ORDER BY serial').iterate()) {
      try {
        const entity = jsonParse(row.payload);
        if (Number(row.kind) === 0) mobiles.push(entity);
        else items.push(entity);
      } catch {
        corruptRows++;
      }
    }
    const meta = metaRow?.payload ? jsonParse(metaRow.payload) : {};
    return {
      exists: mobiles.length > 0 || items.length > 0 || Boolean(metaRow),
      corruptRows,
      snapshot: {
        version: Number(meta.version) || 1,
        generation: Number(metaRow?.generation) || 0,
        mobiles,
        items,
        serials: meta.serials ?? {},
        worldMeta: meta.worldMeta ?? {},
      },
    };
  } finally {
    db.close();
  }
}

export function sqliteCheckpointSync(saveDir, mode = 'PASSIVE') {
  const allowed = new Set(['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE']);
  const selected = allowed.has(String(mode).toUpperCase()) ? String(mode).toUpperCase() : 'PASSIVE';
  const db = openWorldDatabase(saveDir);
  try { return db.prepare(`PRAGMA wal_checkpoint(${selected})`).get() ?? {}; }
  finally { db.close(); }
}

export function getSchemaValueSync(saveDir, key) {
  const db = openWorldDatabase(saveDir);
  try { return db.prepare('SELECT value FROM schema_info WHERE key = ?').get(String(key))?.value ?? null; }
  finally { db.close(); }
}

export function setSchemaValueSync(saveDir, key, value) {
  const db = openWorldDatabase(saveDir);
  try {
    db.prepare(`INSERT INTO schema_info(key, value) VALUES(?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(key), String(value));
  } finally {
    db.close();
  }
}

export function loadAccountsSync(saveDir) {
  const db = openWorldDatabase(saveDir);
  try {
    const accounts = [];
    for (const row of db.prepare('SELECT payload FROM accounts ORDER BY username_key').iterate()) {
      accounts.push(jsonParse(row.payload));
    }
    return accounts;
  } finally {
    db.close();
  }
}

export function replaceAccountsSync(saveDir, accounts) {
  const db = openWorldDatabase(saveDir);
  const insert = db.prepare('INSERT INTO accounts(username_key, payload, updated_at) VALUES(?, ?, ?)');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM accounts');
    const now = Date.now();
    for (const account of accounts) {
      const key = String(account?.username ?? '').trim().toLowerCase();
      if (!key) continue;
      insert.run(key, jsonStringify(account), now);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve original failure */ }
    throw error;
  } finally {
    db.close();
  }
}

export function sqliteDiagnosticsSync(saveDir) {
  const file = worldDatabasePath(saveDir);
  const db = openWorldDatabase(saveDir);
  try {
    const counts = db.prepare(`SELECT
      COUNT(*) AS entities,
      SUM(CASE WHEN kind=0 THEN 1 ELSE 0 END) AS mobiles,
      SUM(CASE WHEN kind=1 THEN 1 ELSE 0 END) AS items,
      SUM(CASE WHEN player_owned=1 THEN 1 ELSE 0 END) AS playerOwned
      FROM entities`).get();
    const accounts = db.prepare('SELECT COUNT(*) AS count FROM accounts').get()?.count ?? 0;
    const generation = db.prepare('SELECT generation FROM world_meta WHERE id=1').get()?.generation ?? 0;
    const size = (candidate) => { try { return fs.statSync(candidate).size; } catch { return 0; } };
    return {
      engine: 'sqlite-wal',
      file,
      schemaVersion: WORLD_DATABASE_SCHEMA_VERSION,
      generation: Number(generation) || 0,
      entities: Number(counts?.entities) || 0,
      mobiles: Number(counts?.mobiles) || 0,
      items: Number(counts?.items) || 0,
      playerOwned: Number(counts?.playerOwned) || 0,
      accounts: Number(accounts) || 0,
      databaseBytes: size(file),
      walBytes: size(`${file}-wal`),
      shmBytes: size(`${file}-shm`),
    };
  } finally {
    db.close();
  }
}

export function verifyWorldDatabaseSync(saveDir) {
  const file = worldDatabasePath(saveDir);
  return verifyWorldDatabaseFileSync(file);
}

export function verifyWorldDatabaseFileSync(file, { cleanupSidecars = false } = {}) {
  const resolved = path.resolve(file);
  if (!fs.existsSync(resolved)) return { ok: false, file: resolved, error: 'SQLite database does not exist' };
  const db = new DatabaseSync(resolved, { readOnly: true, timeout: 5000 });
  let report;
  try {
    const integrity = [...db.prepare('PRAGMA integrity_check').iterate()]
      .map((row) => String(row.integrity_check ?? Object.values(row)[0] ?? ''));
    const foreignKeys = [...db.prepare('PRAGMA foreign_key_check').iterate()];
    const diagnostics = sqliteDiagnosticsFromOpenDatabase(db, resolved);
    report = {
      ok: integrity.length === 1 && integrity[0] === 'ok' && foreignKeys.length === 0,
      file: resolved,
      integrity,
      foreignKeyErrors: foreignKeys,
      ...diagnostics,
    };
  } finally {
    db.close();
    if (cleanupSidecars) {
      const wal = `${resolved}-wal`;
      const shm = `${resolved}-shm`;
      let walIsEmpty = !fs.existsSync(wal);
      try { walIsEmpty ||= fs.statSync(wal).size === 0; } catch { /* absent */ }
      if (walIsEmpty) {
        try { fs.rmSync(wal, { force: true }); } catch { /* best effort */ }
        try { fs.rmSync(shm, { force: true }); } catch { /* best effort */ }
      }
    }
  }
  if (cleanupSidecars && report) {
    const size = (candidate) => { try { return fs.statSync(candidate).size; } catch { return 0; } };
    report.walBytes = size(`${resolved}-wal`);
    report.shmBytes = size(`${resolved}-shm`);
  }
  return report;
}

export async function createWorldDatabaseBackup(saveDir, destination) {
  const target = path.resolve(destination);
  if (fs.existsSync(target)) throw new Error(`backup already exists: ${target}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = openWorldDatabase(saveDir);
  try {
    const pages = await backup(db, target, { rate: 128 });
    const verification = verifyWorldDatabaseFileSync(target, { cleanupSidecars: true });
    if (!verification.ok) throw new Error(`SQLite backup verification failed: ${verification.integrity?.join(', ') ?? verification.error}`);
    return { ...verification, pages };
  } finally {
    db.close();
  }
}

function sqliteDiagnosticsFromOpenDatabase(db, file) {
  const counts = db.prepare(`SELECT
    COUNT(*) AS entities,
    SUM(CASE WHEN kind=0 THEN 1 ELSE 0 END) AS mobiles,
    SUM(CASE WHEN kind=1 THEN 1 ELSE 0 END) AS items,
    SUM(CASE WHEN player_owned=1 THEN 1 ELSE 0 END) AS playerOwned
    FROM entities`).get();
  const accounts = db.prepare('SELECT COUNT(*) AS count FROM accounts').get()?.count ?? 0;
  const generation = db.prepare('SELECT generation FROM world_meta WHERE id=1').get()?.generation ?? 0;
  const size = (candidate) => { try { return fs.statSync(candidate).size; } catch { return 0; } };
  return {
    engine: 'sqlite-wal',
    schemaVersion: WORLD_DATABASE_SCHEMA_VERSION,
    generation: Number(generation) || 0,
    entities: Number(counts?.entities) || 0,
    mobiles: Number(counts?.mobiles) || 0,
    items: Number(counts?.items) || 0,
    playerOwned: Number(counts?.playerOwned) || 0,
    accounts: Number(accounts) || 0,
    databaseBytes: size(file),
    walBytes: size(`${file}-wal`),
    shmBytes: size(`${file}-shm`),
  };
}
