// [quest <x> <y>  — set a quest arrow. [questoff clears it.

export default function (api) {
  const { commands, quest } = api;
  if (!quest) return;

  commands.register({
    name: 'quest',
    help: 'Set quest arrow. Usage: [quest <x> <y>',
    access: 'Player',
    run: (ctx) => {
      const state = ctx.state;
      if (!state) return;
      const x = parseInt(ctx.args[0] ?? '', 10);
      const y = parseInt(ctx.args[1] ?? '', 10);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        state.sendSystemMessage?.('Usage: [quest <x> <y>');
        return;
      }
      quest.show(state, x, y);
    },
  });

  commands.register({
    name: 'questoff',
    help: 'Hide the quest arrow.',
    access: 'Player',
    run: (ctx) => { if (ctx.state) quest.hide(ctx.state); },
  });

  return () => {
    commands.unregister('quest');
    commands.unregister('questoff');
  };
}
