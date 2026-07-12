// Krampus event wiring — runs the winter-holiday boss.
//
//   `[krampus status`  — view current state (spawn ETA, naughty/nice score)
//   `[krampus spawn`   — (Admin) force spawn outside the regular cadence
//
// The script:
//  • Polls `shouldSpawn()` every 5 minutes — when due AND in-season,
//    spawns Krampus at one of 5 city centres + shard-wide announce.
//  • Registers a `corpse.addKillHook` for `_krampusBoss` mobs — rolls
//    a per-killer artifact via `rollKrampusArtifact(account)` and
//    drops it on the corpse tile + announces.
//  • Subscribes to `notoriety.onCriminalFlag` to bump the offender's
//    naughty score on every criminal action.

import { onCriminalFlag } from '../_notoriety.js';
import { mobileBySerial } from '../_entities.js';
import { allMobiles } from '../_spatial.js';
import { createItem } from '../_items.js';

const POLL_MS = 5 * 60 * 1000;

export default function register(api) {
  if (!api.world) return () => {};
  const krampus = api.systems?.krampusEvent;
  if (!krampus) {
    api.log?.('[krampus] krampusEvent system unavailable');
    return () => {};
  }

  krampus.ensureState();

  // Spawn tick.
  const poll = () => {
    try {
      if (!krampus.shouldSpawn()) return;
      const boss = krampus.spawnKrampus(api.world, {
        spawnFactory: api.ctx?.spawnFactory ?? api.spawnFactory,
      });
      if (!boss) return;
      const pkt = api.protocol?.unicodeMessage?.({
        text: `Krampus has been sighted near ${krampus.snapshot()?.currentLocation?.name ?? 'a town'}! He has 30 minutes to deliver punishment!`,
        hue: 0x21, font: 3, name: 'System',
      });
      if (pkt) for (const m of allMobiles(api)) {
        if (m.client) m.client.send(pkt);
      }
      api.log?.(`[krampus] spawned at ${krampus.snapshot()?.currentLocation?.name}`);
    } catch (e) {
      api.log?.(`[krampus] poll threw: ${e.message}`);
    }
  };
  const interval = api.lifecycle?.setInterval?.(poll, POLL_MS) ?? setInterval(poll, POLL_MS);
  interval.unref?.();

  // Criminal flag → naughty score.
  let unsubFlag = null;
  try {
    unsubFlag = onCriminalFlag(api, (mob) => {
      const acct = mob?.client?.account;
      if (!acct) return;
      krampus.scoreNaughty(acct, 1);
    });
  } catch { /* notoriety hook optional */ }

  // Boss death — drop artifacts.
  const unhook = api.corpse?.addKillHook?.((_world, victim, killer) => {
    if (!victim?._krampusBoss) return;
    const account = killer?.client?.account ?? {};
    const pick = krampus.rollKrampusArtifact(account);
    if (!pick) return;
    try {
      const item = createItem(api, api.world, {
        itemId: pick.itemId, hue: pick.hue, name: pick.name,
        x: victim.x, y: victim.y, z: victim.z, map: victim.map,
        movable: true,
      });
      if (item) item.artifact = pick.name;
    } catch (e) { api.log?.(`[krampus] artifact drop failed: ${e.message}`); }
    const announce = api.protocol?.unicodeMessage?.({
      text: `Krampus has been defeated! ${killer?.name ?? 'A hero'} earned ${pick.name}!`,
      hue: 0x47E, font: 3, name: 'System',
    });
    if (announce) for (const m of allMobiles(api)) {
      if (m.client) m.client.send(announce);
    }
  });

  // Command.
  if (api.commands) {
    const spec = {
      name: 'krampus',
      help: '[krampus status|spawn — Krampus winter event.',
      access: 'Player',
      run(ctx) {
        const sub = String(ctx.args[0] ?? '').toLowerCase();
        if (sub === '' || sub === 'gump' || sub === 'ledger') {
          const score = krampus.scoreOf?.(ctx.state?.account)
            ?? ctx.state?.account?._krampusScore
            ?? { nice: 0, naughty: 0 };
          ctx.state.sendSystemMessage?.(
            `@@OPEN_KRAMPUS_GUMP@@${score.nice | 0}|${score.naughty | 0}`,
          );
          return;
        }
        if (sub === 'spawn') {
          const access = ctx.state?.account?.accessLevel ?? 'Player';
          if (access !== 'GM' && access !== 'Admin') {
            ctx.state.sendSystemMessage?.('GM only.');
            return;
          }
          const boss = krampus.spawnKrampus(api.world, {
            spawnFactory: api.ctx?.spawnFactory ?? api.spawnFactory,
          });
          ctx.state.sendSystemMessage?.(
            boss ? `Krampus spawned at ${krampus.snapshot()?.currentLocation?.name}.`
                 : 'Spawn failed.',
          );
          return;
        }
        const s = krampus.snapshot();
        const my = ctx.state?.account?._krampusScore ?? { nice: 0, naughty: 0 };
        ctx.state.sendSystemMessage?.(`Your tally — nice: ${my.nice}, naughty: ${my.naughty}.`);
        if (s?.currentLocation) {
          const aliveBoss = mobileBySerial(api, s.currentBossSerial);
          if (aliveBoss && (aliveBoss.hp | 0) > 0) {
            ctx.state.sendSystemMessage?.(
              `Krampus stalks near ${s.currentLocation.name} (${aliveBoss.hp}/${aliveBoss.hpMax}).`,
            );
            return;
          }
        }
        const nextEta = Math.max(0, (s?.lastSpawnAt ?? 0) + 4 * 3600_000 - Date.now());
        ctx.state.sendSystemMessage?.(
          nextEta > 0
            ? `Next sighting in ~${Math.ceil(nextEta / 3600_000)}h.`
            : 'Krampus may appear soon.',
        );
      },
    };
    if (!api.lifecycle?.command?.(spec)) api.commands.register(spec);
  }

  return () => {
    if (!api.lifecycle) clearInterval(interval);
    try { unsubFlag?.(); } catch { /* ignore */ }
    try { unhook?.(); } catch { /* ignore */ }
    if (!api.lifecycle) {
      try { api.commands?.unregister?.('krampus'); } catch { /* ignore */ }
    }
  };
}
