import { resolveItemArg } from '../_targeting-helpers.js';

// `[setbudget <serial> <N>` — GM override for an item's imbue weight
// budget. Stamps `_imbueBudget` directly; the imbue commands and
// the OPL provider both read this field with a 500 default fallback.
//
// Wave 34: when called as `[setbudget <N>` (one numeric arg), opens
// a cursor target prompt for the item — handier than copying serial
// hex codes from tooltips.

export default function (api) {
  const { commands } = api;
  if (!commands) return () => {};

  commands.register({
    name: 'setbudget',
    help: '[setbudget <serial> <N> | [setbudget <N> — second form opens cursor target.',
    access: 'GM',
    run(ctx) {
      // Wave 34: detect single-numeric-arg form. Two args = serial+N
      // (legacy). One non-numeric arg → usage. One numeric arg →
      // cursor target with budget supplied.
      const a0 = ctx.args[0];
      const a1 = ctx.args[1];
      let nArg = null;
      let argIdx = 0;
      if (a0 != null && a1 != null) {
        nArg = a1;
        argIdx = 0;     // resolveItemArg reads serial at args[0]
      } else if (a0 != null && a1 == null) {
        // Treat as bare-budget form. Only valid if numeric.
        const tryNum = parseInt(a0, 10);
        if (Number.isFinite(tryNum)) {
          nArg = a0;
          argIdx = 99;  // sentinel: skip arg lookup, force cursor
        } else {
          ctx.state.sendSystemMessage('Usage: [setbudget <serial> <N>  |  [setbudget <N>');
          return;
        }
      } else {
        ctx.state.sendSystemMessage('Usage: [setbudget <serial> <N>  |  [setbudget <N>');
        return;
      }
      const want = parseInt(nArg, 10);
      if (!Number.isFinite(want) || want < 0 || want > 5000) {
        ctx.state.sendSystemMessage('Budget must be 0..5000.');
        return;
      }
      // For the bare-budget form we want pure cursor target. Pass
      // an out-of-range argIdx so resolveItemArg falls through to
      // the targeting prompt unconditionally.
      resolveItemArg(api, ctx, argIdx, (item) => {
        if (!item) return;
        const serial = item.serial >>> 0;
        if (want === 0) {
          delete item._imbueBudget;
          ctx.state.sendSystemMessage(`Cleared imbue budget override on 0x${serial.toString(16)} (back to default).`);
        } else {
          item._imbueBudget = want;
          ctx.state.sendSystemMessage(`Set imbue budget on 0x${serial.toString(16)} to ${want}.`);
        }
        const provider = ctx.state?.ctx?.propertyProvider;
        if (provider && api.properties?.nudge && api.properties?.computeHash) {
          const r = provider(item.serial, ctx.state);
          if (r?.entries) api.properties.nudge(ctx.state, item.serial, api.properties.computeHash(r.entries));
        }
      }, { promptText: `Target an item to set imbue budget to ${want}…` });
    },
  });

  return () => commands.unregister('setbudget');
}
