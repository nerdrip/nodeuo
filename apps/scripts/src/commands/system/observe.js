// `[observe` — astronomy ledger commands. Mirrors ServUO Telescope
// double-click behaviour: when used at night, logs the visible
// constellation into the player's ledger. Players who log all 8
// constellations can turn in the ledger to Willebrord for the
// Astronomer title.

export default function register(api) {
  if (!api.commands) return () => {};
  const astronomy = api.systems?.astronomy;
  if (!astronomy) {
    api.log?.('observe: astronomy system unavailable');
    return () => {};
  }

  api.commands.register({
    name: 'observe',
    help: '[observe [status|turnin] — record the visible constellation.',
    access: 'Player',
    run(ctx) {
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      const mob = ctx.sender;
      if (!mob) return;

      if (sub === 'status') {
        const s = astronomy.ledgerSummary(mob);
        ctx.state.sendSystemMessage(
          `Observed (${s.observed.length}/${astronomy.listAllConstellations().length}): ${s.observed.join(', ') || '(none)'}.`,
        );
        if (s.remaining.length > 0) {
          ctx.state.sendSystemMessage(`Yet to observe: ${s.remaining.join(', ')}.`);
        }
        return;
      }

      if (sub === 'turnin') {
        const reward = astronomy.turnInLedger(mob);
        if (!reward) {
          ctx.state.sendSystemMessage('Your ledger is not yet complete — observe all 8 constellations first.');
          return;
        }
        // Apply title + spawn reward bag in pack if possible.
        mob.title = reward.title;
        try {
          if (api.game?.mobile?.giveItem) {
            const r = api.game.mobile.giveItem(mob, {
              itemId: 0x0E76, hue: 0x47E,
              name: reward.rewardItem,
            }, { randomGrid: true });
            if (r) r._astronomyReward = true;
          }
        } catch { /* defensive */ }
        ctx.state.sendSystemMessage(
          `Willebrord congratulates you. You receive the title of "${reward.title}" and the Anniversary reward bag.`,
        );
        return;
      }

      // Default: record an observation. Requires the player be outdoors
      // and at "night" — we approximate by gating on day-night cycle.
      const dn = api.systems?.dayNight ?? api.dayNight;
      const isNight = dn?.isNight?.(api.world) ?? true;
      if (!isNight) {
        ctx.state.sendSystemMessage('The sky is too bright — you can only observe constellations at night.');
        return;
      }
      const facet = mob.map | 0;
      const result = astronomy.observe(mob, Date.now(), facet);
      if (result.newEntry) {
        ctx.state.sendSystemMessage(
          `You record a new sighting: ${result.constellation}. (${result.totalLogged}/${result.totalAvailable})`,
        );
      } else {
        ctx.state.sendSystemMessage(
          `You see ${result.constellation}, but it is already in your ledger.`,
        );
      }
    },
  });

  return () => api.commands.unregister('observe');
}
