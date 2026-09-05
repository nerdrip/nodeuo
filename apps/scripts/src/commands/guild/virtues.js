// PHASE DC — `[virtues` shows current virtue ranks + pushes the live
// virtue-state event so the browser gump (Ctrl+V) displays accurate
// numbers. ServUO has no equivalent text command — `[v]` opens the
// virtue gump natively in classic — but our browser client renders
// the gump locally from a server-pushed payload, and the `[virtues`
// command is the simplest manual trigger.

export default function register(api) {
  if (!api.commands || !api.systems?.virtues?.pushVirtues) return () => {};

  api.commands.register({
    name: 'virtues',
    help: '[virtues — show your virtue ranks (also opens the gump on Ctrl+V).',
    access: 'Player',
    run(ctx, args) {
      const mob = ctx.sender;
      api.systems.virtues.pushVirtues(mob);
      const v = mob.virtues ?? {};
      const sub = String(args?.[0] ?? '').toLowerCase();
      if (sub === 'gump' || sub === 'panel') {
        // Phase H.2 — open the rich VirtueGump overlay.
        const rows = (api.systems.virtues.VIRTUES ?? []).map((key) => {
          const val = v[key] | 0;
          const rank = api.systems.virtues.rankAt?.(val);
          return `${key}|${val}|${rank?.name ?? ''}`;
        }).join(';');
        ctx.state.sendSystemMessage?.(`@@OPEN_VIRTUE_GUMP@@${rows}`);
        return;
      }
      const lines = [];
      for (const key of api.systems.virtues.VIRTUES ?? []) {
        const val = v[key] | 0;
        const rank = api.systems.virtues.rankAt?.(val);
        const label = key.charAt(0).toUpperCase() + key.slice(1);
        lines.push(`${label}: ${val}${rank ? ` (${rank.name})` : ''}`);
      }
      for (const line of lines) ctx.state.sendSystemMessage(line);
    },
  });

  return () => api.commands.unregister('virtues');
}
