import { mobileBySerial } from '../../_entities.js';
// FAZA DB — `[paragon` admin command toggles the paragon flag on a
// targeted creature. Mirrors ServUO's `[ParagonCheck` / `[Paragon`
// admin commands. Useful for spawn-control + testing.
//
// On flag-flip we re-broadcast 0x78 mobileIncoming so observers see
// the new hue/name immediately (bugfix #70).

export default function register(api) {
  if (!api.targeting || !api.commands || !api.systems?.paragons) return () => {};

  api.commands.register({
    name: 'paragon',
    help: '[paragon — target a creature to toggle its paragon flag.',
    access: 'GameMaster',
    run(ctx) {
      ctx.state.sendSystemMessage('Target a creature to (un)paragon.');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked || !picked.serial) {
          ctx.state.sendSystemMessage('Cancelled.');
          return;
        }
        const creature = mobileBySerial(api, picked.serial >>> 0);
        if (!creature) {
          ctx.state.sendSystemMessage('That creature is not nearby.');
          return;
        }
        if (creature.client) {
          ctx.state.sendSystemMessage('Players cannot be paragons.');
          return;
        }
        const { paragonize, unparagonize, broadcastParagonChange } = api.systems.paragons;
        if (creature.paragon) {
          unparagonize(creature);
          ctx.state.sendSystemMessage(`${creature.name ?? 'creature'} is no longer a paragon.`);
        } else {
          paragonize(creature);
          ctx.state.sendSystemMessage(`${creature.name ?? 'creature'} is now a paragon.`);
        }
        broadcastParagonChange?.(api, api.world, creature);
      }, { kind: 0 /* mobile */ });
    },
  });

  return () => api.commands.unregister('paragon');
}
