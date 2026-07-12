// ServUO P2 admin/misc parity bridge.
//
// Many ServUO P2 gaps are helper classes behind admin commands, props gumps,
// account throttles, tiny timers, and comparer nodes. In Node we keep those as
// one module with data-driven commands and small runtime services.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

import { itemBySerial, mobileBySerial } from '../_entities.js';
import { allItems, allMobiles, onlineMobiles } from '../_spatial.js';
import { createItem } from '../_items.js';
import { moveMobile } from '../_movement.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const PARITY_PATH = path.resolve(HERE, '../data/config/servuo-p2-admin-parity.json');

function loadRows() {
  try {
    const rows = JSON.parse(fs.readFileSync(PARITY_PATH, 'utf8'));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export const SERVUO_P2_ADMIN_PARITY = Object.freeze(loadRows());
export const SERVUO_P2_ADMIN_CLASSES = Object.freeze(
  SERVUO_P2_ADMIN_PARITY.map((row) => row.servuoClass).filter(Boolean),
);

function parseSerial(value) {
  const text = String(value ?? '').trim();
  if (!text) return 0;
  return Number.parseInt(text.startsWith('0x') ? text.slice(2) : text, text.startsWith('0x') ? 16 : 10) >>> 0;
}

function entityBySerial(api, serial) {
  const s = parseSerial(serial);
  return mobileBySerial(api, s) ?? itemBySerial(api, s) ?? null;
}

function getPath(obj, propPath) {
  const parts = String(propPath ?? '').split('.').filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setPath(obj, propPath, value) {
  const parts = String(propPath ?? '').split('.').filter(Boolean);
  if (!obj || parts.length === 0) return false;
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    if (cur[part] == null || typeof cur[part] !== 'object') cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
  return true;
}

function coerceValue(raw) {
  const text = String(raw ?? '');
  if (/^(true|false)$/i.test(text)) return /^true$/i.test(text);
  if (/^null$/i.test(text)) return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  try {
    if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
      return JSON.parse(text);
    }
  } catch {}
  return text;
}

function compare(a, op, b) {
  switch (op) {
    case '=':
    case '==': return String(a) === String(b);
    case '!=': return String(a) !== String(b);
    case '>': return Number(a) > Number(b);
    case '>=': return Number(a) >= Number(b);
    case '<': return Number(a) < Number(b);
    case '<=': return Number(a) <= Number(b);
    case '~': return String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase());
    default: return false;
  }
}

function selectEntities(api, selector) {
  const token = String(selector ?? 'online').toLowerCase();
  if (token === 'online') return [...onlineMobiles(api)];
  if (token === 'mobiles') return [...allMobiles(api)];
  if (token === 'items') return [...allItems(api)];
  if (token === 'nearby') {
    return [...allMobiles(api)].filter((m) => m.client);
  }
  const one = entityBySerial(api, token);
  return one ? [one] : [];
}

function makeStatusPage(api) {
  const mem = process.memoryUsage?.() ?? {};
  return {
    uptimeSec: Math.floor(process.uptime?.() ?? 0),
    rssMb: Math.round((mem.rss ?? 0) / 1024 / 1024),
    heapMb: Math.round((mem.heapUsed ?? 0) / 1024 / 1024),
    mobiles: [...allMobiles(api)].length,
    items: [...allItems(api)].length,
    online: [...onlineMobiles(api)].length,
    platform: `${os.platform()} ${os.release()}`,
  };
}

function applyTimedResistanceMod(mob, deltas, durationMs = 10_000) {
  if (!mob || !deltas || typeof deltas !== 'object') return false;
  mob._resistOverlay ??= { physical: 0, fire: 0, cold: 0, poison: 0, energy: 0 };
  for (const [key, value] of Object.entries(deltas)) {
    mob._resistOverlay[key] = (mob._resistOverlay[key] | 0) + (value | 0);
  }
  mob._resBagDirty = true;
  const entry = { deltas: { ...deltas }, expiresAt: Date.now() + durationMs };
  mob._timedResistanceMods ??= [];
  mob._timedResistanceMods.push(entry);
  return true;
}

function applyEnhancement(mob, key, value, durationMs = 10_000) {
  if (!mob || !key) return false;
  mob._enhancements ??= {};
  const old = mob[key];
  mob[key] = value;
  mob._enhancements[key] = { old, expiresAt: Date.now() + durationMs };
  return true;
}

function spark(api, source, target, damage = 8) {
  if (!target || target === source) return false;
  if (api.combat?.damage) api.combat.damage(api.world, target, damage, source, { energy: 100 });
  else target.hp = Math.max(0, (target.hp ?? 0) - damage);
  target._sparksContext = { sourceSerial: source?.serial ?? 0, damage, at: Date.now() };
  return true;
}

function sweepTimedState(api) {
  const now = Date.now();
  for (const mob of allMobiles(api)) {
    if (Array.isArray(mob._timedResistanceMods) && mob._timedResistanceMods.length > 0) {
      const keep = [];
      for (const mod of mob._timedResistanceMods) {
        if ((mod.expiresAt ?? 0) > now) { keep.push(mod); continue; }
        if (mob._resistOverlay) {
          for (const [key, value] of Object.entries(mod.deltas ?? {})) {
            mob._resistOverlay[key] = (mob._resistOverlay[key] | 0) - (value | 0);
          }
          mob._resBagDirty = true;
        }
      }
      mob._timedResistanceMods = keep;
    }
    if (mob._enhancements && typeof mob._enhancements === 'object') {
      for (const [key, rec] of Object.entries(mob._enhancements)) {
        if ((rec.expiresAt ?? 0) > now) continue;
        mob[key] = rec.old;
        delete mob._enhancements[key];
      }
    }
  }
}

function registerCommand(api, disposers, spec) {
  if (!api.commands?.register || !spec?.name) return;
  const name = spec.name.toLowerCase();
  const exists = api.commands.commands?.has?.(name);
  if (exists && !spec.override) return;
  const compatibilityOnly = new Set([
    'servuoprops', 'batch', 'servuoquery', 'exportwsc', 'profiling', 'statuspage',
    'visibilitylist', 'openbrowser', 'servuotoggle', 'servuotele', 'servuoadd',
  ]);
  api.commands.register({ ...spec, hidden: spec.hidden ?? compatibilityOnly.has(name) });
  disposers.push(() => api.commands.unregister?.(spec.name));
}

function registerCommands(api, disposers) {
  registerCommand(api, disposers, {
    name: 'servuoprops',
    access: 'GameMaster',
    help: '[servuoprops get|set|inc|toggle|delete|list <serial> <prop> [value]',
    run(ctx, args = []) {
      const action = String(args[0] ?? 'get').toLowerCase();
      const ent = entityBySerial(api, args[1]);
      if (!ent) return ctx.state?.sendSystemMessage?.('Entity not found.');
      const prop = args[2];
      if (action === 'list') {
        ctx.state?.sendSystemMessage?.(Object.keys(ent).sort().join(', '));
        return;
      }
      if (!prop) return ctx.state?.sendSystemMessage?.('Property required.');
      if (action === 'get') {
        ctx.state?.sendSystemMessage?.(`${prop} = ${JSON.stringify(getPath(ent, prop))}`);
        return;
      }
      if (action === 'set') {
        setPath(ent, prop, coerceValue(args.slice(3).join(' ')));
      } else if (action === 'inc') {
        setPath(ent, prop, Number(getPath(ent, prop) ?? 0) + Number(args[3] ?? 1));
      } else if (action === 'toggle') {
        setPath(ent, prop, !getPath(ent, prop));
      } else if (action === 'delete') {
        setPath(ent, prop, undefined);
      }
      ctx.state?.sendSystemMessage?.(`${prop} = ${JSON.stringify(getPath(ent, prop))}`);
    },
  });

  registerCommand(api, disposers, {
    name: 'batch',
    access: 'Administrator',
    help: '[batch online|mobiles|items|<serial> <command...>',
    run(ctx, args = []) {
      const selector = args[0];
      const line = args.slice(1).join(' ');
      if (!selector || !line) return ctx.state?.sendSystemMessage?.('Usage: [batch online|mobiles|items|<serial> <command...>');
      const targets = selectEntities(api, selector);
      let count = 0;
      for (const target of targets) {
        const childCtx = { ...ctx, sender: target, target };
        if (api.commands.dispatch(line, childCtx)) count++;
      }
      ctx.state?.sendSystemMessage?.(`BatchCommand ran ${count} command(s).`);
    },
  });

  registerCommand(api, disposers, {
    name: 'servuoquery',
    access: 'GameMaster',
    help: '[servuoquery mobiles|items where <prop> <op> <value> [sort <prop>] [limit n]',
    run(ctx, args = []) {
      const source = String(args[0] ?? 'mobiles').toLowerCase();
      let list = source === 'items' ? [...allItems(api)] : [...allMobiles(api)];
      const whereIdx = args.findIndex((a) => String(a).toLowerCase() === 'where');
      if (whereIdx >= 0) {
        const [prop, op, ...rest] = args.slice(whereIdx + 1);
        const stop = rest.findIndex((a) => ['sort', 'limit'].includes(String(a).toLowerCase()));
        const rawValue = (stop >= 0 ? rest.slice(0, stop) : rest).join(' ');
        list = list.filter((ent) => compare(getPath(ent, prop), op, coerceValue(rawValue)));
      }
      const sortIdx = args.findIndex((a) => String(a).toLowerCase() === 'sort');
      if (sortIdx >= 0 && args[sortIdx + 1]) {
        const prop = args[sortIdx + 1];
        list.sort((a, b) => String(getPath(a, prop)).localeCompare(String(getPath(b, prop))));
      }
      const limitIdx = args.findIndex((a) => String(a).toLowerCase() === 'limit');
      const limit = limitIdx >= 0 ? Math.max(1, Number(args[limitIdx + 1] ?? 25) | 0) : 25;
      const out = list.slice(0, limit).map((ent) => `${ent.serial}: ${ent.name ?? ent.kind ?? ent.itemId ?? ent.body}`).join('; ');
      ctx.state?.sendSystemMessage?.(out || 'No matches.');
    },
  });

  registerCommand(api, disposers, {
    name: 'exportwsc',
    access: 'Administrator',
    help: '[exportwsc <items|mobiles|all> [file]',
    run(ctx, args = []) {
      const mode = String(args[0] ?? 'all').toLowerCase();
      const file = path.resolve(process.cwd(), args[1] ?? `artifacts/export-${Date.now()}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const payload = {};
      if (mode === 'all' || mode === 'items') payload.items = [...allItems(api)];
      if (mode === 'all' || mode === 'mobiles') payload.mobiles = [...allMobiles(api)];
      fs.writeFileSync(file, JSON.stringify(payload, null, 2));
      ctx.state?.sendSystemMessage?.(`ExportCommand wrote ${path.relative(process.cwd(), file)}.`);
    },
  });

  registerCommand(api, disposers, {
    name: 'tell',
    access: 'Counselor',
    help: '[tell <serial> <message>',
    run(ctx, args = []) {
      const mob = mobileBySerial(api, parseSerial(args[0]));
      if (!mob) return ctx.state?.sendSystemMessage?.('Mobile not found.');
      const msg = args.slice(1).join(' ');
      mob.client?.sendSystemMessage?.(msg);
      ctx.state?.sendSystemMessage?.('Message sent.');
    },
  });

  registerCommand(api, disposers, {
    name: 'shardtime',
    access: 'Player',
    help: '[shardtime',
    run(ctx) {
      ctx.state?.sendSystemMessage?.(`ShardTime: ${new Date().toISOString()} uptime=${Math.floor(process.uptime())}s`);
    },
  });

  registerCommand(api, disposers, {
    name: 'profiling',
    access: 'GameMaster',
    help: '[profiling',
    run(ctx) {
      ctx.state?.sendSystemMessage?.(JSON.stringify(makeStatusPage(api)));
    },
  });

  registerCommand(api, disposers, {
    name: 'statuspage',
    access: 'Counselor',
    help: '[statuspage',
    run(ctx) {
      const s = makeStatusPage(api);
      ctx.state?.sendSystemMessage?.(`StatusPage: online=${s.online} mobiles=${s.mobiles} items=${s.items} heap=${s.heapMb}MB rss=${s.rssMb}MB`);
    },
  });

  registerCommand(api, disposers, {
    name: 'visibilitylist',
    access: 'GameMaster',
    help: '[visibilitylist',
    run(ctx) {
      const hidden = [...allMobiles(api)].filter((m) => m.hidden || ((m.flags | 0) & 0x80));
      ctx.state?.sendSystemMessage?.(hidden.map((m) => `${m.serial}:${m.name ?? m.kind}`).join(', ') || 'No hidden mobiles.');
    },
  });

  registerCommand(api, disposers, {
    name: 'openbrowser',
    access: 'Player',
    help: '[openbrowser <url>',
    run(ctx, args = []) {
      const target = args.join(' ');
      ctx.state?.sendSystemMessage?.(target ? `OpenBrowserCommand: ${target}` : 'No URL.');
    },
  });

  registerCommand(api, disposers, {
    name: 'servuotoggle',
    access: 'GameMaster',
    help: '[servuotoggle <serial> <prop>',
    run(ctx, args = []) {
      const ent = entityBySerial(api, args[0]);
      if (!ent) return ctx.state?.sendSystemMessage?.('Entity not found.');
      const prop = args[1];
      setPath(ent, prop, !getPath(ent, prop));
      ctx.state?.sendSystemMessage?.(`${prop} = ${JSON.stringify(getPath(ent, prop))}`);
    },
  });

  registerCommand(api, disposers, {
    name: 'servuotele',
    access: 'GameMaster',
    help: '[servuotele <serial> <x> <y> [z] [map]',
    run(ctx, args = []) {
      const mob = mobileBySerial(api, parseSerial(args[0]));
      if (!mob) return ctx.state?.sendSystemMessage?.('Mobile not found.');
      const dest = {
        x: Number(args[1] ?? mob.x) | 0,
        y: Number(args[2] ?? mob.y) | 0,
        z: Number(args[3] ?? mob.z) | 0,
        map: Number(args[4] ?? mob.map ?? 1) | 0,
      };
      moveMobile(api, mob, dest);
      ctx.state?.sendSystemMessage?.(`TeleCommand moved ${mob.serial} to ${dest.x},${dest.y},${dest.z}.`);
    },
  });

  registerCommand(api, disposers, {
    name: 'servuoadd',
    access: 'GameMaster',
    help: '[servuoadd <itemId|template> [amount]',
    run(ctx, args = []) {
      const sender = ctx.sender;
      const key = args[0];
      if (!sender || !key) return ctx.state?.sendSystemMessage?.('Usage: [servuoadd <itemId|template> [amount]');
      const tpl = api.templates?.get?.(key);
      const item = tpl
        ? api.templates.spawn?.(api.world, key, { x: sender.x, y: sender.y, z: sender.z, map: sender.map ?? 1 })
        : createItem(api, {
            itemId: Number.parseInt(String(key).replace(/^0x/i, ''), String(key).startsWith('0x') ? 16 : 10) || 0x1,
            amount: Math.max(1, Number(args[1] ?? 1) | 0),
            x: sender.x,
            y: sender.y,
            z: sender.z,
            map: sender.map ?? 1,
          });
      ctx.state?.sendSystemMessage?.(item ? `AddCommand created ${item.serial}.` : 'Add failed.');
    },
  });
}

function registerContextMenuApi(api) {
  api.systems ??= {};
  api.systems.servuoContextMenus ??= {};
  api.systems.servuoContextMenus.addToParty = (leader, target) => {
    if (!leader || !target) return false;
    target.partyId = leader.partyId ?? leader.serial;
    leader.partyId = target.partyId;
    return true;
  };
  api.systems.servuoContextMenus.ejectPlayer = (house, target) => {
    if (!target) return false;
    target._ejectedFromHouse = house?.serial ?? house?.id ?? 0;
    return true;
  };
}

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  const disposers = [];
  registerCommands(api, disposers);
  registerContextMenuApi(api);

  const ipHits = new Map();
  const fastwalk = new Map();
  const validationQueue = [];

  api.systems ??= {};
  const previous = api.systems.servuoP2Admin;
  api.systems.servuoP2Admin = {
    classes: SERVUO_P2_ADMIN_CLASSES,
    rows: SERVUO_P2_ADMIN_PARITY,
    statusPage: () => makeStatusPage(api),
    ipLimiter: {
      check(ip, limit = 8, windowMs = 60_000) {
        const now = Date.now();
        const key = String(ip ?? 'unknown');
        const arr = (ipHits.get(key) ?? []).filter((at) => now - at < windowMs);
        arr.push(now);
        ipHits.set(key, arr);
        return arr.length <= limit;
      },
      snapshot: () => Object.fromEntries([...ipHits].map(([k, v]) => [k, v.length])),
    },
    fastwalk: {
      check(serial, minMs = 80) {
        const now = Date.now();
        const prev = fastwalk.get(serial) ?? 0;
        fastwalk.set(serial, now);
        return now - prev >= minMs;
      },
    },
    validationQueue: {
      push(task) { validationQueue.push({ task, at: Date.now() }); return validationQueue.length; },
      drain(limit = 100) { return validationQueue.splice(0, limit); },
      size: () => validationQueue.length,
    },
    applyTimedResistanceMod,
    applyEnhancement,
    spark: (source, target, damage) => spark(api, source, target, damage),
  };
  disposers.push(() => { api.systems.servuoP2Admin = previous; });

  const interval = setInterval(() => sweepTimedState(api), 1000);
  interval.unref?.();
  disposers.push(() => clearInterval(interval));

  api.log?.(`servuo-p2-admin-parity: loaded ${SERVUO_P2_ADMIN_CLASSES.length} class mappings`);
  return () => {
    for (let i = disposers.length - 1; i >= 0; i--) {
      try { disposers[i]?.(); } catch {}
    }
  };
}
