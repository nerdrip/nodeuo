// [runebook — full Runebook UI driven by chat. Mirrors the actions the
// ServUO RunebookGump exposes (mark slot, set default, rename, recall,
// gate, sacred journey, drop rune, recharge).
//
// A future client gump can replay these verbs over WS so the player
// gets the visual book; for now the chat command is the canonical
// interface.

import { normalizeSkillValue } from '../../_rules.js';
import { packItems } from '../../_inventory.js';
import { moveMobile } from '../../_movement.js';
import { nearbyClients } from '../../_spatial.js';
import { destroyItemBySerial } from '../../_items.js';

const RUNEBOOK_ITEM_ID = 0x22C5;        // ServUO Runebook art id
const ATLAS_ITEM_ID    = 0x9C16;        // Runic Atlas art id
const RECALL_FX_ID     = 0x3728;
const _RECALL_SOUND_ID = 0x1FC;   // wired when a sound packet is added later

function* clientsNear(api, center, range = 18, self = null) {
  yield* nearbyClients(api, center, self, range);
}

function* packDescendants(api, mob) {
  yield* packItems(api, mob);
}

function destroyWorldItem(api, item) {
  if (!item) return;
  destroyItemBySerial(api, item.serial);
}

export default function register(api) {
  if (!api.commands || !api.world || !api.systems?.runebook) {
    api.log?.('cmd/runebook: missing api deps; skipping');
    return () => {};
  }
  const RB = api.systems.runebook;

  // Helper: locate the player's runebook (first item with runebook
  // payload in their pack).
  function findBook(player) {
    if (!player) return null;
    for (const it of packDescendants(api, player)) {
      if (it.runebook) return it;
    }
    return null;
  }

  api.commands.register({
    name: 'runebook',
    help: '[runebook list|mark <idx>|default <idx>|recall [idx]|gate [idx]|drop <idx>|recharge|new|atlas',
    access: 'Player',
    run(ctx, args) {
      const sub = (args?.[0] ?? '').toLowerCase();
      const sender = ctx.sender;
      if (!sender) return;

      // [runebook new — spawn a fresh empty book in pack
      if (sub === 'new' || sub === 'atlas') {
        const isAtlas = sub === 'atlas';
        const book = api.game?.mobile?.giveItem?.(sender, {
          itemId: isAtlas ? ATLAS_ITEM_ID : RUNEBOOK_ITEM_ID,
          name: isAtlas ? 'a runic atlas' : 'a runebook',
        }, { randomGrid: true });
        if (!book) {
          ctx.state.sendSystemMessage('You have no backpack for the runebook.');
          return;
        }
        RB.initRunebook(book, { atlas: isAtlas });
        ctx.state.sendSystemMessage(`Created ${isAtlas ? 'a runic atlas' : 'a runebook'}.`);
        return;
      }

      const book = findBook(sender);
      if (!book) {
        ctx.state.sendSystemMessage('You need a runebook in your pack. Try [runebook new');
        return;
      }
      const snap = RB.snapshot(book);

      switch (sub) {
        case 'list':
        case '': {
          ctx.state.sendSystemMessage(`Runebook (${snap.chargesLeft}/${snap.chargesMax} charges) — ${snap.atlas ? 'atlas' : 'book'}:`);
          for (let i = 0; i < snap.slots.length; i++) {
            const s = snap.slots[i];
            const def = i === snap.defaultIndex ? '★' : ' ';
            if (!s) ctx.state.sendSystemMessage(`  ${def} [${i + 1}] (empty)`);
            else    ctx.state.sendSystemMessage(`  ${def} [${i + 1}] ${s.name} — (${s.x},${s.y},${s.z})`);
          }
          return;
        }
        case 'mark': {
          // [runebook mark <idx>  — overwrite a slot with current pos
          const idx = (parseInt(args[1], 10) || 0) - 1;
          if (RB.setSlot(book, idx, {
            name: `${sender.name}'s mark`,
            x: sender.x, y: sender.y, z: sender.z, map: sender.map,
          }) >= 0) {
            ctx.state.sendSystemMessage(`Slot ${idx + 1} marked at (${sender.x},${sender.y}).`);
          } else {
            ctx.state.sendSystemMessage('Bad slot index.');
          }
          return;
        }
        case 'default': {
          const idx = (parseInt(args[1], 10) || 0) - 1;
          if (RB.setDefault(book, idx)) ctx.state.sendSystemMessage(`Default set to slot ${idx + 1}.`);
          else                          ctx.state.sendSystemMessage('Bad slot or empty.');
          return;
        }
        case 'drop': {
          const idx = (parseInt(args[1], 10) || 0) - 1;
          if (RB.removeSlot(book, idx)) ctx.state.sendSystemMessage(`Slot ${idx + 1} cleared.`);
          else                           ctx.state.sendSystemMessage('Bad slot index.');
          return;
        }
        case 'recall':
        case 'gate':
        case 'sj': {
          const mode = sub === 'gate' ? 'gate' : sub === 'sj' ? 'sacred-journey' : 'recall';
          const idx = (parseInt(args[1], 10) || 0) - 1;
          // Server parity #10 #9 — full spell gate before book.recall().
          // Was: only consumed a book charge, no mana / skill / reagent
          // check. ServUO `Runebook.Recall()` calls a real
          // `RecallSpell.Cast()` with full Magery pipeline.
          const MANA = mode === 'gate' ? 20 : (mode === 'sacred-journey' ? 10 : 11);
          const SKILL = mode === 'sacred-journey'
            ? { id: 52, min: 15 }    // Chivalry 15.0
            : { id: 26, min: 50 };   // Magery 50.0
          const isStaff = sender.client?.account?.accessLevel === 'GM'
                       || sender.client?.account?.accessLevel === 'Admin';
          if (!isStaff) {
            const sk = normalizeSkillValue(
              sender.skills?.[SKILL.id] ?? sender.skills?.[String(SKILL.id)] ?? 0,
            );
            if (sk < SKILL.min) {
              ctx.state.sendSystemMessage(
                `You need ${SKILL.min.toFixed(1)} ${SKILL.id === 52 ? 'Chivalry' : 'Magery'}.`,
              );
              return;
            }
            if ((sender.mana ?? 0) < MANA) {
              ctx.state.sendSystemMessage(`You need ${MANA} mana.`);
              return;
            }
            sender.mana = Math.max(0, (sender.mana ?? 0) - MANA);
          }
          const r = RB.recall(book, sender, idx, mode);
          if (!r.ok) {
            ctx.state.sendSystemMessage(`Recall failed: ${r.reason}`);
            return;
          }
          // Emit FX + sound at source.
          try {
            const fx = api.protocol.huedEffect({
              kind: api.protocol.EffectKind?.FixedFrom ?? 0,
              from: sender.serial, to: 0,
              itemId: RECALL_FX_ID,
              fromX: sender.x, fromY: sender.y, fromZ: sender.z,
              toX: sender.x, toY: sender.y, toZ: sender.z,
              speed: 5, duration: 30, fixedDirection: 1, explodes: 0,
              hue: 0, renderMode: 0,
            });
            for (const o of clientsNear(api, sender, 18)) o.client.send(fx);
          } catch { /* ignore FX failure */ }

          const next = {
            x: r.dest.x,
            y: r.dest.y,
            z: r.dest.z,
            map: r.dest.map ?? sender.map,
          };
          if (!api.game?.mobile?.teleport?.(sender, next, { state: ctx.state, refresh: true })) {
            // Move the player.
            const preObservers = [...clientsNear(api, sender, 18, sender)];
            if (api.protocol?.removeEntity) {
              const rm = api.protocol.removeEntity(sender.serial);
              for (const o of preObservers) o.client.send(rm);
            }
            const prevMap = sender.map;
            moveMobile(api, sender, next);
            if (sender.client && sender.map !== prevMap && api.protocol?.extMapChange) {
              sender.client.send(api.protocol.extMapChange(sender.map));
            }
            ctx.state.send?.(api.protocol.mobileUpdate({
              serial: sender.serial, body: sender.body, x: sender.x, y: sender.y, z: sender.z,
              direction: sender.direction ?? 0, hue: sender.hue ?? 0, flags: sender.flags ?? 0,
            }));
            if (api.protocol?.mobileMoving) {
              const moving = api.protocol.mobileMoving({
                serial: sender.serial, body: sender.body, x: sender.x, y: sender.y, z: sender.z,
                direction: sender.direction ?? 0, hue: sender.hue ?? 0,
                flags: sender.flags ?? 0, notoriety: sender.notoriety ?? 1,
              });
              for (const o of clientsNear(api, sender, 18, sender)) o.client.send(moving);
            }
            try { ctx.state?.ctx?.handlers?.refreshSurroundings?.(ctx.state); }
            catch { /* helper missing in test setups */ }
          }
          ctx.state.sendSystemMessage(`You ${mode}ed to ${r.dest.name}.`);
          return;
        }
        case 'recharge': {
          // Audit #33 P2 #8 — ServUO `Runebook.OnDragDrop` consumes a
          // Recall Rune scroll (+1 charge) or Gate Travel scroll (+5).
          // Previously was a free +5 per call. We walk the player's
          // pack for the first matching scroll; consume one and add
          // the corresponding charges. Recall scroll item id 0x1F4C
          // is canonical; Gate Travel 0x1F60.
          let scroll = null;
          let perCharge = 0;
          for (const it of packDescendants(api, sender)) {
            if (it.itemId === 0x1F4C) { scroll = it; perCharge = 1; break; }
            if (it.itemId === 0x1F60) { scroll = it; perCharge = 5; break; }
          }
          if (!scroll) {
            ctx.state.sendSystemMessage('You need a Recall or Gate Travel scroll to recharge a runebook.');
            return;
          }
          const got = RB.recharge(book, perCharge);
          if (got > 0) {
            // Consume one scroll from the stack (or destroy when single).
            if ((scroll.amount ?? 1) > 1) {
              scroll.amount -= 1;
              if (sender.client && api.protocol?.containerContentUpdate) {
                sender.client.send(api.protocol.containerContentUpdate({
                  serial: scroll.serial, itemId: scroll.itemId, amount: scroll.amount,
                  hue: scroll.hue ?? 0, gridX: scroll.gridX ?? 0, gridY: scroll.gridY ?? 0,
                  gridLocation: scroll.gridLocation ?? 0,
                }, scroll.parent ?? sender.serial));
              }
            } else {
              destroyWorldItem(api, scroll);
              if (sender.client && api.protocol?.removeEntity) {
                sender.client.send(api.protocol.removeEntity(scroll.serial));
              }
            }
          }
          ctx.state.sendSystemMessage(`Recharged +${got}.`);
          return;
        }
        default:
          ctx.state.sendSystemMessage('Usage: [runebook list|mark <i>|default <i>|recall [i]|gate [i]|sj [i]|drop <i>|recharge|new|atlas');
      }
    },
  });
  return () => {};
}
