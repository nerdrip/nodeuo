// GM/Admin tooling — commands every shard operator needs.
//
// Implemented here (save/shutdown/account moderation live in their dedicated
// command modules so each public name has exactly one owner):
//   [info           — target an item/mobile and dump its key fields (GM)
//   [props          — alias of [info (GM)
//   [tpto <user>    — teleport yourself to <user>'s location (GM)

import { moveMobile } from '../../_movement.js';
import { allItems, allMobiles } from '../../_spatial.js';
import { itemBySerial, mobileBySerial } from '../../_entities.js';

function findStateByAccount(world, accountName) {
  const lower = String(accountName).toLowerCase();
  for (const m of allMobiles({ world })) {
    const acct = m.client?.account;
    if (!acct) continue;
    if (String(acct.username).toLowerCase() === lower) return m.client;
  }
  return null;
}

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  const { commands, world, ctx, protocol, targeting } = api;

  // Synchronous full SQLite reconciliation. This is an explicit maintenance
  // path; normal autosaves persist only dirty entities in the worker.
  function doSyncSave(cctx, opts = {}) {
    const save = api.persistence?.saveWorldSync;
    if (!save) {
      cctx.state.sendSystemMessage('Persistence subsystem unavailable.');
      return;
    }
    const dir = api.persistence?.saveDir ?? 'saves';
    const t0 = Date.now();
    try {
      save(world, dir);
      const ms = Date.now() - t0;
      const summary = `World saved (mobiles=${[...allMobiles({ world })].length}, items=${[...allItems({ world })].length}, ${ms}ms).`;
      cctx.state.sendSystemMessage(summary);
      // ServUO `[save` broadcasts "The world is saving, please wait..." +
      // a "World save complete." line to all clients. Echo on completion
      // so other connected players see the lag spike came from a save.
      if (opts.broadcast) {
        for (const m of allMobiles({ world })) {
          if (!m.client || m.client === cctx.state) continue;
          try { m.client.sendSystemMessage?.(`World save complete (${ms}ms).`); } catch { /* gone */ }
        }
      }
    } catch (e) {
      cctx.state.sendSystemMessage(`Save failed: ${e.message}`);
    }
  }

  // Async incremental save — serializes only dirty entities and commits the
  // transaction in the persistence worker.
  function doAsyncSave(cctx, opts = {}) {
    const save = api.persistence?.saveWorldAsync;
    const dir = api.persistence?.saveDir ?? 'saves';
    if (!save) {
      // Fall back to sync save if async path isn't exported.
      doSyncSave(cctx, opts);
      return;
    }
    cctx.state.sendSystemMessage('Background save started…');
    save(world, dir).then((r) => {
      const kb = (r.bytes / 1024).toFixed(1);
      cctx.state.sendSystemMessage(`Background save done — ${kb} KB in ${r.ms}ms (${r.format ?? 'json'}).`);
      if (opts.broadcast) {
        for (const m of allMobiles({ world })) {
          if (!m.client || m.client === cctx.state) continue;
          try { m.client.sendSystemMessage?.(`World save complete (${r.ms}ms).`); } catch { /* gone */ }
        }
      }
    }).catch((e) => {
      cctx.state.sendSystemMessage(`Background save failed: ${e.message}`);
    });
  }

  // Alias matching ServUO's documented `[savenow` / RunUO's `[save now`.
  // Kept as a convenience for ops familiar with the upstream commands.
  commands.register({
    name: 'savenow',
    help: 'Force a complete synchronous reconciliation into saves/world.sqlite.',
    access: 'Admin',
    hidden: true,
    run: (cctx) => doSyncSave(cctx, { broadcast: true }),
  });

  commands.register({
    name: 'bgsave',
    help: 'Commit pending world changes to SQLite in the background.',
    access: 'Admin',
    run: (cctx) => doAsyncSave(cctx, { broadcast: true }),
  });

  commands.register({
    name: 'savestats',
    help: 'Print the size of the last on-disk save and its mtime.',
    access: 'Admin',
    run: async (cctx) => {
      try {
        const dir = api.persistence?.saveDir ?? 'saves';
        const stats = api.persistence?.diagnostics?.(dir);
        const database = stats?.database ?? stats?.mutationJournal?.database;
        if (!database) { cctx.state.sendSystemMessage('No SQLite save database found.'); return; }
        const kb = ((database.databaseBytes + database.walBytes) / 1024).toFixed(1);
        cctx.state.sendSystemMessage(
          `SQLite save: ${kb} KB, ${database.mobiles} mobiles, ${database.items} items, ` +
          `${database.accounts} accounts; pending=${stats?.mutationJournal?.pending ?? 0}.`,
        );
      } catch (e) {
        cctx.state.sendSystemMessage(`savestats failed: ${e.message}`);
      }
    },
  });

  function describe(serial) {
    const mob = mobileBySerial({ world }, serial);
    if (mob) {
      return [
        `Mobile 0x${serial.toString(16).padStart(8, '0')} "${mob.name}"`,
        `  body=0x${mob.body.toString(16)} hue=0x${(mob.hue ?? 0).toString(16)} flags=0x${(mob.flags ?? 0).toString(16)} noto=${mob.notoriety}`,
        `  pos=(${mob.x},${mob.y},${mob.z}) map=${mob.map} dir=${mob.direction}`,
        `  hp=${mob.hp}/${mob.hpMax} mana=${mob.mana}/${mob.manaMax} stam=${mob.stam}/${mob.stamMax}`,
        `  str=${mob.str} dex=${mob.dex} int=${mob.int} gold=${mob.gold ?? 0}`,
        mob.hidden ? '  HIDDEN' : null,
      ].filter(Boolean);
    }
    const item = itemBySerial({ world }, serial);
    if (item) {
      return [
        `Item 0x${serial.toString(16).padStart(8, '0')} "${item.name ?? '?'}"`,
        `  itemId=0x${item.itemId.toString(16)} hue=0x${(item.hue ?? 0).toString(16)} amount=${item.amount ?? 1}`,
        item.parent
          ? `  parent=0x${item.parent.toString(16).padStart(8, '0')} grid=(${item.gridX ?? 0},${item.gridY ?? 0})`
          : `  pos=(${item.x},${item.y},${item.z}) map=${item.map}`,
      ];
    }
    return [`Nothing known at 0x${serial.toString(16)}.`];
  }

  function inspect(cctx) {
    if (!targeting) {
      cctx.state.sendSystemMessage('Targeting subsystem unavailable.');
      return;
    }
    cctx.state.sendSystemMessage('Target the entity to inspect.');
    targeting.request(cctx.state, (picked) => {
      if (!picked || !picked.serial) {
        cctx.state.sendSystemMessage('Cancelled.');
        return;
      }
      for (const line of describe(picked.serial >>> 0)) {
        cctx.state.sendSystemMessage(line);
      }
    });
  }
  commands.register({ name: 'info',  help: '[info  — describe a targeted entity.', access: 'GM', run: inspect });

  function tpToUser(cctx, args) {
    if (!args[0]) { cctx.state.sendSystemMessage('Usage: [tp <username>'); return; }
    const conn = findStateByAccount(world, args[0]);
    const target = conn?.mobile;
    if (!target) { cctx.state.sendSystemMessage(`No connected player "${args[0]}".`); return; }
    const me = cctx.sender;
    moveMobile(api, me, { x: target.x, y: target.y, z: target.z, map: target.map });
    cctx.state.send(protocol.mobileUpdate({
      serial: me.serial, body: me.body, hue: me.hue, flags: me.flags,
      x: me.x, y: me.y, z: me.z, direction: me.direction,
    }));
    cctx.state.sendSystemMessage(`Teleported to ${args[0]}.`);
  }
  // ServUO command aliases — `[tp` is the canonical short form; `[tpto`
  // remains dispatchable for old macros but is not a second catalogue row.
  commands.register({
    name: 'tp', aliases: ['tpto'], help: '[tp <user>', access: 'GM', run: tpToUser,
  });

  // [bring <user> — pull a connected player to YOUR coords.
  commands.register({
    name: 'bring',
    help: '[bring <username> — teleport <user> to your position.',
    access: 'GM',
    run: (cctx, args) => {
      if (!args[0]) { cctx.state.sendSystemMessage('Usage: [bring <username>'); return; }
      const conn = findStateByAccount(world, args[0]);
      const target = conn?.mobile;
      if (!target) { cctx.state.sendSystemMessage(`No connected player "${args[0]}".`); return; }
      const me = cctx.sender;
      moveMobile(api, target, { x: me.x, y: me.y, z: me.z, map: me.map });
      conn.send(protocol.mobileUpdate({
        serial: target.serial, body: target.body, hue: target.hue, flags: target.flags,
        x: target.x, y: target.y, z: target.z, direction: target.direction,
      }));
      conn.sendSystemMessage?.(`You have been teleported by ${me.name}.`);
      cctx.state.sendSystemMessage(`Brought ${args[0]} to you.`);
    },
  });

  // [restart — graceful shutdown that the launcher script restarts.
  // Same path as [shutdown but logs "restart" in the system message.
  commands.register({
    name: 'restart',
    help: '[restart — graceful restart (relies on launcher to relaunch).',
    access: 'Admin',
    run: (cctx) => {
      cctx.state.sendSystemMessage('Restart requested — server going down.');
      try { doSyncSave(cctx, { silent: true }); } catch { /* save best-effort */ }
      try { process.kill(process.pid, 'SIGTERM'); } catch { /* ignore */ }
    },
  });

  // [stats — quick world stats dump (mob count, item count, accounts,
  // uptime, memory). Mirrors ServUO `[stats` admin diagnostic.
  commands.register({
    name: 'stats',
    help: '[stats — world / process diagnostic snapshot.',
    access: 'GM',
    run: (cctx) => {
      const m = process.memoryUsage();
      const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;
      const uptime = `${(process.uptime() / 60).toFixed(1)}min`;
      const lines = [
        `Server uptime: ${uptime}`,
        `Mobiles: ${[...allMobiles({ world })].length}  Items: ${[...allItems({ world })].length}`,
        `Accounts: ${ctx.accounts?.accounts?.size ?? 0}`,
        `Memory rss=${mb(m.rss)} heap=${mb(m.heapUsed)}/${mb(m.heapTotal)}`,
      ];
      for (const ln of lines) cctx.state.sendSystemMessage(ln);
    },
  });

  return () => {
    for (const n of ['savenow', 'bgsave', 'savestats', 'info',
                     'tp', 'bring', 'restart', 'stats']) {
      commands.unregister(n);
    }
  };
}
