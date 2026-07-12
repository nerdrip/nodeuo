// [sigils — Faction sigil status + town-control board.
//
//   [sigils                   → list all 5 sigils with current carrier + owner
//   [sigils pickup <town>     → attempt to lift the sigil at your tile
//   [sigils drop  <town>      → drop the sigil you're carrying
//   [sigils towns             → town control summary (which faction owns what)
//
// Mirrors the bottom-line of ServUO `Engines/Factions/Gumps/`
// (TownGump + SigilOptionsGump) collapsed to a chat surface.

export default function register(api) {
  if (!api.commands || !api.systems?.sigils) {
    api.log?.('cmd/sigils: missing api deps; skipping');
    return () => {};
  }
  const SG = api.systems.sigils;

  function fmtSigil(s, now) {
    const owner = s.owner ?? '(uncorrupted)';
    const carrier = s.carrier ? `0x${s.carrier.toString(16)}` : '(on pedestal)';
    const heldFor = s.carrier ? Math.round((now - s.pickedUpAt) / 1000) : 0;
    return `  • ${s.town.padEnd(10)} owner=${owner.padEnd(14)} carrier=${carrier} held=${heldFor}s`;
  }

  api.commands.register({
    name: 'sigils',
    aliases: ['sigil'],
    help: '[sigils [pickup|drop|towns] <town>',
    access: 'Player',
    run(ctx, args) {
      const sub = (args?.[0] ?? '').toLowerCase();
      const town = (args?.[1] ?? '').toLowerCase();
      const now = Date.now();
      const sender = ctx.sender;

      switch (sub) {
        case '':
        case 'list': {
          ctx.state.sendSystemMessage(`Faction sigils (corruption in ${(SG._SIGIL_CONST?.CORRUPTION_MS ?? 600_000) / 60000} min):`);
          for (const s of SG.listSigils()) ctx.state.sendSystemMessage(fmtSigil(s, now));
          return;
        }
        case 'pickup': {
          if (!town) { ctx.state.sendSystemMessage('Usage: [sigils pickup <town>'); return; }
          const r = SG.pickup(town, sender.serial >>> 0, now);
          if (!r.ok) { ctx.state.sendSystemMessage(`Pickup failed: ${r.reason}`); return; }
          // Drop notoriety to 4 (criminal) — mirrors ServUO sigil-carrier flag.
          sender._sigilCarrier = town;
          sender.notoriety = 4;
          ctx.state.sendSystemMessage(`You hoist the ${town} sigil. PvP is now legal everywhere.`);
          return;
        }
        case 'drop': {
          if (!town) { ctx.state.sendSystemMessage('Usage: [sigils drop <town>'); return; }
          const r = SG.drop(town, sender.serial >>> 0);
          if (!r.ok) { ctx.state.sendSystemMessage(`Drop failed: ${r.reason}`); return; }
          delete sender._sigilCarrier;
          sender.notoriety = sender._lastNotoriety ?? 1;
          ctx.state.sendSystemMessage(`You drop the ${town} sigil.`);
          return;
        }
        case 'towns': {
          ctx.state.sendSystemMessage('Town control:');
          const counts = { TrueBritannian: 0, CouncilOfMages: 0, Minax: 0, Shadowlords: 0, neutral: 0 };
          for (const s of SG.listSigils()) {
            const o = s.owner ?? 'neutral';
            counts[o] = (counts[o] | 0) + 1;
          }
          for (const [k, v] of Object.entries(counts)) {
            ctx.state.sendSystemMessage(`  ${k.padEnd(18)} ${v} town(s)`);
          }
          return;
        }
        default:
          ctx.state.sendSystemMessage('Usage: [sigils [pickup|drop|towns] [town]');
      }
    },
  });
  return () => api.commands.unregister('sigils');
}
