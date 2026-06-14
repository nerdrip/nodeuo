// `[invoke <virtue> [target]` — invoke one of the 8 virtue powers.
// Server parity #10: virtues system stamped value but had no active
// invocations. ServUO `Engines/MyRunUO/Virtues/*Virtue.cs` provides
// the canonical effect set; this command exposes them to players.
//
// Usage:
//   [invoke compassion          (Compassion: target a ghost → res)
//   [invoke honor               (Honor: next swing crits + reveal)
//   [invoke justice             (Justice: choose a protégé to share dmg with)
//   [invoke sacrifice           (Sacrifice: drop self to 1hp, full-res target)
//   [invoke valor               (Valor: spawn champion altar at feet)
//   [invoke spirituality        (Spirituality: mana regen 60s)
//   [invoke humility            (Humility: gargoyle form 60s)

import { resolveMobileArg } from '../_targeting-helpers.js';
import { mobileBySerial } from '../../_entities.js';

const ALIAS = {
  compassion: 'Compassion', honor: 'Honor', justice: 'Justice',
  sacrifice: 'Sacrifice', valor: 'Valor', spirituality: 'Spirituality',
  humility: 'Humility',
};

export default function (api) {
  if (!api.commands) return () => {};
  const virtues = api.systems?.virtues;
  if (!virtues) {
    api.log?.('invoke: virtues system unavailable');
    return () => {};
  }

  api.commands.register({
    name: 'invoke',
    help: '[invoke <virtue> [target] — call upon one of the eight virtues.',
    access: 'Player',
    run(ctx) {
      const a = (ctx.args ?? [])[0]?.toLowerCase?.();
      const key = ALIAS[a];
      if (!key) {
        ctx.state.sendSystemMessage(`Usage: [invoke <${Object.keys(ALIAS).join('|')}>`);
        return;
      }
      const cfg = virtues.VIRTUE_INVOCATION_TABLE?.[key];
      if (!cfg) {
        ctx.state.sendSystemMessage('That virtue cannot be invoked yet.');
        return;
      }
      // Compassion / Sacrifice / Justice need a target — open targeting.
      const needsTarget = (key === 'Compassion' || key === 'Sacrifice' || key === 'Justice');
      const finish = (target) => {
        const r = virtues.invokeVirtue(ctx.sender, key, target);
        if (!r.ok) {
          const msg = ({
            'low-virtue':       `You lack ${r.need} ${key} value (have ${ctx.sender.virtues?.[key] ?? 0}).`,
            'cooldown':         `${key} is recovering — try again later.`,
            'need-ghost-target':'Target a ghost.',
            'need-protege':     'Target a player to protect.',
            'unknown-virtue':   `Unknown virtue: ${key}.`,
            'unimplemented':    `${key} invocation is not yet implemented.`,
          })[r.reason] ?? `Failed (${r.reason}).`;
          ctx.state.sendSystemMessage(msg);
          return;
        }
        // Apply the world effect tag.
        switch (r.effect) {
          case 'res':
            if (target && api.corpse?.resurrectMobile) {
              try { api.corpse.resurrectMobile(api.world, target, ctx.sender); }
              catch { /* ignore */ }
              target.client?.sendSystemMessage?.(`You are resurrected by ${ctx.sender.name}.`);
            }
            ctx.state.sendSystemMessage(`Compassion flows through you — ${target?.name ?? 'they'} return to life.`);
            break;
          case 'embrace':
            ctx.state.sendSystemMessage('You embrace honor — your next strike will deal double damage.');
            break;
          case 'protect':
            ctx.state.sendSystemMessage(`You vow to protect ${target?.name ?? 'them'} for the next 10 minutes.`);
            target?.client?.sendSystemMessage?.(`${ctx.sender.name} has taken you under their protection.`);
            break;
          case 'valor-altar':
            ctx.state.sendSystemMessage('You summon a champion altar at your feet.');
            break;
          case 'mana-regen':
            ctx.state.sendSystemMessage('Spirituality grants you accelerated mana regeneration.');
            break;
          case 'gargoyle-form':
            ctx.state.sendSystemMessage('Humility transforms you into the form of a gargoyle.');
            break;
          default:
            ctx.state.sendSystemMessage(`${key} invoked.`);
        }
      };

      if (needsTarget) {
        ctx.state.sendSystemMessage(
          key === 'Justice' ? 'Whom do you wish to protect?' : 'Who shall receive your gift?',
        );
        if (api.targeting?.request) {
          api.targeting.request(ctx.state, (picked) => {
            if (!picked?.serial) return;
            const m = mobileBySerial(api, picked.serial >>> 0);
            if (!m) { ctx.state.sendSystemMessage('That is not a person.'); return; }
            finish(m);
          });
        } else {
          resolveMobileArg(api, ctx, 1, finish);
        }
      } else {
        finish(null);
      }
    },
  });

  return () => api.commands.unregister('invoke');
}
