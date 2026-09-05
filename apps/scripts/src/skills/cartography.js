// `[drawmap` — Cartography skill activity. Generates a treasure-map item
// with random world coordinates. Higher Cartography skill rolls maps
// of higher tier (level 1 to 5; ServUO uses 7 tiers).
//
// MVP: spawn a `treasure-map` item with `mapLevel` + `targetX/Y/Z` set.
// Actual treasure-map digging quest is PHASE AA part 2.

import { normalizeSkillValue } from '../_rules.js';
import { findInPack } from '../_inventory.js';
import { destroyItemBySerial } from '../_items.js';

const SKILL_CARTOGRAPHY = 13;
const COOLDOWN_MS = 5000;
const cooldown = new WeakMap();

export default function register(api) {
  if (!api.commands || !api.protocol || !api.game?.mobile?.giveItem) return () => {};

  api.commands.register({
    name: 'drawmap',
    help: '[drawmap — draw a treasure map (consumes a blank scroll).',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      const last = cooldown.get(mob) ?? 0;
      const now = Date.now();
      if (now - last < COOLDOWN_MS) {
        ctx.state.sendSystemMessage('Your hand still cramps from the last map.');
        return;
      }

      // BUGFIX #85 (PHASE DQ): the cooldown was set BEFORE the blank-
      // scroll check. Players running out of scrolls were locked out
      // of `[map` for 5 seconds without consuming anything — the
      // failure path took as long as a successful draw.
      // Consume a blank scroll from pack (item id 0x0E34).
      const scroll = findInPack(api, mob, (it) => it.itemId === 0x0E34 && (it.amount | 0) > 0);
      if (!scroll) {
        ctx.state.sendSystemMessage('You need a blank scroll.');
        return;
      }
      cooldown.set(mob, now);
      scroll.amount = (scroll.amount | 0) - 1;
      if (scroll.amount <= 0) {
        destroyItemBySerial(api, scroll.serial);
        if (mob.client) mob.client.send(api.protocol.removeEntity(scroll.serial));
      } else if (mob.client) {
        mob.client.send(api.protocol.containerContentUpdate({
          serial: scroll.serial, itemId: scroll.itemId, amount: scroll.amount,
          hue: scroll.hue ?? 0, gridX: 0, gridY: 0, gridLocation: 0,
        }, scroll.parent ?? mob.serial));
      }

      const skill = normalizeSkillValue(
        mob.skills?.[SKILL_CARTOGRAPHY] ?? mob.skills?.[String(SKILL_CARTOGRAPHY)] ?? 0,
      );
      const chance = Math.min(0.95, Math.max(0.10, skill / 100));
      if (Math.random() >= chance) {
        ctx.state.sendSystemMessage('Your map smudges into nonsense.');
        return;
      }
      // Tier 1..5 by skill.
      const level = 1 + Math.min(4, Math.floor(skill / 20));
      // Pick a random nearby tile (within 200 tiles) as the buried spot.
      const dx = Math.floor((Math.random() - 0.5) * 400);
      const dy = Math.floor((Math.random() - 0.5) * 400);
      const tx = Math.max(0, mob.x + dx);
      const ty = Math.max(0, mob.y + dy);
      const map = api.game?.mobile?.giveItem?.(mob, {
        itemId: 0x14EC,
        name: `treasure map (level ${level})`,
      }, { randomGrid: true });
      if (!map) {
        ctx.state.sendSystemMessage('You have no backpack for the map.');
        return;
      }
      map.treasureMap = { level, x: tx, y: ty, decoded: false };
      ctx.state.sendSystemMessage(`You sketch a level ${level} treasure map.`);
      api.skillGain?.tryGain?.(mob, SKILL_CARTOGRAPHY, 50 + level * 10);
    },
  });

  // PHASE DQ — `[decodemap` decodes a treasure map (or MIB from fishing)
  // in the player's pack. Decoding requires Cartography ≥ map.level × 20
  // (ServUO: `BaseMap.OnDoubleClickReady`). Once decoded, the digging
  // command (`[dig`) can pull treasure if the player is within range
  // of the marked spot.
  api.commands.register({
    name: 'decodemap',
    help: '[decodemap — decode the first encoded treasure map in your pack.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      const target = findInPack(api, mob, (it) => it.treasureMap && !it.treasureMap.decoded);
      if (!target) {
        ctx.state.sendSystemMessage('You have no encoded maps to decode.');
        return;
      }
      const skill = normalizeSkillValue(
        mob.skills?.[SKILL_CARTOGRAPHY] ?? mob.skills?.[String(SKILL_CARTOGRAPHY)] ?? 0,
      );
      const required = (target.treasureMap.level | 0) * 20;
      if (skill < required) {
        ctx.state.sendSystemMessage(
          `You need Cartography ${required} to decode a level ${target.treasureMap.level} map.`,
        );
        return;
      }
      target.treasureMap.decoded = true;
      const { x, y, level } = target.treasureMap;
      ctx.state.sendSystemMessage(
        `Decoded! Level ${level} treasure buried near (${x}, ${y}).`,
      );
      api.skillGain?.tryGain?.(mob, SKILL_CARTOGRAPHY, 50 + level * 10);
    },
  });

  return () => {
    api.commands.unregister('drawmap');
    api.commands.unregister('decodemap');
  };
}
