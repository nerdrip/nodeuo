import { allItems } from '../../_spatial.js';
// `[imbueaudit [filter]` — GM listing of every imbue-locked item in
// the world. Useful when reviewing pre-frozen artifacts before a
// shard reset or merger, or when chasing down "why is this locked?"
// reports from players.
//
// Output: per-item line with serial, name (or itemId hex), who locked
// it, when (relative time). Sorted newest-first. Optional substring
// filter applies to item name + locker name.

const CAP = 50;

// Wave 32: in-memory ring of lock/unlock events. Cap 200 so the
// audit module isn't a memory hog. Survives only the current server
// process — the per-item `_imbueLockedAt` covers cross-restart audit
// of the CURRENT state, while this log captures the EVENT history
// (including unlocks the per-item record loses).
const TIMELINE_CAP = 200;
const _timeline = [];

/**
 * Append an event to the global timeline. Called from imbue-info.js
 * lock-toggle handler. Exported as `recordImbueAuditEvent` so other
 * scripts (and disenchant cleanups) can log too.
 */
export function recordImbueAuditEvent(event) {
  if (!event || !event.type) return;
  _timeline.push({ ts: Date.now(), ...event });
  if (_timeline.length > TIMELINE_CAP) _timeline.shift();
}

function ago(ms) {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

export default function (api) {
  const { commands, world } = api;
  if (!commands) return () => {};

  commands.register({
    name: 'imbueaudit',
    help: '[imbueaudit [filter] | clear-all CONFIRM | timeline [N] — list / clear / event log (GM).',
    access: 'GM',
    run(ctx) {
      // Wave 32: `[imbueaudit timeline [N]` — newest-first event log.
      // Default 30 entries, max 100. Reads from in-memory ring; on
      // server restart the log is empty (per-item `_imbueLockedAt`
      // still survives for current-state audit).
      // Wave 33: `actor <name>` filters by event.by (substring,
      // case-insensitive). Optional trailing N still respected.
      // Wave 34: `[imbueaudit timeline json` — JSON dump full ring
      // buffer to `saves/imbue-audit-<ts>.json`. Useful for offline
      // analysis or sharing with another GM. Writes async via
      // fs.promises.
      if (sub === 'timeline' && String(ctx.args[1] ?? '').toLowerCase() === 'json') {
        if (!_timeline.length) {
          ctx.state.sendSystemMessage('No lock events to export.');
          return;
        }
        (async () => {
          try {
            const fs = await import('node:fs');
            const path = await import('node:path');
            const saveDir = api.persistence?.saveDir
                         ?? path.resolve(process.cwd(), 'saves');
            const fname = `imbue-audit-${Date.now()}.json`;
            const target = path.join(saveDir, fname);
            const payload = {
              dumpedAt: new Date().toISOString(),
              dumpedBy: ctx.sender?.name ?? '(unknown)',
              eventCount: _timeline.length,
              events: _timeline,
            };
            await fs.promises.mkdir(saveDir, { recursive: true });
            await fs.promises.writeFile(target, JSON.stringify(payload, null, 2));
            ctx.state.sendSystemMessage(`Exported ${_timeline.length} events to ${target}`);
          } catch (e) {
            ctx.state.sendSystemMessage(`JSON dump failed: ${e.message}`);
          }
        })();
        return;
      }
      if (sub === 'timeline') {
        // Two sub-shapes:
        //   timeline [N]
        //   timeline actor <name> [N]
        let actorFilter = null;
        let nArg = ctx.args[1];
        if (String(ctx.args[1] ?? '').toLowerCase() === 'actor') {
          actorFilter = String(ctx.args[2] ?? '').toLowerCase();
          if (!actorFilter) {
            ctx.state.sendSystemMessage('Usage: [imbueaudit timeline actor <name> [N]');
            return;
          }
          nArg = ctx.args[3];
        }
        const n = Math.max(1, Math.min(100, parseInt(nArg, 10) || 30));
        if (!_timeline.length) {
          ctx.state.sendSystemMessage('No lock events recorded since server start.');
          return;
        }
        let pool = _timeline;
        if (actorFilter) {
          pool = pool.filter((e) => String(e.by ?? '').toLowerCase().includes(actorFilter));
        }
        if (!pool.length) {
          ctx.state.sendSystemMessage(`No timeline events matching actor "${actorFilter}".`);
          return;
        }
        const slice = pool.slice(-n);
        const headerSuffix = actorFilter ? ` (filter actor=${actorFilter})` : '';
        const lines = [`Imbue lock timeline — last ${slice.length} of ${pool.length}${headerSuffix}:`];
        for (let i = slice.length - 1; i >= 0; i--) {
          const e = slice[i];
          const verb = e.type === 'lock' ? 'LOCK ' : 'UNLOCK';
          lines.push(
            `  ${ago(e.ts).padEnd(8)} ${verb} 0x${(e.serial >>> 0).toString(16).padStart(8, '0')} ${(e.name ?? '?').padEnd(24)} by ${e.by ?? '?'}`,
          );
        }
        ctx.state.sendSystemMessage(lines.join('\n'));
        return;
      }
      // Wave 31: emergency clear-all gate. Two-token requirement
      // ([imbueaudit clear-all CONFIRM) prevents typo-disasters.
      // Lists every item that's about to be unlocked, then wipes
      // the lock fields. Idempotent — second call clears 0.
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      if (sub === 'clear-all') {
        const confirm = ctx.args[1];
        if (confirm !== 'CONFIRM') {
          ctx.state.sendSystemMessage(
            'Refused. Run `[imbueaudit clear-all CONFIRM` (case-sensitive) to wipe every lock.',
          );
          return;
        }
        const cleared = [];
        for (const it of allItems({ world })) {
          if (!it._imbueLocked) continue;
          const row = {
            serial: it.serial >>> 0,
            name: it.name ?? `item id 0x${(it.itemId | 0).toString(16)}`,
            by: it._imbueLockedBy ?? '(unknown)',
          };
          cleared.push(row);
          // Wave 32: emit a timeline event for each clear so the audit
          // log shows mass-unlocks too.
          recordImbueAuditEvent({
            type: 'unlock', serial: row.serial, name: row.name,
            by: `${ctx.sender?.name ?? 'GM'} (clear-all)`,
          });
          delete it._imbueLocked;
          delete it._imbueLockedBy;
          delete it._imbueLockedAt;
        }
        if (!cleared.length) {
          ctx.state.sendSystemMessage('No imbue-locked items to clear.');
          return;
        }
        const lines = [`Cleared lock on ${cleared.length} item(s):`];
        const cap = 30;
        for (const r of cleared.slice(0, cap)) {
          lines.push(`  0x${r.serial.toString(16).padStart(8, '0')} ${r.name.padEnd(28)} (was locked by ${r.by})`);
        }
        if (cleared.length > cap) {
          lines.push(`  … ${cleared.length - cap} more.`);
        }
        ctx.state.sendSystemMessage(lines.join('\n'));
        return;
      }
      const filter = ctx.args[0]?.toLowerCase();
      const rows = [];
      for (const it of allItems({ world })) {
        if (!it._imbueLocked) continue;
        if (filter) {
          const hay = (
            (it.name ?? '') + ' ' +
            (it._imbueLockedBy ?? '')
          ).toLowerCase();
          if (!hay.includes(filter)) continue;
        }
        rows.push({
          serial: it.serial >>> 0,
          name: it.name ?? `item id 0x${(it.itemId | 0).toString(16)}`,
          by: it._imbueLockedBy ?? '(unknown)',
          at: it._imbueLockedAt ?? null,
        });
      }
      rows.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
      if (!rows.length) {
        ctx.state.sendSystemMessage(
          filter ? `No locked items match "${filter}".` : 'No imbue-locked items.',
        );
        return;
      }
      const lines = [`Imbue-locked items: ${rows.length}${filter ? ` (filtered)` : ''}.`];
      for (const r of rows.slice(0, CAP)) {
        lines.push(
          `  0x${r.serial.toString(16).padStart(8, '0')} ${r.name.padEnd(28)} ${ago(r.at).padEnd(8)} by ${r.by}`,
        );
      }
      if (rows.length > CAP) {
        lines.push(`  … ${rows.length - CAP} more.`);
      }
      ctx.state.sendSystemMessage(lines.join('\n'));
    },
  });

  return () => commands.unregister('imbueaudit');
}
