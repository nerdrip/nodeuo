// `[galleon <kind> | dock` — place / dock a Stygian-Abyss galleon.
//
// Kinds: britannian | tokuno | orc | gargish (see BOAT_HULLS in
// apps/server/src/systems/boats.js). The hull is placed under the
// caster's feet; cannons are mounted at hull-specific gun-port offsets
// by `placeGalleon()`. Dock requires the caster to be standing on the
// hull and anchored; the deed lands in the caster's pack.

import { allItems } from '../../_spatial.js';

const KINDS = ['britannian', 'tokuno', 'orc', 'gargish'];

export default function register(api) {
  if (!api.commands) return () => {};

  api.commands.register({
    name: 'galleon',
    help: '[galleon <britannian|tokuno|orc|gargish> | [galleon dock — place or dry-dock a galleon.',
    access: 'Player',
    run(ctx) {
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      const mob = ctx.sender;
      if (!mob) return;
      if (sub === 'dock') {
        // Find a galleon under the caster's feet.
        let boat = null;
        for (const it of allItems(api)) {
          if (!it.boat?.cannons) continue;
          if (it.map !== mob.map) continue;
          if (Math.abs(it.x - mob.x) > 2 || Math.abs(it.y - mob.y) > 2) continue;
          boat = it; break;
        }
        if (!boat) {
          ctx.state.sendSystemMessage('No galleon under your feet.');
          return;
        }
        const r = api.systems?.boats?.dryDockGalleon?.(api, boat, mob)
          ?? { ok: false, reason: 'boat system unavailable' };
        if (!r.ok) {
          ctx.state.sendSystemMessage(`Cannot dry-dock: ${r.reason}.`);
          return;
        }
        ctx.state.sendSystemMessage('Galleon dry-docked. Deed in your pack.');
        return;
      }
      if (!KINDS.includes(sub)) {
        ctx.state.sendSystemMessage(`Usage: [galleon ${KINDS.join('|')} | dock`);
        return;
      }
      const boat = api.systems?.boats?.placeGalleon?.(api, {
        kind: sub, x: mob.x, y: mob.y, z: mob.z, map: mob.map,
        ownerSerial: mob.serial,
      });
      if (!boat) {
        ctx.state.sendSystemMessage('Failed to place galleon (no water?).');
        return;
      }
      ctx.state.sendSystemMessage(`A ${sub} galleon appears beneath you.`);
    },
  });

  return () => api.commands.unregister('galleon');
}
