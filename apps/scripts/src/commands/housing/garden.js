// `[garden` — New Magincia farm-patch interaction (Magincia bazaar
// produce). Distinct from `[plant <kind>` which spawns a single decor
// plant; this drives the rent → seed → water → harvest cadence on a
// persistent (x,y,map) patch.
//
//   [garden rent           → claim the patch you stand on
//   [garden seed <type>    → plant a seed in your rented patch
//   [garden water          → water your patch
//   [garden harvest        → harvest a mature patch
//   [garden status         → patch state at your tile

export default function register(api) {
  if (!api.commands) return () => {};
  const gardens = api.systems?.maginciaPlants;
  if (!gardens) {
    api.log?.('garden: Magincia plants system unavailable');
    return () => {};
  }

  function patchHere(mob) {
    const x = mob?.x | 0, y = mob?.y | 0, m = mob?.map | 0;
    return gardens.patchAt(x, y, m) ?? gardens.registerPatch(x, y, m);
  }

  api.commands.register({
    name: 'garden',
    help: '[garden rent|seed|water|harvest|status — New Magincia farming.',
    access: 'Player',
    run(ctx, args) {
      const mob = ctx.sender; if (!mob) return;
      const sub = String(args?.[0] ?? '').toLowerCase();
      const patch = patchHere(mob);

      if (sub === 'rent') {
        ctx.state.sendSystemMessage(gardens.rentPatch(patch, mob)
          ? 'Patch rented. Plant a seed with [garden seed <type>.'
          : 'This patch is already taken.');
        return;
      }
      if (sub === 'seed') {
        const type = String(args?.[1] ?? '').toLowerCase();
        if (!type) { ctx.state.sendSystemMessage('Usage: [garden seed <type>'); return; }
        ctx.state.sendSystemMessage(gardens.plantSeed(patch, mob, type)
          ? `Seed planted (${type}).` : 'You cannot plant here right now.');
        return;
      }
      if (sub === 'water') {
        ctx.state.sendSystemMessage(gardens.waterPatch(patch, mob)
          ? `Patch watered. Saturation ${(patch._water * 100) | 0}%.`
          : 'You do not own this patch.');
        return;
      }
      if (sub === 'harvest') {
        const r = gardens.harvestPatch(patch, mob);
        if (!r) { ctx.state.sendSystemMessage('Nothing ripe here.'); return; }
        const pack = mob.backpack ?? mob.equipment?.get?.(21);
        api.templates?.spawn?.(r.yieldType, { container: pack, amount: r.count });
        ctx.state.sendSystemMessage(`Harvested ${r.count} × ${r.yieldType}.`);
        return;
      }
      if (sub === 'status') {
        ctx.state.sendSystemMessage(
          `Patch (${patch.x},${patch.y}): owner=${patch._owner ?? '-'}  ` +
          `plant=${patch._plant ?? '-'}  stage=${patch._stage}  water=${(patch._water * 100) | 0}%`,
        );
        return;
      }
      ctx.state.sendSystemMessage('Usage: [garden rent|seed|water|harvest|status');
    },
  });

  return () => api.commands.unregister('garden');
}
