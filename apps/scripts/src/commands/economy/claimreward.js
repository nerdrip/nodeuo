// [claimreward — Veteran Rewards browse + claim. Mirrors ServUO
// Davies Locker / RewardChoiceGump. Usage:
//   [claimreward                — list eligible rewards + credits
//   [claimreward <reward-name>  — claim and spawn into your pack

export default function register(api) {
  if (!api.commands || !api.systems?.veteranRewards) {
    api.log?.('cmd/claimreward: missing veteranRewards system; skipping');
    return () => {};
  }
  const VR = api.systems.veteranRewards;

  api.commands.register({
    name: 'claimreward',
    help: '[claimreward [<reward-name>]',
    access: 'Player',
    run(ctx, args) {
      const sender = ctx.sender;
      const account = ctx.state?.account;
      if (!account) { ctx.state.sendSystemMessage('No account context.'); return; }

      const credits   = VR.availableCredits(account);
      const eligible  = VR.eligibleRewards(account);
      const rewardKey = (args?.[0] ?? '').toLowerCase();

      if (!rewardKey) {
        ctx.state.sendSystemMessage(`You have ${credits} reward credit(s). Tier ${VR.tierForAccount(account)}.`);
        ctx.state.sendSystemMessage('Eligible rewards:');
        for (let i = 0; i < eligible.length; i += 4) {
          ctx.state.sendSystemMessage('  ' + eligible.slice(i, i + 4).join('   '));
        }
        ctx.state.sendSystemMessage('Use: [claimreward <name>');
        return;
      }

      const r = VR.redeem(account, rewardKey);
      if (!r.ok) {
        ctx.state.sendSystemMessage(`Cannot claim "${rewardKey}": ${r.reason}`);
        return;
      }
      // Spawn the concrete item into the player's pack.
      const cfg = VR.spawnConfig?.(r.reward) ?? null;
      if (!cfg) {
        VR.rollbackRedemption?.(account, r.reward);
        ctx.state.sendSystemMessage(`Reward ${r.reward} is not configured; the credit was not spent.`);
        return;
      }
      if (!api.game?.inventory?.findBackpack?.(sender)) {
        VR.rollbackRedemption?.(account, r.reward);
        ctx.state.sendSystemMessage('You have no backpack for the reward.');
        return;
      }
      try {
        const item = api.game?.mobile?.giveItem?.(sender, {
          itemId: cfg.itemId,
          hue: cfg.hue ?? 0,
          name: cfg.name ?? r.reward,
        }, { randomGrid: true });
        if (!item) throw new Error('no backpack');
        if (cfg.mount != null) item.mount = cfg.mount;
        if (cfg.charges != null) item.charges = cfg.charges;
        if (cfg.deed != null) item.deed = cfg.deed;
      } catch (e) {
        VR.rollbackRedemption?.(account, r.reward);
        ctx.state.sendSystemMessage(`Spawn failed: ${e?.message ?? e}`);
        return;
      }
      ctx.state.sendSystemMessage(`Claimed ${r.reward}. ${VR.availableCredits(account)} credit(s) remaining.`);
    },
  });
  return () => {};
}
