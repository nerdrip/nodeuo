// PHASE HI — `[polymorph <form>` form picker.
//
// ServUO `Spells/Seventh/Polymorph.cs` opens a gump (PolymorphGump.cs)
// with a clickable list of bodies. We expose the same as a text
// command so testers can swap forms without the UI roundtrip.

import { normalizeSkillValue } from '../../_rules.js';
import { allMobiles } from '../../_spatial.js';
import { equipmentForMobile } from '../../_equipment.js';

const FORMS = {
  cat:        { body: 0x00C9, name: 'cat' },
  dog:        { body: 0x00D9, name: 'dog' },
  wolf:       { body: 0x00E1, name: 'wolf' },
  horse:      { body: 0x00C8, name: 'horse' },
  orc:        { body: 0x00B1, name: 'orc' },
  ratman:     { body: 0x00D6, name: 'ratman' },
  lizardman:  { body: 0x00CD, name: 'lizardman' },
  skeleton:   { body: 0x0032, name: 'skeleton' },
  giantrat:   { body: 0x00D7, name: 'giant rat' },
  ettin:      { body: 0x002D, name: 'ettin' },
  troll:      { body: 0x0036, name: 'troll' },
  daemon:     { body: 0x004C, name: 'daemon' },
  gargoyle:   { body: 0x004D, name: 'gargoyle' },
};

export default function register(api) {
  if (!api.commands) return () => {};

  api.commands.register({
    name: 'polymorph',
    help: '[polymorph <form|list|revert> — change body. forms: ' + Object.keys(FORMS).join(', '),
    access: 'Player',
    run(ctx) {
      const sender = ctx.sender;
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      if (!sub || sub === 'list') {
        ctx.state.sendSystemMessage(`Forms: ${Object.keys(FORMS).join(', ')}`);
        return;
      }
      if (sub === 'revert') {
        if (sender._origBody == null) {
          ctx.state.sendSystemMessage('You are already in your natural form.');
          return;
        }
        sender.body = sender._origBody;
        delete sender._origBody;
        sender.polymorphed = false;
        broadcastBody(api, sender);
        ctx.state.sendSystemMessage('You return to your natural form.');
        return;
      }
      const form = FORMS[sub];
      if (!form) {
        ctx.state.sendSystemMessage(`Unknown form: ${sub}. Try [polymorph list.`);
        return;
      }
      // Magery skill gate: 60+ (matches Polymorph spell).
      const skill = normalizeSkillValue(sender.skills?.[26] ?? sender.skills?.['26'] ?? 0);
      if (skill < 60 && (ctx.state?.account?.accessLevel ?? 'Player') === 'Player') {
        ctx.state.sendSystemMessage('Polymorph requires Magery 60+.');
        return;
      }
      if (sender._origBody == null) sender._origBody = sender.body;
      sender.body = form.body;
      sender.polymorphed = true;
      broadcastBody(api, sender);
      ctx.state.sendSystemMessage(`You assume the form of a ${form.name}.`);
    },
  });

  return () => api.commands.unregister('polymorph');
}

function broadcastBody(api, mob) {
  if (!api.protocol?.mobileIncoming) return;
  // BUGFIX #123 (PHASE HI): the old polymorph-via-spell path used
  // _helpers.broadcastBodyChange. Direct-command path (no spell)
  // missed it — body changed server-side, every observer's screen
  // kept the old sprite. Send 0x78 mobileIncoming with the new body
  // to nearby clients. Self also gets a 0x20 mobileUpdate for clean
  // local refresh.
  if (mob.client && api.protocol?.mobileUpdate) {
    mob.client.send(api.protocol.mobileUpdate({
      serial: mob.serial, body: mob.body, hue: mob.hue ?? 0,
      flags: mob.flags ?? 0,
      x: mob.x, y: mob.y, z: mob.z, direction: mob.direction ?? 0,
    }));
  }
  const incoming = api.protocol.mobileIncoming({
    serial: mob.serial, body: mob.body, x: mob.x, y: mob.y, z: mob.z,
    direction: mob.direction ?? 0, hue: mob.hue ?? 0,
    flags: mob.flags ?? 0, notoriety: mob.notoriety ?? 1,
    equipment: equipmentForMobile(api, mob, { paperdollOnly: true }),
  });
  for (const m of allMobiles(api)) {
    if (!m.client || m === mob) continue;
    if (m.map !== mob.map) continue;
    if (Math.abs(m.x - mob.x) > 18 || Math.abs(m.y - mob.y) > 18) continue;
    m.client.send(incoming);
  }
}

export const _POLYMORPH_FORMS_FOR_TEST = FORMS;
