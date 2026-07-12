// Misc player utility commands — `[loc`, `[suicide`.
//
// `[loc`     prints exact x,y,z + map + facing direction.
// `[suicide` instant self-kill — debug aid for testing death flow
//            without needing a hostile mob. Requires confirm via
//            `[suicide confirm` (single-shot, prevents misclicks).
//
// All three are ServUO-compatible verbs.

const _suicidePending = new WeakSet();

export default function register(api) {
  if (!api.commands) return () => {};

  api.commands.register({
    name: 'loc',
    help: '[loc — print exact coordinates of your character.',
    access: 'Player',
    run(ctx) {
      const m = ctx.sender;
      if (!m) return;
      const facing = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][m.direction & 7] ?? '?';
      ctx.state.sendSystemMessage?.(
        `Loc: ${m.x | 0},${m.y | 0},${m.z | 0}  map=${m.map | 0}  facing=${facing}`,
      );
    },
  });

  api.commands.register({
    name: 'suicide',
    help: '[suicide [confirm] — self-kill (debug). Requires confirmation.',
    access: 'Player',
    hidden: true,
    run(ctx, args) {
      const m = ctx.sender;
      if (!m) return;
      if (m.ghost) {
        ctx.state.sendSystemMessage?.('You are already dead.');
        return;
      }
      const sub = String(args?.[0] ?? '').toLowerCase();
      if (sub !== 'confirm') {
        _suicidePending.add(m);
        ctx.state.sendSystemMessage?.(
          'Are you sure? Type `[suicide confirm` within 10 seconds to die.',
        );
        setTimeout(() => _suicidePending.delete(m), 10_000);
        return;
      }
      if (!_suicidePending.has(m)) {
        ctx.state.sendSystemMessage?.('Run `[suicide` first to arm.');
        return;
      }
      _suicidePending.delete(m);
      // Apply massive damage routed through the canonical damage path so
      // corpse spawn + ghost transition + insurance fire correctly.
      if (api.combat?.damage) {
        api.combat.damage(api.world, { source: m, target: m, amount: 9999, type: 'phys' });
      } else if (api.corpse?.killMobile) {
        api.corpse.killMobile(api.world, m, null);
      } else {
        m.hp = 0;
        m.ghost = true;
      }
    },
  });

  return () => {
    api.commands.unregister('loc');
    api.commands.unregister('suicide');
  };
}
