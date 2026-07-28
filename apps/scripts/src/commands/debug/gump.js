// [gump — admin test gump with a text field and two buttons.
//
// Usage: say `[gump` in-world; the server will open a simple prompt. Click
// "Accept" to echo what you typed, "Cancel" to dismiss.

export default function (api) {
  const { commands, gumps } = api;
  if (!gumps) return;
  commands.register({
    name: 'gump',
    help: 'Open a test input gump.',
    hidden: true,
    run: (ctx) => {
      const state = ctx.state;
      if (!state) return;
      gumps.send(state, {
        definitionId: 'server:commands-debug-gump:send-1',
        x: 100, y: 100,
        layout:
          '{ page 0 }' +
          '{ resizepic 0 0 5054 300 140 }' +
          '{ text 30 20 1153 0 }' +   // textId 0
          '{ textentry 30 55 240 20 1152 1 1 }' + // entryId 1, initial text id 1
          '{ button 30 100 4023 4024 1 0 1 }' +   // Accept: return 1
          '{ button 170 100 4020 4021 1 0 2 }',   // Cancel: return 2
        texts: ['Please type something:', ''],
      }, (r) => {
        if (r.buttonId !== 1) {
          state.send(api.protocol.unicodeMessage({ text: 'Cancelled.' }));
          return;
        }
        const entry = r.textEntries.find((e) => e.entryId === 1);
        state.send(api.protocol.unicodeMessage({
          text: `You typed: ${entry?.text ?? '(nothing)'}`,
        }));
      });
    },
  });
  return () => commands.unregister('gump');
}
