// `[snoop` — Snooping skill (id 29). ServUO Skills/Snooping.cs: pry
// open a target's backpack to peek at its contents without lifting
// anything. Skill check vs target's wisdom (Hiding+Stealth resist for
// players); on caught the target is notified. We mirror the contents
// fanout via 0x3C ContainerContents to the snooper only.

import { adjustKarma } from '../_notoriety.js';
import { normalizeSkillValue } from '../_rules.js';
import { mobileBySerial } from '../_entities.js';

const SKILL_SNOOPING = 29;
const COOLDOWN_MS = 5_000;
const cooldown = new WeakMap();

function readSkill(mob, id) {
  if (!mob?.skills) return 0;
  const raw = mob.skills[id] ?? mob.skills[String(id)] ?? 0;
  return normalizeSkillValue(raw);
}

export default function register(api) {
  if (!api.targeting || !api.world) return () => {};

  api.commands.register({
    name: 'snoop',
    help: '[snoop — peek at a target\'s backpack.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      const now = Date.now();
      const last = cooldown.get(mob) ?? 0;
      if (now - last < COOLDOWN_MS) {
        ctx.state.sendSystemMessage('You may not pry so quickly.');
        return;
      }
      ctx.state.sendSystemMessage('Snoop on whom?');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked?.serial) return;
        const target = mobileBySerial(api, picked.serial >>> 0);
        if (!target || target === mob) return;
        cooldown.set(mob, now);
        const snoop = readSkill(mob, SKILL_SNOOPING) || 50;
        // Resist: target's Detect Hidden (15). Players-only — NPCs are passive.
        const resist = target.client
          ? (readSkill(target, 15) || 25)
          : 0;
        // Audit #39 P3 #15 — ServUO `Snooping.cs:CheckSnoop` calls
        // `Misc.Titles.AwardKarma(from, -4, true)` before the roll —
        // peeking is a small chivalric infraction even if successful.
        adjustKarma(api, mob, -4);
        const success = (Math.random() * 100) < (snoop - resist * 0.4);
        if (!success) {
          ctx.state.sendSystemMessage('You are noticed prying!');
          if (target.client) target.client.sendSystemMessage?.(
            `${mob.name ?? 'Someone'} is trying to peek into your pack!`);
          api.skillGain?.tryGain?.(mob, SKILL_SNOOPING, 0.5);
          return;
        }
        // Open the target's backpack to the snooper. The container-
        // contents helper exists on the server's items module.
        const pack = target.equipment?.get?.(21);
        if (!pack) {
          ctx.state.sendSystemMessage('They carry no backpack.');
          return;
        }
        if (api.protocol?.displayContainer && api.protocol?.containerContents
            && api.items?.containerChildren && ctx.state.send) {
          ctx.state.send(api.protocol.displayContainer({
            serial: pack.serial >>> 0, gumpId: 0x003C,
          }));
          const contents = api.items.containerChildren(api.world, pack.serial)
            .map((it) => ({
              serial: it.serial, itemId: it.itemId,
              amount: it.amount ?? 1,
              x: it.gx ?? 0, y: it.gy ?? 0, hue: it.hue ?? 0,
            }));
          ctx.state.send(api.protocol.containerContents({
            containerSerial: pack.serial >>> 0, items: contents,
          }));
        }
        ctx.state.sendSystemMessage('You peek into the pack.');
        api.skillGain?.tryGain?.(mob, SKILL_SNOOPING, 1.0);
      });
    },
  });

  return () => api.commands.unregister('snoop');
}
