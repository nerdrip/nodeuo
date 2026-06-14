// Party commands — invite / leave / say.
//
//   [party             — target a mobile to invite
//   [partyleave        — leave the current party
//   [partysay <msg>    — broadcast to party members

export default function (api) {
  const { commands, targeting, party } = api;
  if (!party) return;

  commands.register({
    name: 'party',
    help: 'Target a mobile to invite them to your party.',
    access: 'Player',
    run: (ctx) => {
      const state = ctx.state;
      if (!state?.mobile) return;
      targeting.request(state, (resp) => {
        if (resp.cancelled || !resp.targetSerial) return;
        party.invite(state.mobile.serial, resp.targetSerial);
      });
    },
  });

  commands.register({
    name: 'partyleave',
    help: 'Leave your current party.',
    access: 'Player',
    run: (ctx) => {
      if (!ctx.state?.mobile) return;
      party.leave(ctx.state.mobile.serial);
    },
  });

  commands.register({
    name: 'partysay',
    help: 'Broadcast a message to your party. Usage: [partysay hello',
    access: 'Player',
    // dispatch() passes the tokenised args as the second argument — not via
    // ctx.args (which never existed). Reading ctx.args used to throw a
    // TypeError and nothing was ever said to the party.
    run: (ctx, args) => {
      if (!ctx.state?.mobile) return;
      const msg = (args ?? []).join(' ').trim();
      if (!msg) return;
      party.tellAll(ctx.state.mobile.serial, msg);
    },
  });

  return () => {
    commands.unregister('party');
    commands.unregister('partyleave');
    commands.unregister('partysay');
  };
}
