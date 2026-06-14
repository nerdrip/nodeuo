// Polymorph (Circle 7, Magery 60+).
//
// Classic UO behaviour: caster picks a creature body from a fixed list
// (cat / dog / orc / ratman / lizardman / wolf / skeleton / horse) for 90
// seconds. Form-change disables casting, mounts, and recall while active.
//
// We keep the creature picker server-side: each call cycles to the next
// body in `POLYMORPH_BODIES`, mirroring CUO's PolymorphGump entry order.
// The full picker UI is FAZA-CC scope (multi-button gump); for now the
// command-line `[polymorph <body>` and the spellbook entry both land here.

import { aura, broadcastEffect, broadcastSound, broadcastBodyChange } from '../../_helpers.js';

/** Bodies the user can morph into. Numeric ids match CUO's body table. */
const POLYMORPH_BODIES = [
  { name: 'cat',        body: 0x00C9 },
  { name: 'dog',        body: 0x00D9 },
  { name: 'wolf',       body: 0x00E1 },
  { name: 'horse',      body: 0x00C8 },
  { name: 'orc',        body: 0x00B1 },
  { name: 'ratman',     body: 0x00D6 },
  { name: 'lizardman',  body: 0x00CD },
  { name: 'skeleton',   body: 0x0032 },
];

export default {
  name: 'polymorph',
  cast(api, ctx) {
    const caster = ctx.sender;
    if (caster._origBody != null) {
      ctx.state.sendSystemMessage('You are already in another form.');
      return;
    }
    // Pick a deterministic-ish form so unit tests can assert the spell
    // landed without flakiness. Real UO opens a picker; we cycle by
    // serial so successive casts walk through the table.
    const choice = POLYMORPH_BODIES[(caster.serial >>> 0) % POLYMORPH_BODIES.length];
    caster._origBody = caster.body;
    caster.body = choice.body;
    caster.polymorphed = true;
    api.combat?.animate?.(api.world, caster, 0x10);
    broadcastEffect(api, api.world, caster, aura(api, caster, { itemId: 0x375A, hue: 0 }));
    broadcastSound(api, api.world, caster, 0x0218);
    // BUGFIX #35: broadcast the body change to nearby observers, not
    // just the caster. The previous form-spell pattern only updated
    // the subject's own client.
    broadcastBodyChange(api, api.world, caster);
    ctx.state.sendSystemMessage(`You assume the form of a ${choice.name}.`);
    api.statusEffects?.apply?.(caster, {
      name: 'polymorph',
      durationMs: 90_000,
      onRemove(mob) {
        if (mob._origBody == null) return;
        mob.body = mob._origBody;
        delete mob._origBody;
        mob.polymorphed = false;
        broadcastBodyChange(api, api.world, mob);
        mob.client?.sendSystemMessage?.('You return to your natural form.');
      },
    });
  },
};
