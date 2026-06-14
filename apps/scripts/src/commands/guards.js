import { allMobiles } from '../_spatial.js';
import { createMobile, destroyMobileBySerial } from '../_mobiles.js';
// `[guards me` — summon a Town Guard to your position. ServUO
// `GuardedRegion.CallGuards` mechanic: in a guarded town, a player
// can yell "Guards!" (or type [guards) to flag any nearby criminal/
// murderer for execution by a freshly-spawned invulnerable Guard NPC
// that one-shots them within 1 tile and despawns after 5 s. Audit #35
// P2 #12: was entirely missing — murderers strolled through Britain.
//
// MVP scope:
//   - `[guards me` only (no auto-spawn from flagCriminal yet — that's
//     a sectors fan-out + spawner integration deferred).
//   - Spawn a "Town Guard" mob with the standard guard template if it
//     exists; otherwise a generic strong-fighter stub.
//   - Damage every criminally-flagged or murder-flagged mob within 2
//     tiles of the guard, then despawn the guard after 5 s.

const SUMMON_DURATION_MS = 5000;

export default function register(api) {
  if (!api.commands) return () => {};
  api.commands.register({
    name: 'guards',
    help: '[guards me — call the town guards.',
    access: 'Player',
    run(ctx) {
      const sub = (ctx.args?.[0] ?? '').toLowerCase();
      if (sub !== 'me' && sub !== '') {
        ctx.state.sendSystemMessage('Usage: [guards me');
        return;
      }
      const sender = ctx.sender;
      if (!sender) return;
      if (!api.regions?.isGuarded?.(sender.map, sender.x, sender.y)) {
        ctx.state.sendSystemMessage('There are no guards in this area.');
        return;
      }
      // Spawn the guard at the caller's tile via the factory (or a
      // raw createMobile fallback). Mark invulnerable + 4× HP so a
      // single criminal can't outduel it.
      const factory = api.ctx?.spawnFactory ?? api.spawnFactory;
      let guard = null;
      try {
        if (factory) {
          guard = factory(api.world, 'town-guard',
            { x: sender.x, y: sender.y, z: sender.z, map: sender.map });
        }
      } catch { /* template missing — fall through */ }
      if (!guard) {
        // Generic stub.
        guard = createMobile(api, api.world, {
          name: 'a Town Guard', body: 0x0190,
          x: sender.x, y: sender.y, z: sender.z, map: sender.map,
          hp: 4000, hpMax: 4000, str: 250, dex: 250, int: 250,
          notoriety: 2,                          // guard-blue (CUO Innocent)
          invulnerable: true,
        });
      }
      if (!guard) {
        ctx.state.sendSystemMessage('No guard could respond.');
        return;
      }
      ctx.state.sendSystemMessage('A Town Guard arrives!');
      // Scan nearby mobiles for criminal/murderer flagged; one-shot each.
      const now = Date.now();
      for (const m of allMobiles(api)) {
        if (m === guard || m === sender) continue;
        if (m.map !== guard.map) continue;
        if (Math.max(Math.abs(m.x - guard.x), Math.abs(m.y - guard.y)) > 2) continue;
        const isCrim = (m.criminalUntil ?? 0) > now || (m.kills | 0) >= 5;
        if (!isCrim) continue;
        try {
          // Lethal damage + lightning effect.
          if (api.combat?.damage) api.combat.damage(api.world, m, (m.hp ?? 1) + 10, guard);
        } catch { /* combat helper optional */ }
      }
      // Despawn the guard after 5 s (or via existing destroyMobile path).
      setTimeout(() => {
        try { destroyMobileBySerial(api, guard.serial); }
        catch { /* already gone */ }
      }, SUMMON_DURATION_MS).unref?.();
    },
  });
  return () => api.commands.unregister('guards');
}
