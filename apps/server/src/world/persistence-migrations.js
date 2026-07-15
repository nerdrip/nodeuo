// Pure snapshot migrations. No filesystem access: operators can dry-run a
// plan safely, while persistence.js remains responsible for .bak rollback.
export const CURRENT_SNAPSHOT_VERSION = 1;

const migrations = new Map([
  [0, {
    to: 1,
    name: 'legacy-json-v0-to-v1',
    apply(input) {
      return {
        ...input,
        version: 1,
        mobiles: Array.isArray(input.mobiles) ? input.mobiles : [],
        items: Array.isArray(input.items) ? input.items : [],
        serials: input.serials ?? {},
        worldMeta: input.worldMeta ?? {},
      };
    },
  }],
]);

export function planSnapshotMigration(snapshot, targetVersion = CURRENT_SNAPSHOT_VERSION) {
  const from = Number(snapshot?.version ?? 0);
  const target = Number(targetVersion);
  const steps = [];
  if (!Number.isInteger(from) || from < 0 || !Number.isInteger(target) || target < 0) {
    return { ok: false, from, target, steps, reason: 'invalid-version' };
  }
  if (from > target) return { ok: false, from, target, steps, reason: 'newer-than-runtime' };
  let at = from;
  while (at < target) {
    const migration = migrations.get(at);
    if (!migration || migration.to <= at) {
      return { ok: false, from, target, steps, reason: `missing-migration-${at}` };
    }
    steps.push({ from: at, to: migration.to, name: migration.name });
    at = migration.to;
  }
  return {
    ok: true, from, target, steps,
    rollback: { strategy: 'restore-backup', originalVersion: from, backupRequired: steps.length > 0 },
  };
}

export function migrateSnapshot(snapshot, { dryRun = false, targetVersion = CURRENT_SNAPSHOT_VERSION } = {}) {
  const plan = planSnapshotMigration(snapshot, targetVersion);
  if (!plan.ok || dryRun || plan.steps.length === 0) return { plan, snapshot };
  let current = structuredClone(snapshot);
  for (const step of plan.steps) current = migrations.get(step.from).apply(current);
  return { plan, snapshot: current };
}
