// `[kill` / `[invul` — target-driven GM helpers.
//
//   [kill   — opens a target cursor; the picked mobile is killed via
//             the canonical `corpse.killMobile` path (drops a corpse,
//             awards no fame/karma to caster, fires the death anim).
//             Player targets work for testing but trigger the normal
//             death pipeline including murder counts — be careful.
//
//   [invul  — toggle the `invulnerable` flag on yourself. Mobs with
//             this flag take zero damage in `combat.damage` (see
//             `apps/server/src/combat-formulas.js` damage gate).
//             Re-cast to disable.
//
// Use `[res` (existing in commands/resurrect.js) to come back from a
// ghost — `[res` with no arg resurrects the caster.

import { broadcastEffect, broadcastSound, aura } from '../../spells/_helpers.js';
import { mobileBySerial } from '../../_entities.js';

export default function register(api) {
  if (!api.commands) return () => {};

  // ---- [kill --------------------------------------------------------------
  if (api.targeting && api.corpse?.killMobile) {
    api.commands.register({
      name: 'kill',
      help: '[kill — target a mobile to kill it via the canonical death path.',
      access: 'GM',
      run(ctx) {
        const state = ctx.state;
        const sender = ctx.sender;
        if (!state || !sender) return;
        state.sendSystemMessage('Target the creature to kill.');
        api.targeting.request(state, (picked) => {
          if (!picked?.serial) return;
          const target = mobileBySerial(api, picked.serial >>> 0);
          if (!target) {
            state.sendSystemMessage('That is not a creature.');
            return;
          }
          if (target.serial === sender.serial) {
            // ServUO refuses self-kill via [kill — admins use [die. Keep
            // the same guard so an admin doesn't fat-finger their own
            // ghosting.
            state.sendSystemMessage('Use [die to drop your own body.');
            return;
          }
          if (target.invulnerable) {
            state.sendSystemMessage(`${target.name ?? 'That'} is invulnerable.`);
            return;
          }
          target.hp = 0;
          api.corpse.killMobile(api.world, target, sender);
          state.sendSystemMessage(`Killed ${target.name ?? '0x' + target.serial.toString(16)}.`);
        });
      },
    });

    // ServUO alias.
    api.commands.register({
      name: 'die',
      help: '[die — drop your own body (admin testing).',
      access: 'GM',
      run(ctx) {
        const sender = ctx.sender;
        if (!sender) return;
        sender.hp = 0;
        api.corpse.killMobile(api.world, sender, sender);
        ctx.state?.sendSystemMessage?.('You have dropped your body.');
      },
    });
  }

  // ---- [invul -------------------------------------------------------------
  api.commands.register({
    name: 'invul',
    help: '[invul — toggle invulnerability on yourself.',
    access: 'GM',
    run(ctx) {
      const sender = ctx.sender;
      if (!sender) return;
      sender.invulnerable = !sender.invulnerable;
      // Visual cue — `aura` returns a hue-tinted self-effect, then we
      // re-broadcast the mob so observers see the highlight. The
      // `combat.damage` gate already short-circuits on invulnerable=true
      // (see steal.js:78 reader pattern).
      if (api.protocol?.huedEffect) {
        try {
          const fx = aura(api, sender, {
            itemId: 0x376A,
            hue: sender.invulnerable ? 0x47E : 0x21,     // gold on, red off
            duration: 20,
          });
          broadcastEffect(api, api.world, sender, fx);
        } catch { /* effect optional */ }
      }
      try { broadcastSound(api, api.world, sender, 0x0214); }
      catch { /* sound optional */ }
      ctx.state?.sendSystemMessage?.(
        sender.invulnerable
          ? 'Invulnerability ON — incoming damage refused.'
          : 'Invulnerability OFF.',
      );
    },
  });

  // ServUO alias — same toggle.
  api.commands.register({
    name: 'god',
    help: '[god — alias of [invul.',
    access: 'GM',
    run(ctx, args) {
      // Optional explicit on/off ("god on" / "god off") so a macro can
      // set state deterministically. With no arg, just toggles.
      const sender = ctx.sender;
      if (!sender) return;
      const arg = (args?.[0] ?? '').toLowerCase();
      if (arg === 'on')       sender.invulnerable = true;
      else if (arg === 'off') sender.invulnerable = false;
      else                    sender.invulnerable = !sender.invulnerable;
      ctx.state?.sendSystemMessage?.(
        sender.invulnerable ? 'Godmode ON.' : 'Godmode OFF.',
      );
    },
  });

  return () => {
    api.commands.unregister('kill');
    api.commands.unregister('die');
    api.commands.unregister('invul');
    api.commands.unregister('god');
  };
}
