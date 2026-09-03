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

  api.commands.register({
    name: 'schemacodex',
    help: '[schemacodex — place an Arcane Schema Codex in your backpack.',
    access: 'Admin',
    run(ctx) {
      const item = api.game?.mobile?.giveItem?.(ctx.sender, {
        definitionId: 'spell-schema-codex', artId: 0x0EFA,
        name: 'Arcane Schema Codex', hue: 0x0481,
        script: 'spell-schema-codex', kind: 'book', weight: 3,
      });
      ctx.state.sendSystemMessage?.(item
        ? 'An Arcane Schema Codex has been placed in your backpack.'
        : 'A backpack is required.');
    },
  });

  return () => {
    api.commands.unregister('spellcomposer');
    api.commands.unregister('schemacodex');
  };
}
