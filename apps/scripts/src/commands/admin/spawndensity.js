// [spawndensity — admin spawn-rate controls. Mirrors ServUO admin
// spawn modifiers (`SpawnerSpeedMultiplier` global + per-zone scale).
// Allows runtime tuning without editing spawn group definitions.

export default function register(api) {
  if (!api.commands || !api.spawner) return () => {};

  api.commands.register({
    name: 'spawndensity',
    help: '[spawndensity get|set <factor>|reset|list',
    access: 'Admin',
    run(ctx, args) {
      const sub = (args?.[0] ?? 'get').toLowerCase();
      switch (sub) {
        case '':
        case 'get': {
          const factor = api.spawner._densityFactor ?? 1.0;
          ctx.state.sendSystemMessage(`Spawn density factor: ${factor.toFixed(2)} (1.0 = normal)`);
          return;
        }
        case 'set': {
          const f = parseFloat(args?.[1]);
          if (!Number.isFinite(f) || f <= 0 || f > 10) {
            ctx.state.sendSystemMessage('Usage: [spawndensity set <0.1..10.0>');
            return;
          }
          api.spawner._densityFactor = f;
          // If the spawner exposes a `setDensity` API, hand off; else
          // groups will see the field on their next tick.
          api.spawner.setDensity?.(f);
          ctx.state.sendSystemMessage(`Spawn density set to ${f.toFixed(2)}.`);
          return;
        }
        case 'reset': {
          api.spawner._densityFactor = 1.0;
          api.spawner.setDensity?.(1.0);
          ctx.state.sendSystemMessage('Spawn density reset to 1.0.');
          return;
        }
        case 'list': {
          const groups = api.spawner.list?.() ?? [];
          if (groups.length === 0) {
            ctx.state.sendSystemMessage('No registered spawn groups.');
            return;
          }
          ctx.state.sendSystemMessage(`Registered spawn groups: ${groups.length}`);
          for (const g of groups.slice(0, 30)) {
            ctx.state.sendSystemMessage(`  ${g.id?.padEnd?.(28) ?? '?'}  max=${g.maxCount}  kinds=${(g.kinds ?? []).join(',')}`);
          }
          if (groups.length > 30) ctx.state.sendSystemMessage(`  …(${groups.length - 30} more)`);
          return;
        }
        default:
          ctx.state.sendSystemMessage('Usage: [spawndensity get|set <factor>|reset|list');
      }
    },
  });
  return () => {};
}
