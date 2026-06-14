// Spike trap — fires onWalkOn for any mobile that isn't the trap's
// owner. Damage roll: 8..15. Owner immunity prevents the trap-placer
// from killing themselves while arming the dungeon.

export default function buildSpikeTrapScript(api) {
  return {
    name: 'spike-trap',
    onWalkOn(world, item, mob) {
      if (!mob || (mob.serial >>> 0) === ((item.owner ?? 0) >>> 0)) return;
      const dmg = 8 + Math.floor(Math.random() * 8);
      api.combat?.damage?.(world, mob, dmg);
      mob.client?.sendSystemMessage?.('Spikes pierce your boots!');
    },
  };
}
