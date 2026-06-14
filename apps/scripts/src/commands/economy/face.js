import { mobileBySerial } from '../../_entities.js';
import { allMobiles } from '../../_spatial.js';
// `[face` — character / NPC paperdoll customization gump.
//
// ServUO `Engines/Customization/FaceChange.cs`. Players visit a Barber
// or Tailor NPC and re-roll their face/hair/skin hue. We expose the
// same as a chat command opening a gump with adjustment buttons; for
// GMs the target arg lets them customize any mob.
//
//   [face                — open the gump targeting yourself
//   [face npc            — (GM) target an NPC to customize
//
// Persistent fields the gump writes:
//   mob.hue              — skin hue (0..0x0BBA in the Skin palette)
//   mob.hair             — hair item kind id (0..N from HAIR_STYLES)
//   mob.hairHue          — hair hue (0..0x0FAA)
//   mob.facialHair       — beard style (male only)
//   mob.facialHairHue    — beard hue

const SKIN_HUES = [
  0x83EA, 0x83E6, 0x03E0, 0x03E1, 0x03E2, 0x03E3, 0x03E4,
  0x03E5, 0x03E6, 0x03E7, 0x03E8, 0x03E9, 0x03EA, 0x03EB,
];
const HAIR_STYLES = [
  { id: 0x203B, name: 'Short' },
  { id: 0x203C, name: 'Long' },
  { id: 0x203D, name: 'Ponytail' },
  { id: 0x2044, name: 'Mohawk' },
  { id: 0x2045, name: 'Pageboy' },
  { id: 0x2047, name: 'Topknot' },
  { id: 0x2048, name: 'Curly' },
  { id: 0x2049, name: 'Spiky' },
];
const HAIR_HUES = [
  0,       // black
  0x021,   // red
  0x044,   // gold
  0x047E,  // pure-blonde
  0x481,   // grey
  0x489,   // ash
  0x500,   // light brown
  0x4F2,   // teal (fantasy)
];

function openFaceGump(api, ctx, target) {
  if (!api.gumps?.send) {
    ctx.state.sendSystemMessage?.('Gump system unavailable.');
    return;
  }
  const W = 420, H = 280;
  const parts = [`{ resizepic 0 0 9200 ${W} ${H} }`];
  const texts = [];
  texts.push(`Face Customization — ${target.name ?? 'subject'}`);
  parts.push(`{ text 16 12 1153 ${texts.length - 1} }`);

  // Skin row.
  texts.push('Skin hue:'); parts.push(`{ text 16 50 1149 ${texts.length - 1} }`);
  SKIN_HUES.forEach((hue, i) => {
    const x = 100 + (i % 7) * 38;
    const y = 50 + Math.floor(i / 7) * 28;
    parts.push(`{ button ${x} ${y} 4005 4006 1 0 ${100 + i} }`);
    if (target.hue === hue) {
      texts.push('●');
      parts.push(`{ text ${x + 12} ${y + 2} 1167 ${texts.length - 1} }`);
    }
  });

  // Hair style row.
  texts.push('Hair:');     parts.push(`{ text 16 120 1149 ${texts.length - 1} }`);
  HAIR_STYLES.forEach((h, i) => {
    const x = 70 + i * 42;
    parts.push(`{ button ${x} 120 4005 4006 1 0 ${200 + i} }`);
    texts.push(h.name);
    parts.push(`{ text ${x + 12} 138 1153 ${texts.length - 1} }`);
    if (target.hair === h.id) {
      texts.push('●');
      parts.push(`{ text ${x + 12} 100 1167 ${texts.length - 1} }`);
    }
  });

  // Hair hue row.
  texts.push('Hair hue:'); parts.push(`{ text 16 170 1149 ${texts.length - 1} }`);
  HAIR_HUES.forEach((hue, i) => {
    const x = 100 + i * 38;
    parts.push(`{ button ${x} 170 4005 4006 1 0 ${300 + i} }`);
    if (target.hairHue === hue) {
      texts.push('●');
      parts.push(`{ text ${x + 12} 152 1167 ${texts.length - 1} }`);
    }
  });

  // Random / Reset
  parts.push(`{ button 16 230 4005 4006 1 0 9000 }`);
  texts.push('Randomize');
  parts.push(`{ text 46 232 1153 ${texts.length - 1} }`);

  parts.push(`{ button 150 230 4014 4015 1 0 9001 }`);
  texts.push('Reset');
  parts.push(`{ text 180 232 1153 ${texts.length - 1} }`);

  // Close X
  parts.push(`{ button ${W - 30} 8 4017 4018 1 0 0 }`);

  api.gumps.send(ctx.state, {
    x: 100, y: 80, layout: parts.join(''), texts,
  }, (resp) => {
    const b = resp.buttonId;
    if (b === 0) return;
    if (b >= 100 && b < 100 + SKIN_HUES.length) {
      target.hue = SKIN_HUES[b - 100];
    } else if (b >= 200 && b < 200 + HAIR_STYLES.length) {
      target.hair = HAIR_STYLES[b - 200].id;
    } else if (b >= 300 && b < 300 + HAIR_HUES.length) {
      target.hairHue = HAIR_HUES[b - 300];
    } else if (b === 9000) {
      // Randomize.
      target.hue = SKIN_HUES[(Math.random() * SKIN_HUES.length) | 0];
      target.hair = HAIR_STYLES[(Math.random() * HAIR_STYLES.length) | 0].id;
      target.hairHue = HAIR_HUES[(Math.random() * HAIR_HUES.length) | 0];
    } else if (b === 9001) {
      target.hue = SKIN_HUES[0];
      target.hair = HAIR_STYLES[0].id;
      target.hairHue = HAIR_HUES[0];
    }
    // Re-broadcast so the new look propagates to nearby clients.
    try {
      const incoming = api.protocol?.mobileIncoming?.({
        serial: target.serial, body: target.body,
        x: target.x, y: target.y, z: target.z,
        direction: target.direction ?? 0,
        hue: target.hue ?? 0, flags: target.flags ?? 0,
        notoriety: target.notoriety ?? 1, equipment: [],
      });
      if (incoming) for (const m of allMobiles(api)) {
        if (!m.client || m.map !== target.map) continue;
        if (Math.abs(m.x - target.x) > 18 || Math.abs(m.y - target.y) > 18) continue;
        m.client.sendRemove?.(target.serial);
        m.client.send(incoming);
      }
    } catch { /* tolerate */ }
    openFaceGump(api, ctx, target);   // refresh
  });
}

export default function register(api) {
  if (!api.commands) return () => {};

  api.commands.register({
    name: 'face',
    help: '[face / [face npc — open the face customization gump (NPC variant is GM-only).',
    access: 'Player',
    run(ctx) {
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      if (sub === 'npc') {
        const access = ctx.state?.account?.accessLevel ?? 'Player';
        if (access !== 'GM' && access !== 'Admin') {
          ctx.state.sendSystemMessage?.('GM only.');
          return;
        }
        ctx.state.sendSystemMessage?.('Target the NPC to customize.');
        api.targeting?.request?.(ctx.state, (picked) => {
          if (!picked?.serial) return;
          const mob = mobileBySerial(api, picked.serial >>> 0);
          if (!mob) { ctx.state.sendSystemMessage?.('Not a mobile.'); return; }
          openFaceGump(api, ctx, mob);
        });
        return;
      }
      openFaceGump(api, ctx, ctx.sender);
    },
  });

  return () => api.commands.unregister('face');
}
