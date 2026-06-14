// Hair Stylist NPC — port of ServUO `HairStylist.cs`.
//
// Vendor NPC who changes the player's hair / beard style and hue for a
// flat 3000 gp fee. Listens for keywords ("haircut", "beard", "shave",
// "dye", "color") and applies a random style or hue from the canonical
// UO palette. The actual avatar slot is just a worn item on layer 11
// (hair) / layer 16 (facial hair) — we delete the old item and create
// a new one so the next paperdoll/login refresh picks it up.

import { spawnNPC } from './_spawn.js';
import { equipped, findBackpack, packItems } from '../../_inventory.js';
import { createItem, destroyItemBySerial } from '../../_items.js';

const HEAR_RANGE = 4;
const COST_GOLD = 3000;
const STYLIST_BODY = 0x0191; // female human (UO stylists are women)

const HAIR_STYLES = [
  0x203B, 0x203C, 0x203D, 0x2044, 0x2045, 0x2046, 0x2047,
  0x2048, 0x2049, 0x204A, 0x204B,
];
const BEARD_STYLES = [
  0x203E, 0x203F, 0x2040, 0x2041, 0x2042, 0x2043, 0x204C,
];

// Hair hue palette — ServUO `HairHuePicker.cs` defaults. Brown / blond
// / red / grey range with a few accent hues for the dye option.
const HAIR_HUES = [
  0x044E, 0x044F, 0x0450, 0x0451, 0x0452,   // browns
  0x0453, 0x0454, 0x0455,                   // blonds
  0x044D, 0x0457, 0x0458,                   // reds
  0x0386, 0x0387, 0x0388, 0x0389,           // greys
  0x048D, 0x0490, 0x0497, 0x04A0,           // accents
];

function distance(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function packGoldTotal(api, mob) {
  let total = 0;
  for (const it of packItems(api, mob)) {
    if (it.itemId === 0x0EED) total += (it.amount ?? 1);
  }
  return total;
}

function consumeGold(api, mob, amount) {
  let left = amount;
  const piles = [];
  for (const it of packItems(api, mob)) {
    if (it.itemId !== 0x0EED) continue;
    piles.push(it);
  }
  for (const pile of piles) {
    if (left <= 0) break;
    const have = pile.amount ?? 1;
    if (have <= left) {
      left -= have;
      destroyItemBySerial(api, pile.serial);
    } else {
      pile.amount = have - left;
      try { api.broadcast?.itemUpdate?.(api.world, pile); } catch { /* advisory */ }
      left = 0;
    }
  }
  return amount - left;
}

/** Find + destroy the currently worn hair / beard item on the given layer. */
function removeWornOnLayer(api, mob, layer) {
  for (const it of equipped(api, mob)) {
    if (it.layer === layer) {
      destroyItemBySerial(api, it.serial);
      return true;
    }
  }
  return false;
}

function setHair(api, mob, itemId, hue) {
  removeWornOnLayer(api, mob, 11);
  if (itemId) {
    createItem(api, api.world, {
      itemId, hue: hue ?? 0,
      x: mob.x, y: mob.y, z: mob.z, map: mob.map,
      parent: mob.serial, layer: 11,
    });
  }
}

function setBeard(api, mob, itemId, hue) {
  removeWornOnLayer(api, mob, 16);
  if (itemId) {
    createItem(api, api.world, {
      itemId, hue: hue ?? 0,
      x: mob.x, y: mob.y, z: mob.z, map: mob.map,
      parent: mob.serial, layer: 16,
    });
  }
}

function broadcastPaperdoll(api, mob) {
  // Re-broadcast 0x78 (mobile incoming) to nearby clients so the new
  // hair item appears on the paperdoll/world without a relog. The
  // simplest path: nudge the renderer via an existing broadcast helper
  // when available. Fallback: rely on next refreshSurroundings.
  api.ctx?.broadcastMobile?.(mob);
  api.ctx?.refreshSurroundings?.(mob);
}

export default function register(api) {
  if (!api.commands || !api.protocol) return () => {};

  api.ai?.registerBehavior?.({
    name: 'hair-stylist',
    initState() { return { lastService: 0 }; },
    tick(ctx, mob, state) {
      const queue = mob._heardSpeech;
      if (!queue || queue.length === 0) return;
      const now = ctx.now;
      while (queue.length > 0) {
        const entry = queue.shift();
        if (!entry?.text || !entry.speaker) continue;
        if (entry.speaker.map !== mob.map) continue;
        if (distance(entry.speaker, mob) > HEAR_RANGE) continue;
        if (now - state.lastService < 1_500) continue;
        const text = String(entry.text).toLowerCase();

        let action = null;
        if (text.includes('haircut') || /\bhair style\b/.test(text)) action = 'hair';
        else if (text.includes('shave')) action = 'shave';
        else if (text.includes('beard')) action = 'beard';
        else if (text.includes('dye') || text.includes('color') || text.includes('colour')) action = 'dye';

        if (!action) {
          if (text.includes('stylist') || text.includes('hair')) {
            ctx.broadcastSpeech?.(mob,
              `I can give you a haircut, a new beard, or dye your hair for ${COST_GOLD} gold. Say "haircut", "beard", "shave" or "dye".`, 0x35);
          }
          continue;
        }

        const speaker = entry.speaker;
        if (speaker.body !== 0x0190 && speaker.body !== 0x0191
            && speaker.body !== 0x025D && speaker.body !== 0x025E) {
          ctx.broadcastSpeech?.(mob, 'I can only style human hair.', 0x35);
          continue;
        }

        const isFemale = speaker.body === 0x0191 || speaker.body === 0x025E;
        if ((action === 'beard' || action === 'shave') && isFemale) {
          ctx.broadcastSpeech?.(mob, 'You have no beard to style!', 0x35);
          continue;
        }

        const pack = findBackpack(api, speaker);
        if (!pack) {
          ctx.broadcastSpeech?.(mob, 'You need a backpack first.', 0x35);
          continue;
        }
        if (packGoldTotal(api, speaker) < COST_GOLD) {
          ctx.broadcastSpeech?.(mob,
            `That will cost ${COST_GOLD} gold, which you cannot afford.`, 0x35);
          continue;
        }
        consumeGold(api, speaker, COST_GOLD);
        state.lastService = now;

        switch (action) {
          case 'hair': {
            const newId = pickRandom(HAIR_STYLES);
            let oldHue = 0x044E;
            for (const it of equipped(api, speaker)) {
              if (it?.layer === 11) { oldHue = it.hue ?? oldHue; break; }
            }
            setHair(api, speaker, newId, oldHue);
            ctx.broadcastSpeech?.(mob, 'A fresh new style — much better!', 0x35);
            break;
          }
          case 'beard': {
            const newId = pickRandom(BEARD_STYLES);
            setBeard(api, speaker, newId, 0x044E);
            ctx.broadcastSpeech?.(mob, 'A handsome beard for you!', 0x35);
            break;
          }
          case 'shave': {
            setBeard(api, speaker, 0, 0);
            ctx.broadcastSpeech?.(mob, 'Clean-shaven, as you wish.', 0x35);
            break;
          }
          case 'dye': {
            const newHue = pickRandom(HAIR_HUES);
            let hairItem = null;
            for (const it of equipped(api, speaker)) {
              if (it?.layer === 11) { hairItem = it; break; }
            }
            if (hairItem) {
              setHair(api, speaker, hairItem.itemId, newHue);
            }
            ctx.broadcastSpeech?.(mob, 'Your hair shines with a new colour.', 0x35);
            break;
          }
          default: break;
        }
        broadcastPaperdoll(api, speaker);
        speaker.client?.sendSystemMessage?.(`The stylist takes ${COST_GOLD} gold.`);
      }
    },
  });

  api.commands.register({
    name: 'stylist',
    help: '[stylist — admin: spawn a hair stylist NPC at your feet.',
    access: 'Admin',
    run(ctx) {
      const mob = spawnNPC(api, ctx.sender, {
        name: 'Hair Stylist', body: STYLIST_BODY, hue: 0x83EA,
        kind: 'hair-stylist', outfit: 'noble',
        keywords: ['hair', 'stylist', 'haircut', 'beard', 'shave', 'dye'],
        behavior: 'hair-stylist',
      });
      ctx.state.sendSystemMessage(`Hair stylist 0x${mob.serial.toString(16)} spawned at your feet.`);
    },
  });

  return () => {
    api.ai?.unregisterBehavior?.('hair-stylist');
    api.commands.unregister('stylist');
  };
}

export const HAIR_STYLIST_CONST = Object.freeze({
  COST_GOLD, HAIR_STYLES, BEARD_STYLES, HAIR_HUES,
});
