// FAZA FS — `[sigil pickup <town>` / `[sigil drop <town>` / `[sigil
// status` admin/player commands. ServUO `Items/Factions/Sigil.cs`
// is normally a world item the player double-clicks; we expose a
// command line variant tied directly to the sigils system.

export default function register(api) {
  if (!api.commands || !api.systems?.sigils) return () => {};

  api.commands.register({
    name: 'sigil',
    help: '[sigil pickup|drop|status [town]',
    access: 'Player',
    run(ctx) {
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      const town = String(ctx.args[1] ?? '').toLowerCase();
      const sigils = api.systems.sigils;
      switch (sub) {
        case 'status': {
          const out = ['Sigils:'];
          for (const s of sigils.listSigils()) {
            out.push(`  ${s.town}: ${s.carrier ? 'held' : 'free'}${s.owner ? ` (owner ${s.owner})` : ''}`);
          }
          ctx.state.sendSystemMessage(out.join('\n'));
          break;
        }
        case 'pickup': {
          const r = sigils.pickup(town, ctx.sender.serial >>> 0);
          ctx.state.sendSystemMessage(r.ok ? `You take the ${town} sigil.` : `Cannot pick up: ${r.reason}.`);
          break;
        }
        case 'drop': {
          const r = sigils.drop(town, ctx.sender.serial >>> 0);
          ctx.state.sendSystemMessage(r.ok ? `You drop the ${town} sigil.` : `Cannot drop: ${r.reason}.`);
          break;
        }
        default:
          ctx.state.sendSystemMessage('Usage: [sigil <pickup|drop|status> [town]');
      }
    },
  });

  return () => api.commands.unregister('sigil');
}
