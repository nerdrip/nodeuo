// [prompt — ask the user to type a string via 0xC2, echo it back.

export default function (api) {
  const { commands, prompts, protocol } = api;
  if (!prompts) return;

  commands.register({
    name: 'prompt',
    help: 'Open a text prompt and echo the reply.',
    run: (ctx) => {
      const state = ctx.state;
      if (!state) return;
      prompts.ask(state, { text: 'Type a message:' }, (reply) => {
        if (reply.cancelled) {
          state.send(protocol.unicodeMessage({ text: 'Prompt cancelled.' }));
        } else {
          state.send(protocol.unicodeMessage({ text: `You said: ${reply.text}` }));
        }
      });
    },
  });

  return () => commands.unregister('prompt');
}
