// Confidence — short-term self-buff: ticks HP back as long as the
// samurai isn't taking hits. Tagged via status-effects with onTick.
//
// BUGFIX #109 (FAZA FV): regen tick used to send healthUpdate only
// to the buffed mob's own client. Observers' overhead bars + party
// members' dragged-out status bars stayed on the pre-tick HP. Same
// class as #55/#75/#87. Use broadcastHealthUpdate.
import { aura, broadcastEffect, broadcastSound, broadcastHealthUpdate, skillValue } from '../_helpers.js';
export default {
  name: 'confidence', school: 'bushido', circle: 1, mana: 10,
  cast(api, ctx) {
    const m = ctx.sender;
    broadcastEffect(api, api.world, m, aura(api, m, { itemId: 0x37C4, hue: 0x47E }));
    broadcastSound(api, api.world, m, 0x028E);
    // Audit #42 P2 #14 — ServUO `Confidence.cs:178-196`:
    //   total_hp = 15 + (BushidoFixed² / 57600)
    //   duration = 15s
    //   per-tick = total / 5 for 5 ticks, then final burst (total - sum)
    // Was: flat 8s duration, +3 HP/tick (with `skill/250` always 0..0.48).
    // At GM 100 Bushido total = 15 + (1000² / 57600) ≈ 32 HP.
    // Also: stamina regen on successful parry is read by the combat
    // miss/parry branch through `_confidenceStamRegen`.
    const bushido = skillValue(m, 53);
    const bushidoFixed = bushido * 10;       // ServUO `Fixed` units (×10)
    const totalHp = 15 + Math.floor((bushidoFixed * bushidoFixed) / 57600);
    const perTick = Math.floor(totalHp / 5);
    let ticksDone = 0;
    m._confidenceStamRegen = true;     // combat-formulas parry hook reader
    api.statusEffects?.apply?.(m, {
      name: 'confidence', durationMs: 15_000, tickIntervalMs: 3_000,
      onTick(mob) {
        ticksDone++;
        // 5 ticks total at 3s each = 15s duration; the last tick gets
        // any remainder so the sum equals `totalHp`.
        const gain = (ticksDone >= 5)
          ? Math.max(0, totalHp - perTick * 4)
          : perTick;
        mob.hp = Math.min(mob.hpMax ?? 50, (mob.hp ?? 0) + gain);
        broadcastHealthUpdate(api, api.world, mob);
      },
      onRemove(mob) { mob._confidenceStamRegen = false; },
    });
  },
};
