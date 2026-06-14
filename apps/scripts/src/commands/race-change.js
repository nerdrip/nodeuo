// `[race-change` — opens the RaceChangeGump. Default Human/Elf/Gargoyle.

export default function register(api) {
  if (!api.commands) return () => {};
  const sys = api.systems?.serverGumps;
  if (!sys) return () => {};

  api.commands.register({
    name: 'race-change',
    help: '[race-change — change your race.',
    access: 'Player',
    run(ctx) {
      const gumps = api.gumps;
      if (!gumps?.send) {
        ctx.state.sendSystemMessage('Gump dispatcher unavailable.');
        return;
      }
      sys.openRaceChangeGump(gumps, ctx.state, (mob, race) => {
        mob.race = race;
        // Body remap (canonical ServUO):
        const BODY_BY_RACE = {
          human:    mob.female ? 0x191 : 0x190,
          elf:      mob.female ? 0x25E : 0x25D,
          gargoyle: mob.female ? 0x29B : 0x29A,
        };
        mob.body = BODY_BY_RACE[race] ?? mob.body;
        ctx.state.sendSystemMessage(`You are now ${race}.`);
      });
    },
  });

  return () => api.commands.unregister('race-change');
}
