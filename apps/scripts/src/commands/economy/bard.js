import { destroyItemBySerial } from '../../_items.js';
import { mobileBySerial } from '../../_entities.js';
import { packItems } from '../../_inventory.js';
// [bard discord|provoke|peace — bard skill commands. Mirror ServUO
// in-game behaviour (target prompt + music check + effect on success).

export default function register(api) {
  if (!api.commands || !api.systems?.bardSkills) {
    api.log?.('cmd/bard: missing api.systems.bardSkills; skipping');
    return () => {};
  }
  const BS = api.systems.bardSkills;
  const registered = [];

  // Find the first instrument-class item in the player's pack.
  function findInstrument(mob) {
    if (!mob) return null;
    for (const it of packItems(api, mob)) {
      if (it.kind === 'instrument' || (it.itemId >= 0x0E9C && it.itemId <= 0x0EB3)) return it;
    }
    return null;
  }

  function runBard(ctx, args) {
    const sub = (args?.[0] ?? '').toLowerCase();
    const sender = ctx.sender;
    const inst = findInstrument(sender);
    if (!inst) { ctx.state.sendSystemMessage('You need an instrument in your pack.'); return; }
    bardSwitch(ctx, sub, args, sender, inst);
  }

  function playInstrument(ctx) {
    const sender = ctx.sender;
    const inst = findInstrument(sender);
    if (!inst) {
      ctx.state.sendSystemMessage('You need an instrument in your pack.');
      return;
    }
    const ok = BS.musicCheck?.(sender, inst) ?? true;
    consumeInstrument(inst);
    ctx.state.sendSystemMessage(ok ? 'You play a tune.' : 'You play poorly.');
    api.skillGain?.tryGain?.(sender, 30, 50);
  }
  // Audit #31 P2 #9 — ServUO `BaseInstrument.ConsumeUse` decrements
  // `UsesRemaining` on every successful Discord/Provoke/Peace; when it
  // hits 1 the instrument is destroyed. Was: free infinite play with a
  // single wooden lute. Wrap any successful bard call.
  function consumeInstrument(inst) {
    if (!inst) return;
    inst.usesRemaining = (inst.usesRemaining ?? 10) - 1;
    if (inst.usesRemaining <= 0) {
      try { destroyItemBySerial(api, inst.serial); }
      catch { /* may already be gone */ }
    } else {
      try { api.items?.invalidateProps?.(inst.serial); } catch { /* advisory */ }
    }
  }
  function bardSwitch(ctx, sub, args, sender, inst) {
    switch (sub) {
        case 'discord':
        case 'discordance': {
          if (!api.targeting) { ctx.state.sendSystemMessage('Targeting unavailable.'); return; }
          ctx.state.sendSystemMessage('Discord which target?');
          api.targeting.request(ctx.state, (picked) => {
            const target = mobileBySerial(api, picked?.serial);
            if (!target) { ctx.state.sendSystemMessage('Bad target.'); return; }
            const r = BS.applyDiscordance(api.world, sender, target, inst);
            if (!r.ok) { ctx.state.sendSystemMessage(`Discord failed: ${r.reason}`); return; }
            consumeInstrument(inst);
            ctx.state.sendSystemMessage(`${target.name ?? 'creature'} loses heart at the discordant melody.`);
          }, { kind: 0 });
          return;
        }
        case 'provoke':
        case 'provocation': {
          if (!api.targeting) return;
          ctx.state.sendSystemMessage('Provoke whom?');
          api.targeting.request(ctx.state, (picked1) => {
            const a = mobileBySerial(api, picked1?.serial);
            if (!a) { ctx.state.sendSystemMessage('Bad first target.'); return; }
            ctx.state.sendSystemMessage('And against whom?');
            api.targeting.request(ctx.state, (picked2) => {
              const b = mobileBySerial(api, picked2?.serial);
              if (!b) { ctx.state.sendSystemMessage('Bad second target.'); return; }
              const r = BS.applyProvocation(api.world, sender, a, b, inst);
              if (!r.ok) { ctx.state.sendSystemMessage(`Provoke failed: ${r.reason}`); return; }
              consumeInstrument(inst);
              ctx.state.sendSystemMessage(`${a.name ?? 'creature'} attacks ${b.name ?? 'creature'}!`);
            }, { kind: 0 });
          }, { kind: 0 });
          return;
        }
        case 'peace':
        case 'peacemaking': {
          if ((args[1] ?? '').toLowerCase() === 'target') {
            if (!api.targeting) return;
            ctx.state.sendSystemMessage('Calm which target?');
            api.targeting.request(ctx.state, (picked) => {
              const target = mobileBySerial(api, picked?.serial);
              if (!target) return;
              const r = BS.applyPeacemaking(api.world, sender, inst, { target });
              if (r.ok) consumeInstrument(inst);
              ctx.state.sendSystemMessage(r.ok ? `Calmed ${target.name ?? 'creature'}.` : `Peace failed: ${r.reason}`);
            }, { kind: 0 });
            return;
          }
          const r = BS.applyPeacemaking(api.world, sender, inst);
          if (r.ok) consumeInstrument(inst);
          ctx.state.sendSystemMessage(r.ok ? `Soothed ${r.calmed} creature(s) nearby.` : `Peace failed: ${r.reason}`);
          return;
        }
        default:
          ctx.state.sendSystemMessage('Usage: [bard <discord|provoke|peace [target]>');
      }
  }
  // Aliases — register thin wrappers so action-bar drag works.
  for (const sub of ['discord', 'provoke', 'peace']) {
    api.commands.register({
      name: sub,
      help: `[${sub} — bard skill (alias for [bard ${sub}).`,
      access: 'Player',
      run(ctx, args) { runBard(ctx, [sub, ...(args ?? [])]); },
    });
    registered.push(sub);
  }

  api.commands.register({
    name: 'bard',
    help: '[bard <discord|provoke|peace> — bard skill action.',
    access: 'Player',
    run(ctx, args) {
      runBard(ctx, args);
    },
  });
  registered.push('bard');

  api.commands.register({
    name: 'playinstrument',
    help: '[playinstrument — use Musicianship with a carried instrument.',
    access: 'Player',
    run(ctx) { playInstrument(ctx); },
  });
  registered.push('playinstrument');

  return () => {
    for (const name of registered) api.commands.unregister(name);
  };
}
