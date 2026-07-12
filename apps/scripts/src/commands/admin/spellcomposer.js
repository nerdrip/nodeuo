// NodeUO-only visual spell draft editor. The standard UO command remains a
// harmless text command; no private packet is emitted unless the current
// transport negotiated the SpellComposer capability.

export default function register(api) {
  if (!api.commands || !api.spellComposer) return () => {};

  api.commands.register({
    name: 'spellcomposer',
    help: '[spellcomposer — open the visual custom-spell editor (NodeUO web client).',
    access: 'Admin',
    run(ctx) {
      if (!api.spellComposer.open(ctx.state)) {
        ctx.state.sendSystemMessage?.(
          'Spell Composer requires the NodeUO web client with nodeuo.v1 extensions. Standard UO gameplay remains available.',
        );
      }
    },
  });

  return () => api.commands.unregister('spellcomposer');
}
