import { resolveItemArg } from '../_targeting-helpers.js';
import { createItem, destroyItemBySerial } from '../../_items.js';
import { findBackpack, isContainedBy } from '../../_inventory.js';
import { moveItem, moveMobile } from '../../_movement.js';
import { allItems, allMobiles } from '../../_spatial.js';
import { itemBySerial } from '../../_entities.js';

// `[showcase <serial>` — GM-only: pin an item into a display case at the
// caller's feet. The pinned item becomes immovable, gets a `_displayed`
// marker, and the case carries `display: { itemSerial }` so the runtime
// renders it on top of the case graphic.
//
// Mirrors UO/ServUO's town-square trophy-case mechanic: bosses' rare
// drops sometimes get pinned to museums or guild halls. Without it,
// players can't show off their unique greater artifacts publicly —
// they sit in a backpack invisible to everyone else.
//
// Companion command:
//   `[showcase remove <caseSerial>` — release the pinned item back to
//   the GM's pack and delete the case.

const CASE_ITEM_ID = 0x10A6; // glass display case (decorative, immovable)

function findPack(world, mob) {
  return findBackpack({ world }, mob)?.serial ?? null;
}

export default function (api) {
  const { commands, world } = api;
  if (!commands) return () => {};

  commands.register({
    name: 'showcase',
    help: '[showcase <serial> | [showcase remove|rotate <case-serial> — pin/manage display case (GM).',
    access: 'GM',
    run(ctx) {
      const mob = ctx.sender;
      if (!mob) return;
      const sub = String(ctx.args[0] ?? '').toLowerCase();

      // Wave 22: `[showcase tour [tag]` — Player-friendly museum
      // walking-tour. Lists every filled showcase on the player's
      // current map (optionally restricted to `display.tourTag` for
      // themed groupings: 'rares', 'paladin', etc). Output is sorted
      // by tile distance from the caller so the player can walk a
      // natural path through the cases.
      if (sub === 'tour') {
        const tag = ctx.args[1]?.toLowerCase();
        /** @type {Array<{c:any, dist:number, pinned:any}>} */
        const tour = [];
        for (const it of allItems({ world })) {
          if (!it.display?.itemSerial) continue;
          if (it.map !== mob.map) continue;
          if (tag && String(it.display.tourTag ?? '').toLowerCase() !== tag) continue;
          const pinned = itemBySerial({ world }, it.display.itemSerial);
          if (!pinned) continue;
          const dx = (it.x ?? 0) - (mob.x ?? 0);
          const dy = (it.y ?? 0) - (mob.y ?? 0);
          tour.push({ c: it, dist: Math.max(Math.abs(dx), Math.abs(dy)), pinned });
        }
        tour.sort((a, b) => a.dist - b.dist);
        if (!tour.length) {
          ctx.state.sendSystemMessage(
            tag ? `No tour cases tagged "${tag}" on this map.` : 'No display cases on this map.',
          );
          return;
        }
        const lines = [`Museum tour${tag ? ` — ${tag}` : ''}: ${tour.length} cases`];
        const cap = 25;
        for (const t of tour.slice(0, cap)) {
          const desc = t.pinned._artifact ?? t.pinned.name ?? `item id 0x${(t.pinned.itemId | 0).toString(16)}`;
          const propCount = Array.isArray(t.pinned._magicProps) ? t.pinned._magicProps.length : 0;
          const propTag = propCount > 0 ? ` (${propCount} prop${propCount === 1 ? '' : 's'})` : '';
          const dirHint = t.dist === 0 ? 'here' : `${t.dist} tiles away at ${t.c.x},${t.c.y}`;
          lines.push(`  ⊡ ${desc}${propTag}  — ${dirHint}`);
        }
        if (tour.length > cap) {
          lines.push(`  … ${tour.length - cap} more cases off this list.`);
        }
        ctx.state.sendSystemMessage(lines.join('\n'));
        return;
      }

      // Wave 22: `[showcase tag <case-serial> <tag>` — GM stamps a
      // group tag on a case so it shows up under that subset in
      // `[showcase tour <tag>`. Empty tag clears.
      if (sub === 'tag') {
        const caseArg = ctx.args[1];
        const tagVal = ctx.args.slice(2).join(' ').trim();
        if (!caseArg) { ctx.state.sendSystemMessage('Usage: [showcase tag <case-serial> [tag]'); return; }
        const caseSerial = (/^0x/i.test(caseArg) ? parseInt(caseArg, 16) : parseInt(caseArg, 10)) >>> 0;
        const display = itemBySerial({ world }, caseSerial);
        if (!display?.display) { ctx.state.sendSystemMessage('No display case at that serial.'); return; }
        if (tagVal) display.display.tourTag = tagVal;
        else delete display.display.tourTag;
        ctx.state.sendSystemMessage(`Case 0x${caseSerial.toString(16)} tag = ${tagVal || '(none)'}.`);
        return;
      }

      // Wave 21: `[showcase list [filter]` — GM browser. Iterates
      // every item carrying `display.itemSerial`/`display.reservedFor`
      // and prints location, status, and either pinned-item summary
      // or "(reserved for X)". Optional substring filter applies to
      // pinned-item names + reservedFor strings.
      if (sub === 'list') {
        const filter = ctx.args[1]?.toLowerCase();
        const cases = [];
        for (const it of allItems({ world })) {
          if (!it.display) continue;
          cases.push(it);
        }
        if (filter) {
          for (let i = cases.length - 1; i >= 0; i--) {
            const c = cases[i];
            const pinned = c.display.itemSerial ? itemBySerial({ world }, c.display.itemSerial) : null;
            const haystack = (
              (pinned?._artifact ?? '') + ' ' +
              (pinned?.name ?? '') + ' ' +
              (c.display.reservedFor ?? '')
            ).toLowerCase();
            if (!haystack.includes(filter)) cases.splice(i, 1);
          }
        }
        if (!cases.length) {
          ctx.state.sendSystemMessage(
            filter
              ? `No display cases match "${filter}".`
              : 'No display cases registered.',
          );
          return;
        }
        const lines = [`Display cases: ${cases.length}${filter ? ` (filtered)` : ''}.`];
        const cap = 25;
        for (const c of cases.slice(0, cap)) {
          const loc = `[${c.x},${c.y},${c.z} m${c.map ?? '?'}]`;
          const tag = `0x${(c.serial >>> 0).toString(16)}`;
          if (c.display.itemSerial) {
            const pinned = itemBySerial({ world }, c.display.itemSerial);
            const desc = pinned?._artifact
              ? `[${pinned._artifact}]`
              : (pinned?.name ?? `item id 0x${(pinned?.itemId | 0).toString(16)}`);
            lines.push(`  ${tag} ${loc.padEnd(20)} pinned: ${desc}`);
          } else if (c.display.reservedFor) {
            lines.push(`  ${tag} ${loc.padEnd(20)} reserved for ${c.display.reservedFor} (empty)`);
          } else {
            lines.push(`  ${tag} ${loc.padEnd(20)} empty`);
          }
        }
        if (cases.length > cap) {
          lines.push(`  … ${cases.length - cap} more.`);
        }
        ctx.state.sendSystemMessage(lines.join('\n'));
        return;
      }

      // Wave 20: `[showcase reserve <player-name>` — GM creates an
      // EMPTY display case at their feet, tagged with the recipient
      // player's name. Anyone can later `[showcase fill <case-serial>
      // <itemSerial>` to deposit an item, but only when their name
      // matches `display.reservedFor` (case-insensitive substring).
      //
      // Used by guild halls / player-run museums where a curator
      // pre-allocates slots for individual donors.
      if (sub === 'reserve') {
        const name = ctx.args.slice(1).join(' ').trim();
        if (!name) { ctx.state.sendSystemMessage('Usage: [showcase reserve <player-name>'); return; }
        const display = createItem(api, world, {
          itemId: CASE_ITEM_ID, hue: 0, amount: 1,
          x: mob.x, y: mob.y, z: mob.z, map: mob.map,
          name: `display case (reserved for ${name})`,
          movable: false,
        });
        if (!display) { ctx.state.sendSystemMessage('Failed to spawn case.'); return; }
        display.display = { itemSerial: 0, reservedFor: name };
        if (api.protocol?.worldItemSA) {
          const pkt = api.protocol.worldItemSA({
            serial: display.serial, itemId: display.itemId, hue: 0, amount: 1,
            x: display.x, y: display.y, z: display.z,
          });
          for (const m of allMobiles({ world })) {
            if (!m.client || m.map !== display.map) continue;
            if (Math.abs(m.x - display.x) > 18 || Math.abs(m.y - display.y) > 18) continue;
            m.client.send(pkt);
          }
        }
        ctx.state.sendSystemMessage(
          `Reserved case 0x${display.serial.toString(16)} for ${name}.`,
        );
        return;
      }

      // Wave 20: `[showcase fill <case-serial> <itemSerial>` — Player
      // deposits one of their items into a previously-reserved case.
      // Identity check uses substring match on the player's display
      // name vs `display.reservedFor` (lower-cased). The item is
      // pinned exactly like a GM-driven `[showcase` would do.
      if (sub === 'fill') {
        const argA = ctx.args[1];
        const argB = ctx.args[2];
        if (!argA || !argB) { ctx.state.sendSystemMessage('Usage: [showcase fill <case-serial> <itemSerial>'); return; }
        const caseSerial = (/^0x/i.test(argA) ? parseInt(argA, 16) : parseInt(argA, 10)) >>> 0;
        const itemSerial = (/^0x/i.test(argB) ? parseInt(argB, 16) : parseInt(argB, 10)) >>> 0;
        const display = itemBySerial({ world }, caseSerial);
        if (!display?.display) {
          ctx.state.sendSystemMessage('No display case at that serial.');
          return;
        }
        if (display.display.itemSerial) {
          ctx.state.sendSystemMessage('That case already holds an item.');
          return;
        }
        const reservedFor = String(display.display.reservedFor ?? '').toLowerCase();
        if (reservedFor && !String(mob.name ?? '').toLowerCase().includes(reservedFor)) {
          ctx.state.sendSystemMessage(`That slot is reserved for ${display.display.reservedFor}.`);
          return;
        }
        const target = itemBySerial({ world }, itemSerial);
        if (!target) { ctx.state.sendSystemMessage('No such item.'); return; }
        // Range gate: target must be in the player's pack so a thief
        // can't fill a case using someone else's item.
        const pack = findBackpack({ world }, mob);
        const inPack = pack && isContainedBy({ world }, target, pack);
        if (!inPack) {
          ctx.state.sendSystemMessage('That item is not in your backpack.');
          return;
        }
        target._displayed = true;
        target.movable = false;
        moveItem(api, target, { parent: display.serial });
        target.layer = 0;
        display.display.itemSerial = itemSerial;
        const filledMsg = target._artifact
          ? `${mob.name} placed ${target._artifact} into the reserved case!`
          : `${mob.name} placed an item into the reserved case.`;
        for (const m of allMobiles({ world })) {
          if (m.client) m.client.sendSystemMessage?.(filledMsg);
        }
        ctx.state.sendSystemMessage('Donation accepted.');
        return;
      }

      // Wave 18: `[showcase inspect <case-serial>` — read-out of the
      // pinned item's details as a multi-line system message. Mirrors
      // the would-be preview gump (which needs UI/gump infra) at text
      // level. Anyone (not just GMs) can inspect a public showcase.
      if (sub === 'inspect') {
        const arg = ctx.args[1];
        if (!arg) { ctx.state.sendSystemMessage('Usage: [showcase inspect <case-serial>'); return; }
        const caseSerial = (/^0x/i.test(arg) ? parseInt(arg, 16) : parseInt(arg, 10)) >>> 0;
        const display = itemBySerial({ world }, caseSerial);
        if (!display?.display) {
          ctx.state.sendSystemMessage('No display case at that serial.');
          return;
        }
        const pinned = itemBySerial({ world }, display.display.itemSerial);
        if (!pinned) {
          ctx.state.sendSystemMessage('Display case is empty.');
          return;
        }
        const lines = ['Display case contents:'];
        if (pinned._artifact) {
          lines.push(`  Artifact: ${pinned._artifact}`);
        } else if (pinned.name) {
          lines.push(`  Item: ${pinned.name}`);
        } else {
          lines.push(`  Item id: 0x${(pinned.itemId | 0).toString(16)}`);
        }
        if (Array.isArray(pinned._magicProps) && pinned._magicProps.length) {
          lines.push('  Properties:');
          for (const p of pinned._magicProps) {
            if (p.kind === 'skill') {
              lines.push(`    +${(p.value ?? 0).toFixed(1)} ${p.skill ?? ''}`);
            } else if (p.isFlag) {
              lines.push(`    ${p.attribute ?? '?'}`);
            } else {
              const sign = (p.intensity ?? 0) >= 0 ? '+' : '';
              lines.push(`    ${sign}${p.intensity ?? 0} ${p.attribute ?? '?'}`);
            }
          }
        }
        if (pinned._magicResists && typeof pinned._magicResists === 'object') {
          const order = ['physical', 'fire', 'cold', 'poison', 'energy'];
          const parts = order.map((k) => `${k.slice(0,4)} ${pinned._magicResists[k] ?? 0}`);
          lines.push(`  Resists: ${parts.join(' / ')}`);
        }
        if (display.display.rotation) {
          lines.push(`  (rotated ${display.display.rotation}°)`);
        }
        ctx.state.sendSystemMessage(lines.join('\n'));
        return;
      }

      // Wave 17: `[showcase rotate <case-serial> [degrees]` rotates
      // the case visual by 0/90/180/270 (default toggles +90). The
      // rotation degrees are stamped on `display.rotation` (server-
      // side) and on the item itself; client tile-renderer reads it
      // off the item snapshot in worldItemSA broadcasts. Visual-only
      // — does not affect collision or pickup ranges.
      if (sub === 'rotate') {
        const arg = ctx.args[1];
        if (!arg) { ctx.state.sendSystemMessage('Usage: [showcase rotate <case-serial> [degrees]'); return; }
        const caseSerial = (/^0x/i.test(arg) ? parseInt(arg, 16) : parseInt(arg, 10)) >>> 0;
        const display = itemBySerial({ world }, caseSerial);
        if (!display?.display) {
          ctx.state.sendSystemMessage('No display case at that serial.');
          return;
        }
        const degArg = parseInt(ctx.args[2], 10);
        const cur = display.display.rotation ?? 0;
        const next = Number.isFinite(degArg)
          ? ((degArg % 360) + 360) % 360
          : (cur + 90) % 360;
        // Snap to 90° steps.
        const snapped = Math.round(next / 90) * 90 % 360;
        display.display.rotation = snapped;
        // Broadcast worldItemSA so the renderer re-mounts with the
        // new rotation. We piggy-back the spawn pattern from the
        // initial showcase call.
        if (api.protocol?.worldItemSA) {
          const pkt = api.protocol.worldItemSA({
            serial: display.serial, itemId: display.itemId, hue: 0, amount: 1,
            x: display.x, y: display.y, z: display.z,
          });
          for (const m of allMobiles({ world })) {
            if (!m.client || m.map !== display.map) continue;
            if (Math.abs(m.x - display.x) > 18 || Math.abs(m.y - display.y) > 18) continue;
            m.client.send(pkt);
          }
        }
        ctx.state.sendSystemMessage(`Showcase rotated to ${snapped}°.`);
        return;
      }

      if (sub === 'remove') {
        const arg = ctx.args[1];
        if (!arg) { ctx.state.sendSystemMessage('Usage: [showcase remove <case-serial>'); return; }
        const caseSerial = (/^0x/i.test(arg) ? parseInt(arg, 16) : parseInt(arg, 10)) >>> 0;
        const display = itemBySerial({ world }, caseSerial);
        if (!display?.display) {
          ctx.state.sendSystemMessage('No display case at that serial.');
          return;
        }
        const pinnedSerial = display.display.itemSerial;
        const pinned = itemBySerial({ world }, pinnedSerial);
        if (pinned) {
          delete pinned._displayed;
          pinned.movable = true;
          const pack = findPack(world, mob);
          moveItem(api, pinned, { parent: pack ?? mob.serial });
          if (pack && api.protocol?.containerContentUpdate) {
            ctx.state.send(api.protocol.containerContentUpdate(pinned, pack));
          }
        }
        destroyItemBySerial(api, caseSerial);
        ctx.state.send?.(api.protocol?.removeEntity?.(caseSerial));
        ctx.state.sendSystemMessage('Showcase dismantled. Pinned item returned to your pack.');
        return;
      }

      // Default: pin a serial. Wave 34: cursor target fallback when
      // called bare (`[showcase` z opcjonalnym arg → resolveItemArg).
      resolveItemArg(api, ctx, 0, (item) => {
        if (!item) return;
        const serial = item.serial >>> 0;
        if (item._displayed) { ctx.state.sendSystemMessage('That item is already on display.'); return; }

      // Spawn the display case on the GM's tile.
      const display = createItem(api, world, {
        itemId: CASE_ITEM_ID, hue: 0, amount: 1,
        x: mob.x, y: mob.y, z: mob.z, map: mob.map,
        name: item._artifact ? `display case — ${item._artifact}` : 'display case',
        movable: false,
      });
      if (!display) { ctx.state.sendSystemMessage('Failed to spawn display case.'); return; }
      display.display = { itemSerial: serial };

      // Mark the pinned item: parented to the case, locked, no longer carryable.
      item._displayed = true;
      item.movable = false;
      moveItem(api, item, { parent: display.serial });
      item.layer = 0;

      // Broadcast world notice for greater artifacts.
      if (item._artifact) {
        const line = `A ${item._artifact} is now displayed for all to admire!`;
        for (const m of allMobiles({ world })) {
          if (m.client) m.client.sendSystemMessage?.(line);
        }
      }
      // Show the case to nearby clients via worldItemSA broadcast.
      if (api.protocol?.worldItemSA) {
        const pkt = api.protocol.worldItemSA({
          serial: display.serial, itemId: display.itemId, hue: 0, amount: 1,
          x: display.x, y: display.y, z: display.z,
        });
        for (const m of allMobiles({ world })) {
          if (!m.client || m.map !== display.map) continue;
          if (Math.abs(m.x - display.x) > 18 || Math.abs(m.y - display.y) > 18) continue;
          m.client.send(pkt);
        }
      }
      ctx.state.sendSystemMessage(
        `Showcased ${item.name ?? 'item'} in case 0x${display.serial.toString(16)}.`,
      );
      });   // close resolveItemArg cb
    },
  });

  // Wave 18: Player-accessible inspect alias. Re-uses the showcase
  // command's `inspect` subhandler by forwarding the args.
  commands.register({
    name: 'showcaseinspect',
    help: '[showcaseinspect <case-serial> — read out the contents of a public display case.',
    access: 'Player',
    run(ctx) {
      const arg = ctx.args[0];
      if (!arg) { ctx.state.sendSystemMessage('Usage: [showcaseinspect <case-serial>'); return; }
      const caseSerial = (/^0x/i.test(arg) ? parseInt(arg, 16) : parseInt(arg, 10)) >>> 0;
      const display = itemBySerial({ world }, caseSerial);
      if (!display?.display) {
        ctx.state.sendSystemMessage('No display case at that serial.');
        return;
      }
      const pinned = itemBySerial({ world }, display.display.itemSerial);
      if (!pinned) {
        ctx.state.sendSystemMessage('Display case is empty.');
        return;
      }
      const lines = ['Display case contents:'];
      if (pinned._artifact) lines.push(`  Artifact: ${pinned._artifact}`);
      else if (pinned.name) lines.push(`  Item: ${pinned.name}`);
      else lines.push(`  Item id: 0x${(pinned.itemId | 0).toString(16)}`);
      if (Array.isArray(pinned._magicProps) && pinned._magicProps.length) {
        lines.push('  Properties:');
        for (const p of pinned._magicProps) {
          if (p.kind === 'skill') {
            lines.push(`    +${(p.value ?? 0).toFixed(1)} ${p.skill ?? ''}`);
          } else if (p.isFlag) {
            lines.push(`    ${p.attribute ?? '?'}`);
          } else {
            const sign = (p.intensity ?? 0) >= 0 ? '+' : '';
            lines.push(`    ${sign}${p.intensity ?? 0} ${p.attribute ?? '?'}`);
          }
        }
      }
      if (pinned._magicResists && typeof pinned._magicResists === 'object') {
        const order = ['physical','fire','cold','poison','energy'];
        const parts = order.map((k) => `${k.slice(0,4)} ${pinned._magicResists[k] ?? 0}`);
        lines.push(`  Resists: ${parts.join(' / ')}`);
      }
      if (display.display.rotation) {
        lines.push(`  (rotated ${display.display.rotation}°)`);
      }
      ctx.state.sendSystemMessage(lines.join('\n'));
    },
  });

  // Wave 20: Player-accessible alias for filling a reserved case.
  // The owner-checked `display.reservedFor` substring already guards
  // against misuse; we just expose the mechanic outside the GM gate.
  commands.register({
    name: 'showcasefill',
    help: '[showcasefill <case-serial> <itemSerial> — donate an item to a reserved display case.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      if (!mob) return;
      const argA = ctx.args[0];
      const argB = ctx.args[1];
      if (!argA || !argB) { ctx.state.sendSystemMessage('Usage: [showcasefill <case-serial> <itemSerial>'); return; }
      const caseSerial = (/^0x/i.test(argA) ? parseInt(argA, 16) : parseInt(argA, 10)) >>> 0;
      const itemSerial = (/^0x/i.test(argB) ? parseInt(argB, 16) : parseInt(argB, 10)) >>> 0;
      const display = itemBySerial({ world }, caseSerial);
      if (!display?.display) { ctx.state.sendSystemMessage('No display case at that serial.'); return; }
      if (display.display.itemSerial) { ctx.state.sendSystemMessage('That case already holds an item.'); return; }
      const reservedFor = String(display.display.reservedFor ?? '').toLowerCase();
      if (reservedFor && !String(mob.name ?? '').toLowerCase().includes(reservedFor)) {
        ctx.state.sendSystemMessage(`That slot is reserved for ${display.display.reservedFor}.`);
        return;
      }
      const target = itemBySerial({ world }, itemSerial);
      if (!target) { ctx.state.sendSystemMessage('No such item.'); return; }
      const pack = findBackpack({ world }, mob);
      const inPack = pack && isContainedBy({ world }, target, pack);
      if (!inPack) { ctx.state.sendSystemMessage('That item is not in your backpack.'); return; }
      target._displayed = true;
      target.movable = false;
      moveItem(api, target, { parent: display.serial });
      target.layer = 0;
      display.display.itemSerial = itemSerial;
      const filledMsg = target._artifact
        ? `${mob.name} placed ${target._artifact} into the reserved case!`
        : `${mob.name} placed an item into the reserved case.`;
      for (const m of allMobiles({ world })) {
        if (m.client) m.client.sendSystemMessage?.(filledMsg);
      }
      ctx.state.sendSystemMessage('Donation accepted.');
    },
  });

  // Wave 22: Player-accessible tour alias.
  // Wave 23: clickable gump version when api.gumps is wired — text
  // fallback retained for headless clients.
  commands.register({
    name: 'showcasetour',
    help: '[showcasetour [tag] — list display cases on this map, sorted by distance.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      if (!mob) return;
      const tag = ctx.args[0]?.toLowerCase();
      const tour = [];
      for (const it of allItems({ world })) {
        if (!it.display?.itemSerial) continue;
        if (it.map !== mob.map) continue;
        if (tag && String(it.display.tourTag ?? '').toLowerCase() !== tag) continue;
        const pinned = itemBySerial({ world }, it.display.itemSerial);
        if (!pinned) continue;
        const dx = (it.x ?? 0) - (mob.x ?? 0);
        const dy = (it.y ?? 0) - (mob.y ?? 0);
        tour.push({ c: it, dist: Math.max(Math.abs(dx), Math.abs(dy)), pinned });
      }
      tour.sort((a, b) => a.dist - b.dist);
      if (!tour.length) {
        ctx.state.sendSystemMessage(
          tag ? `No tour cases tagged "${tag}" on this map.` : 'No display cases on this map.',
        );
        return;
      }

      // Wave 23: clickable gump path. Each tour entry gets an
      // arrow-up button (4011/4012) which dispatches `inspect` for
      // that case (text readout sent as system message). No paging
      // (cap 12 rows so the gump stays compact).
      // Wave 24: each row also gets a "Walk" button (4014/4015 left
      // arrow) that teleports the caller adjacent to the case (one
      // tile north) and broadcasts the move to nearby clients.
      if (api.gumps?.send) {
        const W = 460, ROW_H = 18;
        const cap = 12;
        const slice = tour.slice(0, cap);
        const H = 80 + slice.length * ROW_H + 40;
        const layout = [`{ resizepic 0 0 5054 ${W} ${H} }`, `{ text 16 14 1153 0 }`];
        const texts = [`Museum tour${tag ? ` — ${tag}` : ''}: ${tour.length} cases`];
        let txIdx = 1;
        let y = 44;
        const inspectMap = new Map();
        const walkMap = new Map();
        for (let i = 0; i < slice.length; i++) {
          const t = slice[i];
          const desc = t.pinned._artifact ?? t.pinned.name ?? `item id 0x${(t.pinned.itemId | 0).toString(16)}`;
          const propCount = Array.isArray(t.pinned._magicProps) ? t.pinned._magicProps.length : 0;
          const propTag = propCount > 0 ? ` (${propCount}p)` : '';
          const dirHint = t.dist === 0 ? 'here' : `${t.dist}t @${t.c.x},${t.c.y}`;
          const inspectId = 200 + i;
          const walkId = 400 + i;
          inspectMap.set(inspectId, t.c.serial);
          walkMap.set(walkId, t.c.serial);
          layout.push(`{ button 16 ${y} 4011 4012 1 0 ${inspectId} }`);
          layout.push(`{ button 36 ${y} 4014 4015 1 0 ${walkId} }`);
          layout.push(`{ text 60 ${y} 1152 ${txIdx} }`);
          texts.push(`${desc}${propTag} — ${dirHint}`);
          txIdx++; y += ROW_H;
        }
        if (tour.length > cap) {
          layout.push(`{ text 16 ${y} 1152 ${txIdx} }`);
          texts.push(`… ${tour.length - cap} more cases off this list.`);
          txIdx++;
        }
        layout.push(`{ button ${W - 60} ${H - 30} 4020 4021 1 0 0 }`);
        layout.push(`{ text ${W - 30} ${H - 30} 1153 ${txIdx} }`);
        texts.push('OK');
        api.gumps.send(ctx.state, {
          gumpId: 0xB10B10B4, x: 100, y: 60,
          layout: layout.join(''), texts,
        }, (resp) => {
          const id = resp?.buttonId | 0;
          // Wave 24: Walk-to dispatch — teleport caller to the tile
          // immediately north of the case (case stays immovable;
          // bumping the player there is the cheapest way to "walk
          // them over" without a real pathfinder. We reuse the
          // remove-then-broadcast pattern from `[go`).
          const walkSerial = walkMap.get(id);
          if (walkSerial) {
            const caseObj = itemBySerial({ world }, walkSerial);
            if (!caseObj) { ctx.state.sendSystemMessage('Case is gone.'); return; }
            const sender = mob;
            const preObservers = [];
            for (const m of allMobiles({ world })) {
              if (!m.client || m === sender) continue;
              if (m.map !== sender.map) continue;
              if (Math.abs(m.x - sender.x) > 18 || Math.abs(m.y - sender.y) > 18) continue;
              preObservers.push(m);
            }
            if (api.protocol?.removeEntity) {
              const rm = api.protocol.removeEntity(sender.serial);
              for (const m of preObservers) m.client.send(rm);
            }
            moveMobile(api, sender, {
              x: caseObj.x | 0,
              y: ((caseObj.y | 0) - 1) & 0xffff,     // tile north
              z: (caseObj.z | 0) & 0xff,
              map: caseObj.map | 0,
            });
            if (sender.client && api.protocol?.mobileUpdate) {
              sender.client.send(api.protocol.mobileUpdate({
                serial: sender.serial, body: sender.body, hue: sender.hue ?? 0,
                flags: sender.flags ?? 0,
                x: sender.x, y: sender.y, z: sender.z, direction: sender.direction ?? 0,
              }));
            }
            if (api.protocol?.mobileMoving) {
              const moving = api.protocol.mobileMoving({
                serial: sender.serial, body: sender.body,
                x: sender.x, y: sender.y, z: sender.z,
                direction: sender.direction ?? 0, hue: sender.hue ?? 0,
                flags: sender.flags ?? 0, notoriety: sender.notoriety ?? 1,
              });
              for (const m of allMobiles({ world })) {
                if (!m.client || m === sender || m.map !== sender.map) continue;
                if (Math.abs(m.x - sender.x) > 18 || Math.abs(m.y - sender.y) > 18) continue;
                m.client.send(moving);
              }
            }
            ctx.state.sendSystemMessage(`Walked to case 0x${(walkSerial >>> 0).toString(16)}.`);
            return;
          }
          const caseSerial = inspectMap.get(id);
          if (!caseSerial) return;
          // Inline the same readout `[showcaseinspect` produces.
          const display = itemBySerial({ world }, caseSerial);
          const pinned = display?.display?.itemSerial
            ? itemBySerial({ world }, display.display.itemSerial)
            : null;
          if (!pinned) {
            ctx.state.sendSystemMessage('That case is empty.');
            return;
          }
          const lines = [`Display case 0x${caseSerial.toString(16)}:`];
          if (pinned._artifact) lines.push(`  Artifact: ${pinned._artifact}`);
          else if (pinned.name) lines.push(`  Item: ${pinned.name}`);
          else lines.push(`  Item id: 0x${(pinned.itemId | 0).toString(16)}`);
          if (Array.isArray(pinned._magicProps) && pinned._magicProps.length) {
            lines.push('  Properties:');
            for (const p of pinned._magicProps) {
              if (p.kind === 'skill') lines.push(`    +${(p.value ?? 0).toFixed(1)} ${p.skill ?? ''}`);
              else if (p.isFlag)     lines.push(`    ${p.attribute ?? '?'}`);
              else {
                const sign = (p.intensity ?? 0) >= 0 ? '+' : '';
                lines.push(`    ${sign}${p.intensity ?? 0} ${p.attribute ?? '?'}`);
              }
            }
          }
          if (pinned._magicResists && typeof pinned._magicResists === 'object') {
            const order = ['physical','fire','cold','poison','energy'];
            const parts = order.map((k) => `${k.slice(0,4)} ${pinned._magicResists[k] ?? 0}`);
            lines.push(`  Resists: ${parts.join(' / ')}`);
          }
          ctx.state.sendSystemMessage(lines.join('\n'));
        });
        return;
      }

      // Text fallback.
      const lines = [`Museum tour${tag ? ` — ${tag}` : ''}: ${tour.length} cases`];
      const cap = 25;
      for (const t of tour.slice(0, cap)) {
        const desc = t.pinned._artifact ?? t.pinned.name ?? `item id 0x${(t.pinned.itemId | 0).toString(16)}`;
        const propCount = Array.isArray(t.pinned._magicProps) ? t.pinned._magicProps.length : 0;
        const propTag = propCount > 0 ? ` (${propCount} prop${propCount === 1 ? '' : 's'})` : '';
        const dirHint = t.dist === 0 ? 'here' : `${t.dist} tiles away at ${t.c.x},${t.c.y}`;
        lines.push(`  ⊡ ${desc}${propTag}  — ${dirHint}`);
      }
      if (tour.length > cap) lines.push(`  … ${tour.length - cap} more cases off this list.`);
      ctx.state.sendSystemMessage(lines.join('\n'));
    },
  });

  // Wave 25: `[showcasewalkall [tag]` — automated guided tour. Steps
  // gracza przez every filled case na mapie z 5s delay between each.
  // Cancel via the Stop button on the running gump (or by simply
  // moving — server doesn't enforce, the timer just keeps firing
  // setSerial messages). Stops on map switch or disconnect.
  commands.register({
    name: 'showcasewalkall',
    help: '[showcasewalkall [tag] | pause/resume/start/jump/back/strict/fast/slow/normal/ramp/echo — auto-tour.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      if (!mob) return;
      // Wave 26: pause / resume sub-commands. The running tour
      // checks `mob._tourPaused` each step — true skips advancing
      // and re-arms the timer; false (or undefined) walks normally.
      const subArg = ctx.args[0]?.toLowerCase();
      if (subArg === 'pause') {
        if (!mob._activeTourId) {
          ctx.state.sendSystemMessage('No active tour to pause.');
          return;
        }
        mob._tourPaused = true;
        ctx.state.sendSystemMessage('Tour paused. Run `[showcasewalkall resume` to continue.');
        return;
      }
      if (subArg === 'resume') {
        if (!mob._activeTourId) {
          ctx.state.sendSystemMessage('No active tour to resume.');
          return;
        }
        mob._tourPaused = false;
        ctx.state.sendSystemMessage('Tour resumed.');
        return;
      }
      // Wave 33: `[showcasewalkall echo on|off` — broadcast each
      // step's "(N/M) {desc}" line as overhead speech from the
      // touring player so nearby observers see the museum-guide
      // narration. Off (default) keeps the message private.
      if (subArg === 'echo') {
        if (!mob._activeTourId) {
          ctx.state.sendSystemMessage('No active tour to toggle echo on.');
          return;
        }
        const opt = String(ctx.args[1] ?? '').toLowerCase();
        if (opt === 'on') {
          mob._tourEcho = true;
          ctx.state.sendSystemMessage('Tour echo ON — step messages broadcast to nearby observers.');
        } else if (opt === 'off') {
          delete mob._tourEcho;
          ctx.state.sendSystemMessage('Tour echo OFF.');
        } else if (opt === 'hue') {
          // Wave 34: configurable echo hue (decimal or 0x..). 0 reverts to default.
          // Wave 35: trailing `default` makes the chosen hue the
          // player's persistent default — applied automatically to
          // future tours via `_tourEchoHueDefault` (whitelisted).
          // Wave 36: bare `echo hue` with no value → swatch picker
          // gump (8 common echo colors + custom textentry).
          const raw = ctx.args[2];
          if (!raw) {
            if (api.gumps?.send) {
              openEchoHueGump(api, ctx, mob);
              return;
            }
            ctx.state.sendSystemMessage('Usage: [showcasewalkall echo hue <N> [default]');
            return;
          }
          const flag = String(ctx.args[3] ?? '').toLowerCase();
          const v = /^0x/i.test(raw) ? parseInt(raw, 16) : parseInt(raw, 10);
          if (!Number.isFinite(v) || v < 0 || v > 0xFFFF) {
            ctx.state.sendSystemMessage('Echo hue must be 0..0xFFFF.');
            return;
          }
          if (v === 0) {
            delete mob._tourEchoHue;
            if (flag === 'default') delete mob._tourEchoHueDefault;
            ctx.state.sendSystemMessage(
              flag === 'default'
                ? 'Echo hue and default reset.'
                : 'Echo hue reset to default.',
            );
          } else {
            mob._tourEchoHue = v;
            if (flag === 'default') {
              mob._tourEchoHueDefault = v;
              ctx.state.sendSystemMessage(`Echo hue set to 0x${v.toString(16).toUpperCase()} (now your default).`);
            } else {
              ctx.state.sendSystemMessage(`Echo hue set to 0x${v.toString(16).toUpperCase()}.`);
            }
          }
        } else {
          ctx.state.sendSystemMessage('Usage: [showcasewalkall echo on|off|hue <N>');
        }
        return;
      }
      // Wave 32: `[showcasewalkall ramp` — smooth fast→normal pace
      // tween across the tour. Stamps `mob._tourRamp = true` so
      // stepOne computes pace as a linear interpolation between
      // 2500ms (start) and 5000ms (end) based on cursor progress.
      // `[showcasewalkall ramp off` clears the flag.
      if (subArg === 'ramp') {
        if (!mob._activeTourId) {
          ctx.state.sendSystemMessage('No active tour to ramp.');
          return;
        }
        const off = String(ctx.args[1] ?? '').toLowerCase() === 'off';
        if (off) {
          delete mob._tourRamp;
          ctx.state.sendSystemMessage('Pace ramp disabled.');
        } else {
          mob._tourRamp = true;
          // Clear any explicit fast/slow override — ramp wins.
          delete mob._tourStepMs;
          ctx.state.sendSystemMessage('Pace ramp enabled (fast→normal across the tour).');
        }
        return;
      }
      // Wave 31: `[showcasewalkall fast | slow | normal` — speed
      // modifiers. Sets `mob._tourStepMs` (default 5000); fast=2500,
      // slow=10000, normal clears the override. Picks up on next
      // stepOne tick — current setTimeout ride finishes at the prior
      // cadence, then new pace kicks in.
      if (subArg === 'fast' || subArg === 'slow' || subArg === 'normal') {
        if (!mob._activeTourId) {
          ctx.state.sendSystemMessage('No active tour to retime.');
          return;
        }
        if (subArg === 'fast')   mob._tourStepMs = 2500;
        if (subArg === 'slow')   mob._tourStepMs = 10000;
        if (subArg === 'normal') delete mob._tourStepMs;
        ctx.state.sendSystemMessage(
          `Tour pace → ${subArg} (${mob._tourStepMs ?? 5000} ms/step).`,
        );
        return;
      }
      // Wave 30: `[showcasewalkall strict` — toggle cancel-on-move.
      // When enabled, the tour aborts if the player's tile changes
      // between two consecutive steps (i.e. they walked off course).
      // Useful for kiosk-style demos where you want a hands-off
      // self-paced tour and any input cancels it.
      if (subArg === 'strict') {
        if (!mob._activeTourId) {
          ctx.state.sendSystemMessage('No active tour to set strict mode on.');
          return;
        }
        mob._tourStrict = !mob._tourStrict;
        ctx.state.sendSystemMessage(
          mob._tourStrict
            ? 'Strict mode ON — tour cancels if you move between steps.'
            : 'Strict mode OFF — manual movement is allowed.',
        );
        return;
      }
      // Wave 29: `[showcasewalkall back [N]` — rewind cursor by N
      // (default 1). Saturates at 0 (start). Auto-resumes if paused.
      if (subArg === 'back') {
        if (!mob._activeTourId) {
          ctx.state.sendSystemMessage('No active tour to rewind in.');
          return;
        }
        const n = parseInt(ctx.args[1], 10);
        const steps = Number.isFinite(n) && n > 0 ? n : 1;
        const before = mob._tourIdx ?? 0;
        mob._tourIdx = Math.max(0, before - steps);
        mob._tourPaused = false;
        ctx.state.sendSystemMessage(
          `Tour cursor rewound from ${before} to ${mob._tourIdx}. Will advance on next step.`,
        );
        return;
      }
      // Wave 28: `[showcasewalkall jump <N>` — fast-forward (or
      // rewind) the active tour cursor to the 1-indexed case N.
      // Bounds-clamped to [1..tourLength]. Tour resumes from there
      // on the next stepOne tick. Useful when the player wants to
      // skip ahead to a specific exhibit they remember.
      if (subArg === 'jump') {
        if (!mob._activeTourId) {
          ctx.state.sendSystemMessage('No active tour to jump in.');
          return;
        }
        const n = parseInt(ctx.args[1], 10);
        if (!Number.isFinite(n) || n < 1) {
          ctx.state.sendSystemMessage('Usage: [showcasewalkall jump <N>');
          return;
        }
        // We don't have direct access to `tour.length` outside the
        // closure; trust the running tour to bounds-clamp on the next
        // tick. Setting idx = N - 1 means stepOne will advance to N.
        mob._tourIdx = n - 1;
        // Auto-resume if paused — jumping implies "go now".
        mob._tourPaused = false;
        ctx.state.sendSystemMessage(`Tour cursor set to case ${n}. Will advance on next step.`);
        return;
      }
      // Wave 27: jump back to the first case of the active tour.
      // Useful when paused tour drifts and the player wants to
      // recenter without canceling.
      if (subArg === 'start') {
        if (!mob._activeTourId) {
          ctx.state.sendSystemMessage('No active tour to restart.');
          return;
        }
        const cases = [];
        for (const it of allItems({ world })) {
          if (!it.display?.itemSerial) continue;
          if (it.map !== mob.map) continue;
          cases.push(it);
        }
        if (!cases.length) {
          ctx.state.sendSystemMessage('No display cases on this map.');
          return;
        }
        cases.sort((a, b) => {
          const da = Math.max(Math.abs(a.x - mob.x), Math.abs(a.y - mob.y));
          const db = Math.max(Math.abs(b.x - mob.x), Math.abs(b.y - mob.y));
          return da - db;
        });
        const c0 = cases[0];
        const preObservers = [];
        for (const m of allMobiles({ world })) {
          if (!m.client || m === mob) continue;
          if (m.map !== mob.map) continue;
          if (Math.abs(m.x - mob.x) > 18 || Math.abs(m.y - mob.y) > 18) continue;
          preObservers.push(m);
        }
        if (api.protocol?.removeEntity) {
          const rm = api.protocol.removeEntity(mob.serial);
          for (const m of preObservers) m.client.send(rm);
        }
        moveMobile(api, mob, {
          x: c0.x | 0,
          y: ((c0.y | 0) - 1) & 0xffff,
          z: (c0.z | 0) & 0xff,
        });
        if (mob.client && api.protocol?.mobileUpdate) {
          mob.client.send(api.protocol.mobileUpdate({
            serial: mob.serial, body: mob.body, hue: mob.hue ?? 0,
            flags: mob.flags ?? 0,
            x: mob.x, y: mob.y, z: mob.z, direction: mob.direction ?? 0,
          }));
        }
        if (api.protocol?.mobileMoving) {
          const moving = api.protocol.mobileMoving({
            serial: mob.serial, body: mob.body,
            x: mob.x, y: mob.y, z: mob.z,
            direction: mob.direction ?? 0, hue: mob.hue ?? 0,
            flags: mob.flags ?? 0, notoriety: mob.notoriety ?? 1,
          });
          for (const m of allMobiles({ world })) {
            if (!m.client || m === mob || m.map !== mob.map) continue;
            if (Math.abs(m.x - mob.x) > 18 || Math.abs(m.y - mob.y) > 18) continue;
            m.client.send(moving);
          }
        }
        ctx.state.sendSystemMessage(`Teleported to start case 0x${(c0.serial >>> 0).toString(16)}.`);
        return;
      }
      const tag = ctx.args[0]?.toLowerCase();
      const tour = [];
      for (const it of allItems({ world })) {
        if (!it.display?.itemSerial) continue;
        if (it.map !== mob.map) continue;
        if (tag && String(it.display.tourTag ?? '').toLowerCase() !== tag) continue;
        tour.push(it);
      }
      if (!tour.length) {
        ctx.state.sendSystemMessage('No display cases on this map for the auto-tour.');
        return;
      }
      // Sort by tile distance from caller — natural walking order.
      tour.sort((a, b) => {
        const da = Math.max(Math.abs(a.x - mob.x), Math.abs(a.y - mob.y));
        const db = Math.max(Math.abs(b.x - mob.x), Math.abs(b.y - mob.y));
        return da - db;
      });
      const STEP_MS = 5_000;
      // Wave 28: store idx ON THE MOB so external sub-cmds (jump,
      // start) can mutate the cursor mid-flight. closure-local was
      // fine for pause/resume but jump needs cross-call access.
      mob._tourIdx = 0;
      // Cancel marker so a duplicate command supersedes the prior tour.
      const tourId = (mob._activeTourId = (mob._activeTourId ?? 0) + 1);
      ctx.state.sendSystemMessage(
        `Auto-tour started: ${tour.length} cases, 5s/step. Run [showcasewalkall again to cancel.`,
      );
      // Reset pause flag when a new tour starts (carry-over from a
      // previous tour would otherwise freeze the new one).
      mob._tourPaused = false;
      // Wave 35: apply the persisted echo-hue default if the player
      // set one previously. They can still override with `echo hue
      // <N>` mid-tour.
      if (mob._tourEchoHueDefault != null && mob._tourEchoHue == null) {
        mob._tourEchoHue = mob._tourEchoHueDefault;
      }
      // Wave 30: snapshot of the player's position immediately AFTER
      // the previous step's teleport — used by strict-mode to detect
      // if the player wandered off between ticks.
      let lastSnapshot = { x: mob.x, y: mob.y, map: mob.map };
      const stepOne = () => {
        // Cancel chain when caller starts a new tour, switches map,
        // or disconnects.
        if (mob._activeTourId !== tourId) return;
        // Wave 30: strict-mode cancel — if the player's position
        // diverged from the post-step snapshot, they moved manually
        // and we abort.
        if (mob._tourStrict
          && (mob.x !== lastSnapshot.x || mob.y !== lastSnapshot.y || mob.map !== lastSnapshot.map)) {
          ctx.state.sendSystemMessage('Auto-tour aborted (strict mode): you moved between steps.');
          mob._activeTourId = (mob._activeTourId ?? 0) + 1;     // supersede self
          return;
        }
        // Wave 26: pause loop — if the player issued [showcasewalkall
        // pause, we skip advancing and just re-arm the next tick.
        // The poll cadence (1s while paused) keeps reaction snappy
        // when the player resumes.
        if (mob._tourPaused) {
          const t = setTimeout(stepOne, 1000);
          if (typeof t.unref === 'function') t.unref();
          return;
        }
        if ((mob._tourIdx ?? 0) >= tour.length) {
          ctx.state.sendSystemMessage(`Auto-tour complete (${tour.length} cases visited).`);
          return;
        }
        const c = tour[mob._tourIdx++];
        if (mob.map !== c.map) {
          ctx.state.sendSystemMessage('Auto-tour aborted: you left the map.');
          return;
        }
        if (!mob.client) return;       // disconnect — stop silently
        // Teleport to the tile north of the case (the same pattern as [showcasetour
        // walk button) — broadcast removeEntity then mobileMoving.
        const preObservers = [];
        for (const m of allMobiles({ world })) {
          if (!m.client || m === mob) continue;
          if (m.map !== mob.map) continue;
          if (Math.abs(m.x - mob.x) > 18 || Math.abs(m.y - mob.y) > 18) continue;
          preObservers.push(m);
        }
        if (api.protocol?.removeEntity) {
          const rm = api.protocol.removeEntity(mob.serial);
          for (const m of preObservers) m.client.send(rm);
        }
        moveMobile(api, mob, {
          x: c.x | 0,
          y: ((c.y | 0) - 1) & 0xffff,
          z: (c.z | 0) & 0xff,
        });
        // Wave 30: refresh strict-mode snapshot to the new position.
        // Any deviation before next stepOne fires aborts the tour.
        lastSnapshot = { x: mob.x, y: mob.y, map: mob.map };
        if (api.protocol?.mobileUpdate) {
          mob.client.send(api.protocol.mobileUpdate({
            serial: mob.serial, body: mob.body, hue: mob.hue ?? 0,
            flags: mob.flags ?? 0,
            x: mob.x, y: mob.y, z: mob.z, direction: mob.direction ?? 0,
          }));
        }
        if (api.protocol?.mobileMoving) {
          const moving = api.protocol.mobileMoving({
            serial: mob.serial, body: mob.body,
            x: mob.x, y: mob.y, z: mob.z,
            direction: mob.direction ?? 0, hue: mob.hue ?? 0,
            flags: mob.flags ?? 0, notoriety: mob.notoriety ?? 1,
          });
          for (const m of allMobiles({ world })) {
            if (!m.client || m === mob || m.map !== mob.map) continue;
            if (Math.abs(m.x - mob.x) > 18 || Math.abs(m.y - mob.y) > 18) continue;
            m.client.send(moving);
          }
        }
        const pinned = itemBySerial({ world }, c.display.itemSerial);
        const desc = pinned?._artifact ?? pinned?.name ?? `item id 0x${(pinned?.itemId | 0).toString(16)}`;
        const stepLine = `(${mob._tourIdx}/${tour.length}) ${desc}`;
        ctx.state.sendSystemMessage(stepLine);
        // Wave 33: when echo mode is on, also broadcast the line as
        // overhead speech from the touring player so anyone nearby
        // sees a "museum guide" narrating the exhibits.
        if (mob._tourEcho && api.protocol?.unicodeMessage) {
          const pkt = api.protocol.unicodeMessage({
            serial: mob.serial, graphic: mob.body, type: 0,
            hue: mob._tourEchoHue ?? 0x481, font: 3, language: 'ENU',
            name: mob.name, text: stepLine,
          });
          for (const m of allMobiles({ world })) {
            if (!m.client || m === mob || m.map !== mob.map) continue;
            if (Math.abs(m.x - mob.x) > 12 || Math.abs(m.y - mob.y) > 12) continue;
            m.client.send(pkt);
          }
        }
        // Wave 31: per-tour step pace (override via fast/slow/normal).
        // Wave 32: when ramp mode is on, lerp 2500ms → STEP_MS (5000)
        // across the tour by current cursor fraction. Falls back to
        // _tourStepMs override (slow/fast) or STEP_MS default.
        let stepMs = mob._tourStepMs ?? STEP_MS;
        if (mob._tourRamp && tour.length > 1) {
          const t = (mob._tourIdx ?? 0) / (tour.length - 1);
          stepMs = Math.round(2500 + (STEP_MS - 2500) * Math.max(0, Math.min(1, t)));
        }
        const tm = setTimeout(stepOne, stepMs);
        if (typeof tm.unref === 'function') tm.unref();
      };
      stepOne();
    },
  });

  return () => {
    commands.unregister('showcase');
    commands.unregister('showcaseinspect');
    commands.unregister('showcasefill');
    commands.unregister('showcasetour');
    commands.unregister('showcasewalkall');
  };
}

/**
 * Wave 36: echo-hue swatch picker gump. Opened by bare
 * `[showcasewalkall echo hue` (no value). 8 common UO speech hues
 * + a custom textentry + Save-as-Default checkbox.
 */
function openEchoHueGump(api, ctx, mob) {
  const HUES = [
    0x0481,  // pale yellow (default)
    0x0042,  // bright green
    0x0035,  // soft red
    0x0058,  // sky blue
    0x002B,  // amber
    0x004B,  // teal
    0x0092,  // cherry red
    0x0026,  // dim grey
  ];
  const W = 280, H = 230;
  const layout = [
    `{ resizepic 0 0 5054 ${W} ${H} }`,
    `{ text 16 14 1153 0 }`,
  ];
  const texts = ['Echo hue picker'];
  let txIdx = 1;
  // 4×2 swatch grid.
  let sx = 24, sy = 38;
  const SZ = 28;
  for (let i = 0; i < HUES.length; i++) {
    const hue = HUES[i];
    layout.push(`{ tilepichue ${sx} ${sy} 0x520 ${hue} }`);
    layout.push(`{ button ${sx} ${sy} 4011 4012 1 0 ${100 + i} }`);
    layout.push(`{ text ${sx - 2} ${sy + SZ} 1152 ${txIdx} }`);
    texts.push(`0x${hue.toString(16).toUpperCase()}`);
    txIdx++;
    sx += SZ + 8;
    if ((i + 1) % 4 === 0) { sx = 24; sy += SZ + 18; }
  }
  // Custom textentry + Apply button.
  layout.push(`{ text 24 ${sy + 8} 1153 ${txIdx} }`);
  texts.push('Custom hue:');
  txIdx++;
  layout.push(`{ textentry 110 ${sy + 8} 80 18 1152 1 ${txIdx} }`);
  texts.push('');
  txIdx++;
  layout.push(`{ button 200 ${sy + 8} 4023 4024 1 0 200 }`);
  layout.push(`{ text 232 ${sy + 8} 1153 ${txIdx} }`);
  texts.push('Apply');
  txIdx++;
  // Wave 37: Preview button — broadcasts a sample overhead at the
  // textentry's hue (or last picked swatch) WITHOUT touching
  // _tourEchoHue. Lets the GM trial-fit a hue before committing.
  layout.push(`{ button 200 ${sy + 32} 4011 4012 1 0 201 }`);
  layout.push(`{ text 232 ${sy + 32} 1153 ${txIdx} }`);
  texts.push('Preview');
  txIdx++;
  // Save-as-default checkbox (button toggle for now).
  layout.push(`{ checkbox 24 ${H - 30} 210 211 0 9 }`);
  layout.push(`{ text 48 ${H - 30} 1153 ${txIdx} }`);
  texts.push('Save as default');
  txIdx++;
  // Close.
  layout.push(`{ button ${W - 60} ${H - 30} 4020 4021 1 0 0 }`);
  layout.push(`{ text ${W - 30} ${H - 30} 1153 ${txIdx} }`);
  texts.push('OK');

  api.gumps.send(ctx.state, {
    gumpId: 0xEC0EC036, x: 100, y: 80,
    layout: layout.join(''), texts,
  }, (resp) => {
    const btnId = resp?.buttonId | 0;
    if (btnId === 0) return;
    // Wave 37: shared preview broadcaster — overhead "Echo preview…"
    // in the supplied hue, 12-tile radius like normal tour echo. Lets
    // the GM trial-fit hues without committing _tourEchoHue.
    const world = ctx.state.ctx?.world ?? api.world;
    const broadcastPreview = (hue) => {
      if (!api.protocol?.unicodeMessage) return;
      const pkt = api.protocol.unicodeMessage({
        serial: mob.serial, graphic: mob.body, type: 0,
        hue, font: 3, language: 'ENU',
        name: mob.name, text: 'Echo preview…',
      });
      for (const m of allMobiles({ world })) {
        if (!m.client || m.map !== mob.map) continue;
        if (Math.abs(m.x - mob.x) > 12 || Math.abs(m.y - mob.y) > 12) continue;
        m.client.send(pkt);
      }
    };
    // Wave 37: Preview-only path — read textentry, broadcast sample,
    // do NOT commit _tourEchoHue. Re-opens the gump so the GM can
    // pick again with the preview as visual feedback.
    if (btnId === 201) {
      const entry = resp?.textEntries?.find?.((e) => e.entryId === 1)?.text ?? '';
      const v = /^0x/i.test(entry) ? parseInt(entry, 16) : parseInt(entry, 10);
      if (!Number.isFinite(v) || v < 0 || v > 0xFFFF) {
        ctx.state.sendSystemMessage('Preview hue must be 0..0xFFFF.');
        return;
      }
      broadcastPreview(v);
      ctx.state.sendSystemMessage(`Previewed 0x${v.toString(16).toUpperCase()} — pick again to commit.`);
      openEchoHueGump(api, ctx, mob);
      return;
    }
    let pickedHue = null;
    if (btnId >= 100 && btnId < 100 + HUES.length) {
      pickedHue = HUES[btnId - 100];
    } else if (btnId === 200) {
      const entry = resp?.textEntries?.find?.((e) => e.entryId === 1)?.text ?? '';
      const v = /^0x/i.test(entry) ? parseInt(entry, 16) : parseInt(entry, 10);
      if (!Number.isFinite(v) || v < 0 || v > 0xFFFF) {
        ctx.state.sendSystemMessage('Custom hue must be 0..0xFFFF.');
        return;
      }
      pickedHue = v;
    }
    if (pickedHue == null) return;
    const saveDefault = (resp.switches ?? []).includes(9);
    if (pickedHue === 0) {
      delete mob._tourEchoHue;
      if (saveDefault) delete mob._tourEchoHueDefault;
    } else {
      mob._tourEchoHue = pickedHue;
      if (saveDefault) mob._tourEchoHueDefault = pickedHue;
      // Wave 37: visible-feedback preview at commit so the GM sees
      // exactly what the picked hue looks like in-world. Skipped on
      // hue=0 (clear path — nothing to render).
      broadcastPreview(pickedHue);
    }
    ctx.state.sendSystemMessage(
      `Echo hue → 0x${pickedHue.toString(16).toUpperCase()}${saveDefault ? ' (default saved)' : ''}.`,
    );
  });
}
