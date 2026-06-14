import { spawnField } from '../../_field-helpers.js';

// Wall of Stone — 5 stone tiles in a row perpendicular to the caster
// → target axis. Tiles are immovable and despawn after 30 seconds.
// 0x080B is the iron-gate-closed sprite which UO retail repurposes
// for the stone wall art piece in a few patches; the canonical
// "WallOfStone" art is 0x080B in our atlas's ServUO mapping.
export default {
  name: 'wall-of-stone',
  targetKind: 'location',
  cast(api, ctx, picked) {
    const caster = ctx.sender;
    if (!picked) { ctx.state.sendSystemMessage('Wall of Stone needs a tile target.'); return; }
    api.combat.animate(api.world, caster, 0x10);
    // Audit #36 P1 #2 — ServUO `WallOfStone.cs:72,105`: 3-tile wall
    // (`for i = -1..1`), 10-second timer. Was 5 tiles × 30 s — easy
    // PvP escape tool and forever-blocker.
    spawnField(api, ctx, picked, {
      itemId: 0x0080,                  // ServUO 'StoneBlocker' static
      length: 3,
      durationMs: 10_000,
      soundId: 0x1F6,
      name: 'a wall of stone',
    });
    ctx.state.sendSystemMessage('A wall of stone rises from the ground.');
  },
};
