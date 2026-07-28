// Account, mobile, item, inspection, and administrator teleport routes.

import { scheduleRefreshSurroundings } from '../net/handlers.js';
import { resolveStandingZ } from '../world/movement.js';
import { destroyItem } from '../world/items.js';
import { AI_GRAPH_NODE_TYPES } from '../world/ai-graphs.js';
import * as operational from '../systems/operational-diagnostics.js';
import { parseSerial, snapshotItem, snapshotMobile } from './route-helpers.js';

export function registerEntityRoutes(routes, {
  accounts, world, sharedCtx, adminCharacters, queryInt,
}) {
  // ---- Accounts ---------------------------------------------------------
  routes.push({
    method: 'GET', path: '/api/accounts',
    run: () => {
      const list = [...(accounts?.accounts?.values?.() ?? [])].map((a) => ({
        username: a.username,
        accessLevel: a.accessLevel,
        banned: !!a.banned,
        created: a.created,
        lastLogin: a.lastLogin,
        characters: (a.characters ?? []).filter(Boolean).length,
      }));
      return { count: list.length, accounts: list };
    },
  });

  routes.push({
    method: 'GET', path: '/api/accounts/:name',
    run: ({ params }) => {
      const acc = accounts?.accounts?.get(params.name.toLowerCase());
      if (!acc) return { error: 'not found' };
      const safe = { ...acc };
      delete safe.hash;
      // Resolve character serials → mob snapshots so the UI shows live state.
      const chars = (acc.characters ?? []).map((c) => {
        if (!c) return null;
        const mob = world?.mobiles?.get?.(c.mobileSerial >>> 0);
        return {
          ...c,
          live: mob ? snapshotMobile(mob) : null,
        };
      });
      return { ...safe, characters: chars };
    },
  });

  routes.push({
    method: 'PATCH', path: '/api/accounts/:name',
    run: ({ params, body, session }) => {
      const acc = accounts?.accounts?.get(params.name.toLowerCase());
      if (!acc) return { error: 'not found' };
      // Admin audit #1/#2/#5 — stored XSS via accessLevel class +
      // privilege escalation. Whitelist the values + refuse self-edit
      // on accessLevel/banned (no admin can de-Admin themselves or
      // re-Admin themselves silently).
      const ALLOWED_LEVELS = new Set(['Player', 'Counselor', 'Seer', 'GameMaster', 'GM', 'Admin']);
      const isSelf = String(session?.account ?? '').toLowerCase() === params.name.toLowerCase();
      if (body && 'accessLevel' in body) {
        if (!ALLOWED_LEVELS.has(body.accessLevel)) {
          return { error: 'invalid accessLevel' };
        }
        if (isSelf) return { error: 'cannot change your own accessLevel' };
        acc.accessLevel = body.accessLevel;
      }
      if (body && 'banned' in body) {
        if (isSelf && body.banned) return { error: 'cannot ban self' };
        acc.banned = !!body.banned;
      }
      accounts.saveSync();
      return { ok: true, account: { username: acc.username, accessLevel: acc.accessLevel, banned: !!acc.banned } };
    },
  });

  routes.push({
    method: 'DELETE', path: '/api/accounts/:name',
    run: ({ params, session }) => {
      const key = params.name.toLowerCase();
      if (String(session?.account ?? '').toLowerCase() === key) {
        return { error: 'cannot delete your own account' };
      }
      const ok = accounts?.accounts?.delete(key);
      if (ok) accounts.saveSync();
      return { ok: !!ok };
    },
  });

  // ---- Mobiles (characters + NPCs) -------------------------------------
  routes.push({
    method: 'GET', path: '/api/mobiles',
    run: ({ query }) => {
      const filter = (query.get('filter') ?? '').toLowerCase();
      const onlyPlayers = query.get('players') === '1';
      const kind = query.get('kind') ?? (onlyPlayers ? 'players' : 'all');
      const limit = Math.trunc(Math.max(1, Math.min(500, Number(query.get('limit') ?? 200) || 200)));
      const offset = Math.trunc(Math.max(0, Number(query.get('offset') ?? 0) || 0));
      let count = 0;
      const page = [];
      for (const m of (world?.mobiles?.values?.() ?? [])) {
        const isPlayer = !!m.client || !!m.isPlayer;
        const isVendor = !isPlayer && !!m.vendorKind;
        if (kind === 'players' && !isPlayer) continue;
        if (kind === 'vendors' && !isVendor) continue;
        if (kind === 'npcs' && (isPlayer || isVendor)) continue;
        if (filter && !(m.name ?? '').toLowerCase().includes(filter)
            && !`0x${(m.serial >>> 0).toString(16)}`.includes(filter)) continue;
        if (count >= offset && page.length < limit) page.push(snapshotMobile(m));
        count++;
      }
      return {
        count,
        offset,
        limit,
        mobiles: page,
      };
    },
  });

  routes.push({
    method: 'GET', path: '/api/mobiles/:serial',
    run: ({ params }) => {
      const serial = parseSerial(params.serial);
      const mob = world?.mobiles?.get?.(serial);
      if (!mob) return { error: 'not found' };
      // Pull worn items + backpack contents for the preview pane.
      // Reverse parent index: ≤10 worn slots + ≤30 pack contents
      // instead of two full 110k walks per request. Bug-hunt #4 A5.
      const equipped = [];
      let backpack = null;
      const idx = world?._childrenByParent;
      const wornIter = idx?.get?.(mob.serial)
        ? Array.from(idx.get(mob.serial), (s) => world.items.get(s)).filter(Boolean)
        : [...(world?.items?.values?.() ?? [])].filter((it) => it.parent === mob.serial);
      for (const it of wornIter) {
        if (it.layer === 21) backpack = it;
        if ((it.layer ?? 0) > 0) equipped.push({
          serial: '0x' + (it.serial >>> 0).toString(16),
          definitionId: it.definitionId ?? null,
          artId: it.artId ?? it.itemId,
          itemId: it.itemId, hue: it.hue, layer: it.layer, name: it.name,
        });
      }
      const packIter = backpack
        ? (idx?.get?.(backpack.serial)
            ? Array.from(idx.get(backpack.serial), (s) => world.items.get(s)).filter(Boolean)
            : [...world.items.values()].filter((it) => it.parent === backpack.serial))
        : [];
      const packContents = packIter.map((it) => ({
        serial: '0x' + (it.serial >>> 0).toString(16),
        definitionId: it.definitionId ?? null,
        artId: it.artId ?? it.itemId,
        itemId: it.itemId, hue: it.hue, amount: it.amount, name: it.name,
      }));
      return {
        ...snapshotMobile(mob),
        equipped,
        backpackContents: packContents,
      };
    },
  });

  routes.push({
    method: 'POST', path: '/api/mobiles/:serial/teleport',
    run: ({ params, body }) => {
      const serial = parseSerial(params.serial);
      const mob = world?.mobiles?.get?.(serial);
      if (!mob) return { error: 'not found' };
      const x = Number(body?.x), y = Number(body?.y), z = Number(body?.z ?? mob.z);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: 'x,y required' };
      mob.x = x; mob.y = y; mob.z = z;
      if (Number.isFinite(body?.map)) mob.map = body.map | 0;
      world?.sectors?.moveMobile?.(mob);
      return { ok: true, x: mob.x, y: mob.y, z: mob.z, map: mob.map };
    },
  });

  routes.push({
    method: 'POST', path: '/api/mobiles/:serial/kill',
    run: ({ params }) => {
      const serial = parseSerial(params.serial);
      const mob = world?.mobiles?.get?.(serial);
      if (!mob) return { error: 'not found' };
      mob.hp = 0;
      // Bug-hunt #10 #3 — `combat.damage` only adjusts HP; the death
      // path (corpse spawn, notoriety, mob.delete) lives in
      // `corpse.killMobile`. Without this admin "kill" left passive
      // NPCs frozen at HP=0 forever. Try direct call first; fall back
      // to the combat path so any in-flight combat tick still wraps
      // the death via its own damage closure.
      const killMobile = sharedCtx?.corpse?.killMobile
                      ?? sharedCtx?.systems?.corpse?.killMobile;
      if (typeof killMobile === 'function') {
        try { killMobile(world, mob, null); }
        catch (e) { console.error('[admin] kill threw:', e); }
      } else {
        sharedCtx?.handlers?.combat?.damage?.(world, mob, 9999, null);
      }
      return { ok: true };
    },
  });

  routes.push({
    method: 'POST', path: '/api/mobiles/:serial/kick',
    run: ({ params }) => {
      const serial = parseSerial(params.serial);
      const mob = world?.mobiles?.get?.(serial);
      if (!mob?.client) return { error: 'not online' };
      try { mob.client.close?.(); } catch { /* ignore */ }
      return { ok: true };
    },
  });

  // ---- Items ------------------------------------------------------------
  routes.push({
    method: 'GET', path: '/api/items',
    run: ({ query }) => {
      const filter = (query.get('filter') ?? '').toLowerCase();
      const onGround = query.get('ground') === '1';
      const limit = Math.trunc(Math.max(1, Math.min(500, Number(query.get('limit') ?? 200) || 200)));
      const offset = Math.trunc(Math.max(0, Number(query.get('offset') ?? 0) || 0));
      let count = 0;
      const page = [];
      for (const it of (world?.items?.values?.() ?? [])) {
        if (onGround && it.parent != null) continue;
        if (filter && !(it.name ?? '').toLowerCase().includes(filter)
            && !`0x${(it.itemId | 0).toString(16)}`.includes(filter)
            && !`0x${(it.serial >>> 0).toString(16)}`.includes(filter)) continue;
        if (count >= offset && page.length < limit) page.push(snapshotItem(it));
        count++;
      }
      return {
        count,
        offset,
        limit,
        items: page,
      };
    },
  });

  routes.push({
    method: 'GET', path: '/api/items/:serial',
    run: ({ params }) => {
      const serial = parseSerial(params.serial);
      const it = world?.items?.get?.(serial);
      if (!it) return { error: 'not found' };
      return snapshotItem(it);
    },
  });

  routes.push({
    method: 'DELETE', path: '/api/items/:serial',
    run: ({ params }) => {
      const serial = parseSerial(params.serial);
      const it = world?.items?.get?.(serial);
      if (!it) return { error: 'not found' };
      // Bug-hunt #10 #2: was a raw `world.items.delete(serial)` which
      // bypassed reverse-index unlink + sector removal + child orphan
      // sweep + removeEntity broadcast. Use `destroyItem` so observers
      // immediately stop seeing the item and persistence stays clean.
      destroyItem(world, serial);
      const packet = sharedCtx?.protocol?.removeEntity?.(serial);
      let broadcast = 0;
      if (packet) {
        for (const mob of (world?.mobiles?.values?.() ?? [])) {
          if (!mob.client) continue;
          try { mob.client.send(packet); broadcast++; } catch { /* socket race */ }
        }
      }
      return { ok: true, broadcast };
    },
  });

  const entityContext = (serial) => {
    const id = parseSerial(serial), mobile = world?.mobiles?.get?.(id), item = world?.items?.get?.(id);
    const entity = mobile ?? item;
    if (!entity) return null;
    const regions = (sharedCtx?.regions?.all?.() ?? sharedCtx?.regions?.regions ?? []).filter((region) => (region.map | 0) === (entity.map | 0)
      && (region.rects ?? []).some((rect) => entity.x >= rect.x1 && entity.x <= rect.x2 && entity.y >= rect.y1 && entity.y <= rect.y2))
      .map((region) => ({ name: region.name, type: region.type, priority: region.priority }));
    const spawners = [...(sharedCtx?.spawner?.groups?.values?.() ?? [])].filter((group) => (group.map | 0) === (entity.map | 0) && group.rect
      && entity.x >= group.rect.x1 && entity.x <= group.rect.x2 && entity.y >= group.rect.y1 && entity.y <= group.rect.y2).map((group) => group.id);
    const ownerSerial = item?.parent ?? mobile?.controlMaster ?? null;
    const template = entity.template ?? entity.kind ?? entity.servuoClass ?? null;
    const quickLinks = {
      owner: ownerSerial ? { type: 'entity', serial: ownerSerial >>> 0 } : null,
      regions: regions.map((region) => ({ type: 'region', name: region.name })),
      template: template ? { type: 'template', name: String(template) } : null,
      spawners: spawners.map((id) => ({ type: 'spawner', id })),
    };
    return { type: mobile ? 'mobile' : 'item', entity: mobile ? snapshotMobile(mobile) : snapshotItem(item),
      regions, spawners, quickLinks };
  };
  routes.push({ method: 'GET', path: '/api/live/entity/:serial', run: ({ params }) => entityContext(params.serial) ?? { error: 'entity not found' } });
  routes.push({
    method: 'GET', path: '/api/live/entity/:serial/events',
    run: ({ params, query }) => {
      const id = parseSerial(params.serial), hex = `0x${id.toString(16)}`.toLowerCase(), decimal = String(id), limit = queryInt(query, 'limit', 200, 1, 2000);
      const matches = (entry) => { const text = JSON.stringify(entry).toLowerCase(); return text.includes(hex) || text.includes(decimal); };
      const session = operational.compatibilitySnapshot().sessions.find((entry) => (entry.mobileSerial >>> 0) === id);
      return { serial: hex, packets: session?.packets?.slice(-limit).reverse() ?? [],
        structured: operational.structuredSnapshot(2000).filter(matches).slice(0, limit), audit: operational.auditSnapshot(2000).filter(matches).slice(0, limit) };
    },
  });
  routes.push({
    method: 'GET', path: '/api/live/follow/:serial',
    run: ({ params }) => {
      const context = entityContext(params.serial); if (!context) return { error: 'entity not found' };
      const id = parseSerial(params.serial), session = operational.compatibilitySnapshot().sessions.find((entry) => (entry.mobileSerial >>> 0) === id);
      return { ...context, observedAt: Date.now(), client: session ?? null };
    },
  });
  routes.push({
    method: 'POST', path: '/api/live/mutate',
    run: ({ body }) => {
      const serial = parseSerial(body?.serial), mobile = world?.mobiles?.get?.(serial), item = world?.items?.get?.(serial), action = String(body?.action ?? '');
      if (!mobile && !item) return { error: 'entity not found' };
      if (!['kill', 'delete', 'move', 'hue'].includes(action)) return { error: 'action must be kill, delete, move or hue' };
      const before = mobile ? snapshotMobile(mobile) : snapshotItem(item);
      if (action === 'kill') {
        if (!mobile) return { error: 'kill requires a mobile' };
        mobile.hp = 0;
        const killMobile = sharedCtx?.corpse?.killMobile ?? sharedCtx?.systems?.corpse?.killMobile;
        if (typeof killMobile === 'function') killMobile(world, mobile, null); else world.destroyMobile?.(serial);
      } else if (action === 'delete') {
        if (mobile) world.destroyMobile?.(serial); else destroyItem(world, serial);
      } else if (action === 'move') {
        const entity = mobile ?? item, x = Number(body?.x), y = Number(body?.y), z = Number(body?.z ?? entity.z), map = Number(body?.map ?? entity.map);
        if (![x, y, z, map].every(Number.isFinite)) return { error: 'move requires finite x,y,z,map' };
        entity.x = x | 0; entity.y = y | 0; entity.z = z | 0; entity.map = Math.max(0, Math.min(5, map | 0));
        if (mobile) world?.sectors?.moveMobile?.(mobile); else world?.sectors?.moveItem?.(item);
      } else {
        const hue = Number(body?.hue); if (!Number.isFinite(hue)) return { error: 'hue requires a number' };
        (mobile ?? item).hue = Math.max(0, Math.min(0xffff, hue | 0));
      }
      const afterContext = entityContext(serial);
      return { ok: true, action, serial: `0x${serial.toString(16)}`, before, after: afterContext?.entity ?? null };
    },
  });

  routes.push({
    method: 'GET', path: '/api/ai/:serial',
    run: ({ params }) => {
      const serial = parseSerial(params.serial);
      const result = sharedCtx?.ai?.inspect?.(serial);
      return result ?? { error: 'mobile has no attached AI behavior' };
    },
  });

  routes.push({
    method: 'GET', path: '/api/ai/:serial/path',
    run: ({ params, query }) => {
      const serial = parseSerial(params.serial);
      const target = parseSerial(query.get('target') ?? '0');
      const result = sharedCtx?.ai?.previewPath?.(serial, target);
      return result ?? { error: 'mobile has no attached AI behavior' };
    },
  });

  routes.push({
    method: 'GET', path: '/api/ai-graphs',
    run: () => ({ nodeTypes: [...AI_GRAPH_NODE_TYPES], graphs: sharedCtx?.aiGraphs?.list?.() ?? [] }),
  });

  routes.push({
    method: 'PUT', path: '/api/ai-graphs/:id',
    run: ({ params, body }) => sharedCtx?.aiGraphs?.save?.({ ...(body ?? {}), id: params.id })
      ?? { error: 'AI graph registry unavailable' },
  });

  routes.push({
    method: 'DELETE', path: '/api/ai-graphs/:id',
    run: ({ params }) => ({ ok: !!sharedCtx?.aiGraphs?.delete?.(params.id) }),
  });

  routes.push({
    method: 'POST', path: '/api/ai-graphs/:id/attach',
    run: ({ params, body }) => {
      const mob = world?.mobiles?.get?.(parseSerial(body?.serial));
      if (!mob) return { error: 'mobile not found' };
      return sharedCtx?.aiGraphs?.attach?.(mob, params.id)
        ? { ok: true, behavior: mob.aiBehavior } : { error: 'graph not found' };
    },
  });

  // ---- "Teleport ME" — server picks the admin's character ---------------
  //
  // Marcin's request: stop asking the UI for a mobile serial. The admin
  // is logged in, the server knows their account, look up the
  // characters there. If exactly one → teleport it. If more → return
  // 409 + the list so the UI shows a tiny picker modal.
  routes.push({
    method: 'POST', path: '/api/me/teleport',
    run: ({ session, body }) => {
      const chars = adminCharacters(session?.account, Number(body?.slot));
      if (!chars.length) return { error: 'no characters on this admin account' };
      if (chars.length > 1 && body?.slot == null) {
        return { needsPick: true, characters: chars.map((c) => ({
          slot: c.slot, name: c.name, mobileSerial: '0x' + (c.mobileSerial >>> 0).toString(16),
          online: c.online,
        })) };
      }
      const target = chars[0];
      if (!target.mob) return { error: `character "${target.name}" has no live mobile (offline?)` };
      // Resolve destination — three modes: explicit (x,y,z,map),
      // anchor item, anchor spawner. Picked by which body field is set.
      const mob = target.mob;
      let dest = null;
      if (body?.itemSerial) {
        const it = world?.items?.get?.(parseSerial(body.itemSerial));
        if (!it) return { error: 'item not found' };
        let anchor = it; let hops = 0;
        while (anchor.parent && hops++ < 8) {
          const p = world?.items?.get?.(anchor.parent)
                 ?? world?.mobiles?.get?.(anchor.parent);
          if (!p) break; anchor = p;
        }
        dest = { x: anchor.x | 0, y: anchor.y | 0, z: anchor.z | 0, map: anchor.map };
      } else if (body?.spawnerId) {
        const g = sharedCtx?.spawner?.groups?.get?.(body.spawnerId);
        if (!g?.rect) return { error: 'spawner not found' };
        dest = {
          x: ((g.rect.x1 + g.rect.x2) / 2) | 0,
          y: ((g.rect.y1 + g.rect.y2) / 2) | 0,
          z: 0, map: g.map,
        };
      } else if (Number.isFinite(body?.x) && Number.isFinite(body?.y)) {
        dest = { x: body.x | 0, y: body.y | 0, z: (body.z | 0) || mob.z, map: body.map };
      } else {
        return { error: 'pass itemSerial OR spawnerId OR (x,y[,z,map])' };
      }
      // Resolve standing Z so the admin doesn't end up at z=0 inside
      // the foundation of a multi-story building (Britain Bank floor
      // sits at z=20, etc.). Map editor / Static editor send z:0 by
      // convention — we substitute the proper standing z here so the
      // avatar lands ON the visible floor instead of underneath the
      // map. Skip the substitution when caller passed an explicit
      // non-zero z (item / spawner anchors carry meaningful z).
      if ((body?.z | 0) === 0 && (body?.x != null || body?.spawnerId)) {
        try {
          const standZ = resolveStandingZ(dest.map ?? mob.map ?? 1, dest.x, dest.y, dest.z);
          if (Number.isFinite(standZ)) dest.z = standZ;
        } catch { /* fall back to z=0 */ }
      }
      // CRITICAL: just mutating mob.x/y/z server-side leaves the
      // player's client + every nearby observer staring at the OLD
      // tile until the next 0x77 broadcast. Mirror what `[go` (the
      // canonical teleport command) does — remove from pre-observers,
      // update self, broadcast moving to post-observers.
      const protocol = sharedCtx?.protocol;
      const removeEntity = protocol?.removeEntity;
      const mobileUpdate = protocol?.mobileUpdate;
      const mobileMoving = protocol?.mobileMoving;
      const oldMap = mob.map;
      // Pre-observers: anyone within 18 tiles on the SAME map before
      // the move. They get a removeEntity packet.
      const preObservers = [];
      for (const m of world.mobiles.values()) {
        if (!m.client || m === mob) continue;
        if (m.map !== oldMap) continue;
        if (Math.abs(m.x - mob.x) > 18 || Math.abs(m.y - mob.y) > 18) continue;
        preObservers.push(m);
      }
      if (removeEntity) {
        const rm = removeEntity(mob.serial);
        for (const m of preObservers) m.client.send(rm);
      }
      mob.x = dest.x & 0xffff;
      mob.y = dest.y & 0xffff;
      mob.z = (dest.z | 0);
      if (Number.isFinite(dest.map)) mob.map = dest.map | 0;
      world?.sectors?.moveMobile?.(mob);
      // Self: mobileUpdate so the player's client snaps to the new
      // position (and re-requests nearby chunks via the normal flow).
      if (mob.client && mobileUpdate) {
        mob.client.send(mobileUpdate({
          serial: mob.serial, body: mob.body, hue: mob.hue ?? 0,
          flags: mob.flags ?? 0,
          x: mob.x, y: mob.y, z: mob.z, direction: mob.direction ?? 0,
        }));
      }
      // Post-observers: anyone now within 18 tiles on the new map.
      if (mobileMoving) {
        const moving = mobileMoving({
          serial: mob.serial, body: mob.body,
          x: mob.x, y: mob.y, z: mob.z,
          direction: mob.direction ?? 0, hue: mob.hue ?? 0,
          flags: mob.flags ?? 0, notoriety: mob.notoriety ?? 1,
        });
        for (const m of world.mobiles.values()) {
          if (!m.client || m === mob) continue;
          if (m.map !== mob.map) continue;
          if (Math.abs(m.x - mob.x) > 18 || Math.abs(m.y - mob.y) > 18) continue;
          m.client.send(moving);
        }
      }
      // Push every nearby mob/item back to the teleporter — without this,
      // they snap to the new tile but see an empty viewport (the spawn
      // rect's mobs are server-side, but no client packet announces them
      // until the next 0x77 broadcast). Same code path as 0x22 resync.
      // The refresh can serialize hundreds of nearby entities. Defer it so
      // the admin HTTP response and button state are released immediately;
      // mobileUpdate above already moves the player on the client at once.
      if (mob.client) setImmediate(() => {
        try { scheduleRefreshSurroundings(mob.client, { priority: 0 }); }
        catch (e) { console.error('[admin/teleport] refreshSurroundings:', e.message); }
      });
      return {
        ok: true, character: target.name, mobileSerial: '0x' + (mob.serial >>> 0).toString(16),
        x: mob.x, y: mob.y, z: mob.z, map: mob.map,
      };
    },
  });

  // Teleport ANY mobile to the location of an item. The item may be on the
  // ground (uses item.x/y/z) or worn / contained — in those cases we walk
  // the parent chain to find the eventual ground anchor (the worn-by mobile
  // or the chest's ground tile). Body: `{ mobileSerial: '0x...' }`.
  routes.push({
    method: 'POST', path: '/api/items/:serial/teleport',
    run: ({ params, body }) => {
      const itemSerial = parseSerial(params.serial);
      const mobSerial  = parseSerial(body?.mobileSerial);
      const it = world?.items?.get?.(itemSerial);
      if (!it) return { error: 'item not found' };
      const mob = world?.mobiles?.get?.(mobSerial);
      if (!mob) return { error: 'mobile not found (pass mobileSerial as 0x... in body)' };
      // Resolve to a ground tile by walking parent chain. A worn item's
      // "position" is the wearer's tile; a chest-contained item's
      // position is the chest's tile (which may itself be worn — keep
      // walking, max 8 hops to avoid pathological cycles).
      let anchor = it; let hops = 0;
      while (anchor.parent && hops++ < 8) {
        const p = world?.items?.get?.(anchor.parent)
               ?? world?.mobiles?.get?.(anchor.parent);
        if (!p) break;
        anchor = p;
      }
      if (!Number.isFinite(anchor?.x) || !Number.isFinite(anchor?.y)) {
        return { error: 'item has no resolvable ground position' };
      }
      mob.x = anchor.x | 0;
      mob.y = anchor.y | 0;
      mob.z = anchor.z | 0;
      if (Number.isFinite(anchor.map)) mob.map = anchor.map | 0;
      world?.sectors?.moveMobile?.(mob);
      return { ok: true, x: mob.x, y: mob.y, z: mob.z, map: mob.map,
               anchorKind: anchor === it ? 'item' : 'parent' };
    },
  });
}
