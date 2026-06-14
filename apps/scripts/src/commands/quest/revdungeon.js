// `[revdungeon` — Revamped Dungeons player commands.
// Wraps the server-side `systems/bosses/revamped-dungeons.js` registry.

export default function register(api) {
  if (!api.commands) return () => {};
  const sys = api.systems?.revampedDungeons;
  if (!sys) {
    api.log?.('revdungeon: server system not wired — skipping');
    return () => {};
  }

  api.commands.register({
    name: 'revdungeon',
    help: '[revdungeon list|start <id>|status [id]',
    access: 'Player',
    run(ctx, args) {
      const sub = args?.[0] ?? 'list';
      if (sub === 'list') {
        const list = sys.listDungeons();
        ctx.state.sendSystemMessage(`Revamped Dungeons (${list.length}):`);
        for (const d of list) {
          ctx.state.sendSystemMessage(`  ${d.id} — ${d.name} (boss: ${d.finalBoss})`);
        }
        return;
      }
      if (sub === 'start') {
        const id = args?.[1];
        if (!id) { ctx.state.sendSystemMessage('Usage: [revdungeon start <id>'); return; }
        const r = sys.startDungeon(ctx.sender, id);
        if (!r.ok) { ctx.state.sendSystemMessage(`Cannot start: ${r.reason}`); return; }
        ctx.state.sendSystemMessage(`Started ${r.def.name}. Room 1: ${r.def.rooms[0]?.id}`);
        return;
      }
      if (sub === 'status') {
        const st = sys.statusFor(ctx.sender, args?.[1] ?? null);
        if (!st) { ctx.state.sendSystemMessage('No active dungeon.'); return; }
        ctx.state.sendSystemMessage(JSON.stringify(st));
        return;
      }
    },
  });

  // Kill hook — bump progress on slay.
  api.events?.on?.('mobile:killed', (ev) => {
    const killer = ev.killer; const victim = ev.victim;
    if (!killer || !victim) return;
    const kind = victim.kind ?? victim.template ?? '';
    const advanced = sys.recordKill(killer, kind);
    for (const a of advanced) {
      killer.client?.sendSystemMessage?.(`Dungeon ${a.id}: room ${a.room} cleared. Next: ${a.next}.`);
    }
    sys.recordMinibossKill(killer, kind);
    const rewards = sys.recordBossKill(killer, kind, api.world);
    for (const r of rewards) {
      killer.client?.sendSystemMessage?.(
        `${r.dungeonId} CLEARED! Reward: ${r.artifact} + ${r.magicCount} magic items.`,
      );
      // Spawn the artifact stub into pack (item factory is best-effort).
      if (r.artifact && api.game?.mobile?.giveItem) {
        try {
          api.game.mobile.giveItem(killer, {
            itemId: 0x1F1C,
            name: r.artifact,
          }, { randomGrid: true });
        } catch { /* no pack */ }
      }
    }
  });

  return () => api.commands.unregister('revdungeon');
}
