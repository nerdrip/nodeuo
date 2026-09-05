import { summonOne } from '../../_summon-helpers.js';

// Energy Vortex — starts as an autonomous spinning vortex placed at the
// targeted tile, but remains owned and accepts explicit caster commands.
export default {
  name: 'energy-vortex',
  targetKind: 'location',
  cast(api, ctx, picked) {
    const caster = ctx.sender;
    api.combat.animate(api.world, caster, 0x10);
    if (!picked) { ctx.state.sendSystemMessage('Energy Vortex needs a tile target.'); return; }
    const target = picked.entity ?? picked;
    summonOne(api, ctx, {
      kind: 'energy-vortex', soundId: 0x212,
      durationMs: 120_000,
      aggressive: true,
      spot: { x: target.x, y: target.y, z: target.z ?? caster.z, map: target.map ?? caster.map ?? 1 },
      label: 'An energy vortex forms.',
    });
  },
};
