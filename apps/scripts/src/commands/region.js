// [region info|list|find <name> — region inspection commands.
// Mirrors ServUO `[region` admin helpers + a player-facing variant
// that lists nearby region tags.

export default function register(api) {
  if (!api.commands || !api.regions) return () => {};

  api.commands.register({
    name: 'region',
    help: '[region info|list|find <name>',
    access: 'Player',
    run(ctx, args) {
      const sub = (args?.[0] ?? 'info').toLowerCase();
      const sender = ctx.sender;
      if (!sender) return;

      switch (sub) {
        case '':
        case 'info': {
          const here = api.regions.at?.(sender.map ?? 1, sender.x | 0, sender.y | 0) ?? [];
          if (here.length === 0) {
            ctx.state.sendSystemMessage('You stand in no named region.');
            return;
          }
          ctx.state.sendSystemMessage(`Region stack at (${sender.x}, ${sender.y}):`);
          for (const r of here) {
            const tags = [];
            if (r.guarded)  tags.push('guarded');
            if (r.noKill)   tags.push('safe');
            if (r.noRecall) tags.push('no-recall');
            if (r.noGate)   tags.push('no-gate');
            if (r.music)    tags.push(`music=${r.music}`);
            ctx.state.sendSystemMessage(`  • ${r.name}${tags.length ? '  ' + tags.join(', ') : ''}`);
          }
          return;
        }
        case 'list': {
          const all = api.regions.list?.() ?? [];
          ctx.state.sendSystemMessage(`Total regions registered: ${all.length}`);
          // Show first 20 by name for snapshot.
          for (const r of all.slice(0, 30)) {
            ctx.state.sendSystemMessage(`  ${r.name.padEnd(28)} map=${r.map}`);
          }
          if (all.length > 30) ctx.state.sendSystemMessage(`  …(${all.length - 30} more)`);
          return;
        }
        case 'find': {
          const q = String(args?.[1] ?? '').toLowerCase();
          if (!q) { ctx.state.sendSystemMessage('Usage: [region find <name>'); return; }
          const all = api.regions.list?.() ?? [];
          const hits = all.filter((r) => (r.name ?? '').toLowerCase().includes(q));
          if (hits.length === 0) { ctx.state.sendSystemMessage('No matching region.'); return; }
          for (const r of hits.slice(0, 20)) {
            const x = r.rects?.[0]?.x1 ?? '?';
            const y = r.rects?.[0]?.y1 ?? '?';
            ctx.state.sendSystemMessage(`  ${r.name.padEnd(28)} map=${r.map}  near (${x},${y})`);
          }
          return;
        }
        default:
          ctx.state.sendSystemMessage('Usage: [region info|list|find <name>');
      }
    },
  });
  return () => {};
}
