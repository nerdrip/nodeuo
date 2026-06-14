// `[camp-place <kind>` — admin spawn a static camp at the player's
// position. Wraps server-side systems/housing/camps.js.

export default function register(api) {
  if (!api.commands) return () => {};
  const sys = api.systems?.camps;
  if (!sys) return () => {};

  api.commands.register({
    name: 'camp-place',
    help: '[camp-place list|<kind> — spawn a roadside camp.',
    access: 'Admin',
    run(ctx, args) {
      const sub = args?.[0] ?? 'list';
      if (sub === 'list') {
        ctx.state.sendSystemMessage(`Camp kinds: ${sys.listKinds().join(', ')}`);
        return;
      }
      const def = sys.getDef(sub);
      if (!def) { ctx.state.sendSystemMessage('Unknown camp kind.'); return; }
      const m = ctx.sender;
      const camp = sys.placeCamp(api.world, {
        kind: sub, x: m.x, y: m.y, z: m.z, map: m.map ?? 1,
        spawner: api.spawner,
      });
      if (camp) {
        ctx.state.sendSystemMessage(`Placed ${sub} camp (id=${camp.id}). NPCs: ${camp.npcs.length}.`);
      }
    },
  });

  api.commands.register({
    name: 'camp-despawn',
    help: '[camp-despawn <id> — remove a camp.',
    access: 'Admin',
    run(ctx, args) {
      const id = parseInt(args?.[0] ?? '0', 10);
      const ok = sys.despawnCamp(api.world, id);
      ctx.state.sendSystemMessage(ok ? 'Despawned.' : 'Not found.');
    },
  });

  api.commands.register({
    name: 'camp-list',
    help: '[camp-list — show active camps.',
    access: 'Admin',
    run(ctx) {
      const all = sys.listCamps();
      ctx.state.sendSystemMessage(`Active camps: ${all.length}`);
      for (const c of all) {
        ctx.state.sendSystemMessage(`  #${c.id} ${c.kind} @(${c.x},${c.y}) map=${c.map} npcs=${c.npcs.length}`);
      }
    },
  });

  return () => {
    api.commands.unregister('camp-place');
    api.commands.unregister('camp-despawn');
    api.commands.unregister('camp-list');
  };
}
