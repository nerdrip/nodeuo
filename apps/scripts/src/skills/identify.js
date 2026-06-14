import { resolveItemArg } from '../commands/_targeting-helpers.js';
import { normalizeSkillValue } from '../_rules.js';
import { isInPack } from '../_inventory.js';
import { nearbyClients } from '../_spatial.js';

// `[identify` — reveal magic-item properties via ItemIdentification
// skill (id 4). Targets an item in the player's pack OR an adjacent
// world item. ServUO `Skills/ItemID.cs` ranges from 0..100 with a
// stat-based difficulty per item; we keep it simpler:
//
//   skill 0..29   → 25% chance to identify
//   skill 30..69  → 60% chance
//   skill 70..100 → 95% chance
//
// On success: `_unidentified = false`, full prop list is broadcast
// via the OPL nudge so the client refreshes its tooltip cache.
// On failure: nothing changes; player can retry after a 5s cooldown
// (ServUO uses skill action delay; we approximate with cooldown).

const SKILL_ITEM_IDENTIFICATION = 4;
const COOLDOWN_MS = 5_000;

function effectiveSkill(mob) {
  const raw = mob.skills?.[SKILL_ITEM_IDENTIFICATION] ?? mob.skills?.[String(SKILL_ITEM_IDENTIFICATION)] ?? 0;
  return normalizeSkillValue(raw);
}

function rollSuccess(skill, rng = Math.random) {
  if (skill < 30) return rng() < 0.25;
  if (skill < 70) return rng() < 0.60;
  return rng() < 0.95;
}

export default function (api) {
  const { commands } = api;
  if (!commands) return () => {};
  const cooldowns = new Map();   // playerSerial → next-allowed-at

  commands.register({
    name: 'identify',
    help: '[identify [serial] — reveal a magic item with ItemID skill. No serial → cursor target.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      if (!mob) return;
      // Wave 34: cursor target fallback when called without args.
      resolveItemArg(api, ctx, 0, (item) => {
        if (!item) return;
      // Range gate: item must be in the player's pack OR within 2 tiles.
      const inPack = isInPack(api, item, mob);
      const adjacent = item.parent == null
        && Math.abs((item.x ?? 0) - mob.x) <= 2
        && Math.abs((item.y ?? 0) - mob.y) <= 2;
      if (!inPack && !adjacent) {
        ctx.state.sendSystemMessage('You must hold the item or stand next to it.');
        return;
      }
      // Already-identified items short-circuit.
      if (!item._unidentified) {
        ctx.state.sendSystemMessage(`${item.name ?? 'That item'} carries no further mysteries.`);
        return;
      }
      // Cooldown.
      const now = Date.now();
      const cd = cooldowns.get(mob.serial) ?? 0;
      if (now < cd) {
        ctx.state.sendSystemMessage(`Concentrate. Wait ${Math.ceil((cd - now)/1000)}s.`);
        return;
      }
      cooldowns.set(mob.serial, now + COOLDOWN_MS);

      const skill = effectiveSkill(mob);
      if (!rollSuccess(skill)) {
        ctx.state.sendSystemMessage('You cannot decipher its magic. Try again later.');
        return;
      }
      item._unidentified = false;
      // Skill use → small gain pulse if available.
      api.skillGain?.tick?.(mob, SKILL_ITEM_IDENTIFICATION);
      // Push a fresh OPL — the cache hash differs from prior because
      // the entry list changed (props are now visible). The properties
      // facade's `nudge()` sends a 0xDC OPLInfo with the new hash, the
      // client invalidates its cache and re-queries.
      const provider = ctx.state?.ctx?.propertyProvider;
      if (provider && api.properties?.nudge && api.properties?.computeHash) {
        const r = provider(item.serial, ctx.state);
        if (r?.entries) {
          const hash = api.properties.computeHash(r.entries);
          // Broadcast nudge to nearby clients so everyone re-queries.
          const center = item.parent ? mob : item;
          const observers = nearbyClients(api, center, null, 18);
          for (const m of observers) {
            if (!m.client) continue;
            api.properties.nudge(m.client, item.serial, hash);
          }
        }
      }
      ctx.state.sendSystemMessage(
        `You identify the item! ${item.name ?? 'It'} reveals its properties.`,
      );
      });   // close resolveItemArg cb
    },
  });

  return () => commands.unregister('identify');
}
