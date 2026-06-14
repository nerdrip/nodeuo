// `[paperdoll` — force-open the sender's paperdoll without double-clicking.
// Also `[status` — send the full 0x11 MobileStatus packet.

/**
 * @param {import('@uo/server/src/scripts.js').ScriptAPI} api
 */
export default function register(api) {
  if (!api.protocol) return () => {};

  api.commands.register({
    name: 'paperdoll',
    help: '[paperdoll — open your paperdoll window.',
    access: 'Player',
    run(ctx) {
      ctx.state.send(api.protocol.openPaperdoll({
        serial: ctx.sender.serial, title: ctx.sender.name, flags: 0x02,
      }));
    },
  });

  api.commands.register({
    name: 'status',
    help: '[status — refresh your status window.',
    access: 'Player',
    run(ctx) {
      const m = ctx.sender;
      ctx.state.send(api.protocol.mobileStatus({
        serial: m.serial, name: m.name,
        hp: m.hp ?? 50, hpMax: m.hpMax ?? 50,
        mana: m.mana ?? 50, manaMax: m.manaMax ?? 50,
        stam: m.stam ?? 50, stamMax: m.stamMax ?? 50,
        str: m.str ?? 50, dex: m.dex ?? 50, int: m.int ?? 50,
        gold: m.gold ?? 0, sex: m.sex ?? 0,
        canRename: true,
      }));
    },
  });

  return () => {
    api.commands.unregister('paperdoll');
    api.commands.unregister('status');
  };
}
