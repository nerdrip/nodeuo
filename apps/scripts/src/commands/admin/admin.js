// [admin — central GM control surface. Mirrors ServUO `Gumps/AdminGump.cs`
// (1.2k LOC) collapsed into chat verbs. Four "tabs":
//   accounts  — list / kick / ban / unban / promote
//   chars     — list / find / teleport-to / kill / ressurect
//   world     — counts, save, broadcast
//   items     — count by kind, prune-decay, freeze area
//
// All actions require GM access. Subcommands match the gump page
// labels so a future client gump can replay them.

import { moveMobile } from '../../_movement.js';
import { destroyItemBySerial } from '../../_items.js';
import {
  allItems,
  allMobiles,
  onlineMobiles,
  sendSystemMessageToOnline,
} from '../../_spatial.js';

export default function register(api) {
  if (!api.commands) return () => {};

  api.commands.register({
    name: 'admin',
    help: '[admin accounts|chars|world|items <subcmd…>',
    access: 'Admin',
    run(ctx, args) {
      const sender = ctx.sender;
      const tab = (args?.[0] ?? '').toLowerCase();
      const sub = (args?.[1] ?? '').toLowerCase();
      const rest = args.slice(2);

      switch (tab) {
        case 'gump':
        case 'panel': {
          // Phase H.3 — open the AdminGump overlay (self-installing,
          // listens to chat:system bus + dispatches `[admin <tab>` chat).
          ctx.state.sendSystemMessage?.('@@OPEN_ADMIN_GUMP@@');
          return;
        }
        case 'accounts': return runAccounts(api, ctx, sender, sub, rest);
        case 'chars':    return runChars(api, ctx, sender, sub, rest);
        case 'world':    return runWorld(api, ctx, sender, sub, rest);
        case 'items':    return runItems(api, ctx, sender, sub, rest);
        case 'help':
        default:
          ctx.state.sendSystemMessage('[admin tabs:');
          ctx.state.sendSystemMessage('  accounts list|kick <name>|ban <name>|unban <name>|promote <name> <Player|Counselor|GM|Admin>');
          ctx.state.sendSystemMessage('  chars list|find <name>|teleto <name>|kill <name>|res <name>');
          ctx.state.sendSystemMessage('  world counts|save|broadcast <msg>');
          ctx.state.sendSystemMessage('  items counts|prune|freeze <radius>');
      }
    },
  });

  return () => {};
}

function runAccounts(api, ctx, sender, sub, rest) {
  const accs = api.ctx?.accounts;
  if (!accs) { ctx.state.sendSystemMessage('No account DB.'); return; }
  switch (sub) {
    case 'list': {
      let n = 0;
      for (const acc of accs.accounts.values()) {
        if (n++ >= 25) { ctx.state.sendSystemMessage('  …(more)'); break; }
        const al = acc.accessLevel ?? 'Player';
        const banned = acc.banned ? ' [BANNED]' : '';
        ctx.state.sendSystemMessage(`  ${acc.name} (${al})${banned}`);
      }
      ctx.state.sendSystemMessage(`Total: ${accs.accounts.size}`);
      return;
    }
    case 'kick': {
      const target = rest[0];
      const a = accs.get(target);
      if (!a) { ctx.state.sendSystemMessage(`No such account: ${target}`); return; }
      // Find the live socket bound to this account
      for (const m of onlineMobiles(api)) {
        if (m.client?.account?.name === target) {
          try { m.client.disconnect?.(); } catch { /* ignore */ }
          ctx.state.sendSystemMessage(`Kicked ${target}.`);
          return;
        }
      }
      ctx.state.sendSystemMessage(`${target} is not online.`);
      return;
    }
    case 'ban': {
      const target = rest[0];
      const a = accs.get(target);
      if (!a) { ctx.state.sendSystemMessage(`No such account: ${target}`); return; }
      a.banned = true;
      ctx.state.sendSystemMessage(`Banned ${target}.`);
      return;
    }
    case 'unban': {
      const target = rest[0];
      const a = accs.get(target);
      if (!a) { ctx.state.sendSystemMessage(`No such account: ${target}`); return; }
      a.banned = false;
      ctx.state.sendSystemMessage(`Unbanned ${target}.`);
      return;
    }
    case 'promote': {
      const target = rest[0];
      const level  = rest[1];
      if (!['Player', 'Counselor', 'GM', 'Admin'].includes(level)) {
        ctx.state.sendSystemMessage('Bad level. Use Player|Counselor|GM|Admin.');
        return;
      }
      const a = accs.get(target);
      if (!a) { ctx.state.sendSystemMessage(`No such account: ${target}`); return; }
      a.accessLevel = level;
      ctx.state.sendSystemMessage(`${target} → ${level}.`);
      return;
    }
    default:
      ctx.state.sendSystemMessage('admin accounts: list|kick|ban|unban|promote');
  }
}

function runChars(api, ctx, sender, sub, rest) {
  switch (sub) {
    case 'list': {
      let n = 0;
      for (const m of onlineMobiles(api)) {
        if (n++ >= 30) { ctx.state.sendSystemMessage('  …(more)'); break; }
        ctx.state.sendSystemMessage(`  ${m.name} @ (${m.x},${m.y}) HP ${m.hp}/${m.hpMax}`);
      }
      ctx.state.sendSystemMessage(`Online: ${api.game?.onlineCount?.() ?? [...onlineMobiles(api)].length}`);
      return;
    }
    case 'find': {
      const q = (rest[0] ?? '').toLowerCase();
      for (const m of allMobiles(api)) {
        if (!m.name?.toLowerCase().includes(q)) continue;
        ctx.state.sendSystemMessage(`  ${m.name} #${m.serial.toString(16)} @ (${m.x},${m.y}) ${m.client ? '[ONLINE]' : ''}`);
      }
      return;
    }
    case 'teleto': {
      const q = (rest[0] ?? '').toLowerCase();
      for (const m of allMobiles(api)) {
        if (m.name?.toLowerCase() === q) {
          moveMobile(api, sender, { x: m.x, y: m.y, z: m.z, map: m.map });
          ctx.state.send?.(api.protocol.mobileUpdate({
            serial: sender.serial, body: sender.body,
            x: sender.x, y: sender.y, z: sender.z,
            direction: sender.direction ?? 0,
            hue: sender.hue ?? 0, flags: sender.flags ?? 0,
          }));
          ctx.state.sendSystemMessage(`Teleported to ${m.name}.`);
          return;
        }
      }
      ctx.state.sendSystemMessage(`No such mobile: ${rest[0]}`);
      return;
    }
    case 'kill': {
      const q = (rest[0] ?? '').toLowerCase();
      for (const m of allMobiles(api)) {
        if (m.name?.toLowerCase() === q) {
          m.hp = 0;
          if (api.corpse?.killMobile) api.corpse.killMobile(api.world, m, sender);
          ctx.state.sendSystemMessage(`Killed ${m.name}.`);
          return;
        }
      }
      ctx.state.sendSystemMessage(`No such mobile: ${rest[0]}`);
      return;
    }
    case 'res': {
      const q = (rest[0] ?? '').toLowerCase();
      for (const m of allMobiles(api)) {
        if (m.name?.toLowerCase() === q) {
          m.hp = m.hpMax;
          m.ghost = false;
          ctx.state.sendSystemMessage(`Resurrected ${m.name}.`);
          return;
        }
      }
      ctx.state.sendSystemMessage(`No such mobile: ${rest[0]}`);
      return;
    }
    default:
      ctx.state.sendSystemMessage('admin chars: list|find|teleto|kill|res');
  }
}

function runWorld(api, ctx, sender, sub, rest) {
  switch (sub) {
    case 'counts': {
      const online = api.game?.onlineCount?.() ?? [...onlineMobiles(api)].length;
      ctx.state.sendSystemMessage(`Mobiles: ${[...allMobiles(api)].length} (${online} online)`);
      ctx.state.sendSystemMessage(`Items:   ${[...allItems(api)].length}`);
      ctx.state.sendSystemMessage(`Uptime:  ${Math.round(process.uptime() / 60)} min`);
      return;
    }
    case 'save': {
      if (!api.persistence?.requestSave) { ctx.state.sendSystemMessage('No persistence.'); return; }
      api.persistence.requestSave(api.world, api.persistence.saveDir).then(({ bytes, ms }) => {
        ctx.state.sendSystemMessage(`Saved (${bytes}B, ${ms}ms).`);
      }).catch(e => ctx.state.sendSystemMessage(`Save failed: ${e.message}`));
      return;
    }
    case 'broadcast': {
      const msg = rest.join(' ');
      if (!msg) { ctx.state.sendSystemMessage('Usage: [admin world broadcast <msg>'); return; }
      sendSystemMessageToOnline(api, `[Server] ${msg}`);
      return;
    }
    default:
      ctx.state.sendSystemMessage('admin world: counts|save|broadcast');
  }
}

function runItems(api, ctx, sender, sub, rest) {
  switch (sub) {
    case 'counts': {
      const byKind = {};
      for (const it of allItems(api)) {
        const k = it.kind ?? 'other';
        byKind[k] = (byKind[k] | 0) + 1;
      }
      for (const [k, n] of Object.entries(byKind).sort(([, a], [, b]) => b - a)) {
        ctx.state.sendSystemMessage(`  ${k.padEnd(12)} ${n}`);
      }
      return;
    }
    case 'prune': {
      // Drop ground items older than 1h with decay enabled.
      let n = 0;
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const it of allItems(api)) {
        if (it.parent) continue;
        if (it.movable === false) continue;
        if (it._noDecay) continue;
        if ((it.decayAt ?? 0) > 0 && it.decayAt > cutoff) continue;
        try { destroyItemBySerial(api, it.serial); n++; }
        catch { /* ignore */ }
      }
      ctx.state.sendSystemMessage(`Pruned ${n} stale ground item(s).`);
      return;
    }
    case 'freeze': {
      const radius = parseInt(rest[0], 10) || 5;
      let n = 0;
      for (const it of allItems(api)) {
        if (it.parent) continue;
        if (it.map !== sender.map) continue;
        if (Math.abs(it.x - sender.x) > radius || Math.abs(it.y - sender.y) > radius) continue;
        it.movable = false; it._noDecay = true;
        n++;
      }
      ctx.state.sendSystemMessage(`Froze ${n} item(s) within ${radius} tiles.`);
      return;
    }
    default:
      ctx.state.sendSystemMessage('admin items: counts|prune|freeze');
  }
}
