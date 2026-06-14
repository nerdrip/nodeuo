// `[spiritspeak` — Spirit Speak skill (id 33).
//
// ServUO `Skills/SpiritSpeak.cs`: lets the caster understand ghost
// speech and slightly heals (mana → HP conversion at high skill).
// We surface it as a self-buff that ticks for ~30 s, plus a sparkle
// effect for visual feedback.

import { normalizeSkillValue } from '../_rules.js';
import { allItems, sendToClientsNear } from '../_spatial.js';
const SKILL_SPIRITSPEAK = 33;
const COOLDOWN_MS = 8000;
const cooldown = new WeakMap();

export default function register(api) {
  if (!api.commands || !api.statusEffects) return () => {};
  api.commands.register({
    name: 'spiritspeak',
    help: '[spiritspeak — open your senses to the dead.',
    access: 'Player',
    run(ctx) {
      const sender = ctx.sender;
      const now = Date.now();
      const last = cooldown.get(sender) ?? 0;
      if (now - last < COOLDOWN_MS) {
        ctx.state.sendSystemMessage('You are still in communion with spirits.');
        return;
      }
      const rawSkill = sender.skills?.[SKILL_SPIRITSPEAK] ?? sender.skills?.[String(SKILL_SPIRITSPEAK)] ?? 0;
      const skill = normalizeSkillValue(rawSkill);
      // Skill check — fail at low skill.
      if (Math.random() * 100 > skill) {
        ctx.state.sendSystemMessage('The spirits do not answer.');
        cooldown.set(sender, now);
        api.skillGain?.tryGain?.(sender, SKILL_SPIRITSPEAK, 40);
        return;
      }
      // Apply self-buff "spiritspeak" — ghost-speech becomes intelligible
      // for the duration. Content code that emits ghost-only chat reads
      // `.effects.includes('spiritspeak')` to decide visibility.
      api.statusEffects.apply(sender, {
        name: 'spiritspeak',
        durationMs: 30_000,
        tick: null,
      });
      sender._spiritSpeakUntil = now + 30_000;
      sender.servuoClasses = [...new Set([
        ...(sender.servuoClasses ?? []),
        'SpiritSpeakTimer',
        'SpiritSpeakTimerNew',
      ])];
      cooldown.set(sender, now);
      ctx.state.sendSystemMessage('You attune to the whispers of the dead.');

      // AOS corpse-channel heal — ServUO `SpiritSpeak.cs:148-238` scans
      // range≤3 for an unchanneled corpse. With a corpse the heal is
      // free; without one it costs 10 mana. Heal range scales with
      // skill: `1 + skill/4` .. `5 + skill/4`.
      const healLo = 1 + Math.floor(skill / 4);
      const healHi = healLo + 4;
      let usedCorpse = null;
      const sectors = api.world.sectors;
      const PROBE = 3;
      const scan = (probe) => {
        for (const it of probe) {
          if (!it || it.itemId !== 0x2006 || it._channeled) continue;
          if (Math.abs(it.x - sender.x) > PROBE || Math.abs(it.y - sender.y) > PROBE) continue;
          if (it.map !== sender.map) continue;
          return it;
        }
        return null;
      };
      if (sectors?.nearbyItems) {
        try { usedCorpse = scan(sectors.nearbyItems(sender, PROBE) ?? []); }
        catch { /* fall back to full scan below */ }
      }
      if (!usedCorpse) {
        const items = api.game?.itemsNear?.(sender, { range: PROBE })
          ?? api.query?.itemsNear?.(sender, PROBE)
          ?? allItems(api);
        for (const it of items) {
          if (it.itemId === 0x2006 && !it._channeled &&
              it.map === sender.map &&
              Math.abs(it.x - sender.x) <= PROBE &&
              Math.abs(it.y - sender.y) <= PROBE) {
            usedCorpse = it; break;
          }
        }
      }
      const heal = healLo + Math.floor(Math.random() * (healHi - healLo + 1));
      if (usedCorpse) {
        usedCorpse._channeled = true;
        usedCorpse.hue = 0x835;
        ctx.state.sendSystemMessage(`You draw life-force from the corpse and heal ${heal}.`);
      } else if ((sender.mana | 0) >= 10) {
        sender.mana -= 10;
        if (sender.client && api.protocol?.manaUpdate) {
          try {
            sender.client.send(api.protocol.manaUpdate({
              serial: sender.serial, current: sender.mana, max: sender.manaMax ?? 50,
            }));
          } catch { /* advisory */ }
        }
        ctx.state.sendSystemMessage(`You channel mana into life and heal ${heal}.`);
      } else {
        ctx.state.sendSystemMessage('You lack the mana to call on the dead.');
        return;
      }
      sender.hp = Math.min(sender.hpMax ?? 50, (sender.hp | 0) + heal);
      if (sender.client && api.protocol?.healthUpdate) {
        try {
          sender.client.send(api.protocol.healthUpdate({
            serial: sender.serial, current: sender.hp, max: sender.hpMax ?? 50,
          }));
        } catch { /* advisory */ }
      }
      // Visual effect — sparkle + cast animation.
      try {
        if (api.combat?.animate) api.combat.animate(api.world, sender, 0x10);
        if (api.protocol) {
          const fx = api.protocol.huedEffect({
            kind: api.protocol.EffectKind?.Stationary ?? 0,
            from: sender.serial, to: sender.serial,
            itemId: 0x373A,
            fromX: sender.x, fromY: sender.y, fromZ: sender.z,
            toX:   sender.x, toY:   sender.y, toZ:   sender.z,
            speed: 8, duration: 14, fixedDirection: 1, explodes: 0,
            hue: 0x4F, renderMode: 0,
          });
          sendToClientsNear(api, sender, fx);
        }
      } catch { /* fx is optional */ }
      api.skillGain?.tryGain?.(sender, SKILL_SPIRITSPEAK, 60);
    },
  });
  return () => api.commands.unregister('spiritspeak');
}
