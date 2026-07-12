// Data-driven specialization tree. The command is deliberately useful over
// every standard UO client; NodeUO's negotiated client upgrades the empty
// invocation to a visual tree without changing the classic command protocol.

function sendSummary(ctx, system) {
  const view = system.snapshot(ctx.sender);
  const { earned, spent, available, allocations } = view.state;
  ctx.state.sendSystemMessage?.(`Specializations: ${spent}/${earned} point(s) spent, ${available} available.`);
  for (const tree of view.trees) {
    const nodes = tree.nodes.map((node) => {
      const learned = allocations[node.id] ? '*' : '-';
      const lock = node.requires.length ? ` requires ${node.requires.join('+')}` : '';
      return `${learned}${node.id}${lock}`;
    });
    ctx.state.sendSystemMessage?.(`  ${tree.label}: ${nodes.join(' > ')}`);
  }
  ctx.state.sendSystemMessage?.('Use [specialize learn <node> or [specialize reset.');
}

export default function register(api) {
  const system = api.specializations ?? api.systems?.specializations;
  if (!api.commands || !system) return () => {};

  const spec = {
    name: 'specialize',
    aliases: ['specialization'],
    help: '[specialize [list|learn <node>|reset] — specialization tree.',
    access: 'Player',
    run(ctx) {
      const sub = String(ctx.args?.[0] ?? '').toLowerCase();
      if (!sub) {
        if (!system.open(ctx.state)) sendSummary(ctx, system);
        return;
      }
      if (sub === 'list' || sub === 'status') {
        sendSummary(ctx, system);
        return;
      }
      if (sub === 'learn') {
        const id = String(ctx.args?.[1] ?? '').toLowerCase();
        const result = system.allocate(ctx.sender, id);
        ctx.state.sendSystemMessage?.(result.ok ? `Learned ${result.node.label}.` : result.error);
        return;
      }
      if (sub === 'reset') {
        const refunded = system.reset(ctx.sender);
        ctx.state.sendSystemMessage?.(`Specializations reset; ${refunded} point(s) refunded.`);
        return;
      }
      ctx.state.sendSystemMessage?.('Usage: [specialize [list|learn <node>|reset]');
    },
  };

  if (api.lifecycle?.command?.(spec)) return () => {};
  api.commands.register(spec);
  return () => api.commands.unregister('specialize');
}
