import { allMobiles } from '../_spatial.js';
import { mobileBySerial } from '../_entities.js';
// Speech variants — [emote / [whisper / [yell / [me / [say
//
// Mirror ServUO `PlayerMobile.OnSpeech` types:
//   Emote   (type=2)  — *action* in asterisks, same range as Speech (12).
//   Whisper (type=8)  — range ~3, grey hue. Other players must stand close.
//   Yell    (type=9)  — range ~30, red hue. Carries across half a screen.
//   Say     (type=0)  — default speech (range 12). Provided as an alias of
//                       the normal in-game chat for parity with [say.
//   Me      (type=2)  — alias for [emote (ServUO `[me`).
//
// All five use sector-aware fan-out so a yell doesn't iterate 11.7k mobiles.

const RANGE_WHISPER = 3;
const RANGE_SPEECH  = 12;
const RANGE_YELL    = 30;

const HUE_DEFAULT = 0x03B2;
const HUE_EMOTE   = 0x025E;
const HUE_WHISPER = 0x03B2;
const HUE_YELL    = 0x0021;

function broadcast(api, sender, text, { type, range, hue, decorate }) {
  if (!text) {
    sender.client?.sendSystemMessage?.('Say what?');
    return 0;
  }
  const world = api.world;
  const sectors = world?.sectors;
  const map = sender.map;
  const sx = sender.x, sy = sender.y;
  const decorated = decorate ? decorate(text) : text;
  const pkt = api.protocol?.unicodeMessage?.({
    serial: sender.serial >>> 0, graphic: sender.body ?? 0x0190,
    type, hue, font: 3, language: 'ENU',
    name: sender.name ?? 'someone', text: decorated,
  });
  if (!pkt) return 0;
  let n = 0;
  if (sectors?.mobileSerialsNear) {
    for (const s of sectors.mobileSerialsNear(map, sx, sy, range)) {
      const m = mobileBySerial({ world }, s);
      if (!m?.client || m.map !== map) continue;
      if (Math.abs(m.x - sx) > range || Math.abs(m.y - sy) > range) continue;
      m.client.send(pkt);
      n++;
    }
  } else {
    for (const m of allMobiles({ world })) {
      if (!m.client || m.map !== map) continue;
      if (Math.abs(m.x - sx) > range || Math.abs(m.y - sy) > range) continue;
      m.client.send(pkt);
      n++;
    }
  }
  return n;
}

export default function register(api) {
  if (!api.commands) return () => {};

  api.commands.register({
    name: 'emote',
    aliases: ['me'],
    help: '[emote <text> — show an emote action *like this* to nearby players.',
    access: 'Player',
    run(ctx) {
      const text = (ctx.args ?? []).join(' ').trim();
      broadcast(api, ctx.sender, text, {
        type: 2, range: RANGE_SPEECH, hue: HUE_EMOTE,
        decorate: (t) => `*${t}*`,
      });
    },
  });
  api.commands.register({
    name: 'whisper',
    help: '[whisper <text> — say something heard only within ~3 tiles.',
    access: 'Player',
    run(ctx) {
      const text = (ctx.args ?? []).join(' ').trim();
      broadcast(api, ctx.sender, text, {
        type: 8, range: RANGE_WHISPER, hue: HUE_WHISPER,
      });
    },
  });

  api.commands.register({
    name: 'yell',
    help: '[yell <text> — shout something heard across ~30 tiles.',
    access: 'Player',
    run(ctx) {
      const text = (ctx.args ?? []).join(' ').trim();
      broadcast(api, ctx.sender, text, {
        type: 9, range: RANGE_YELL, hue: HUE_YELL,
        decorate: (t) => t.toUpperCase(),
      });
    },
  });

  api.commands.register({
    name: 'say',
    help: '[say <text> — speak normally to nearby players.',
    access: 'Player',
    run(ctx) {
      const text = (ctx.args ?? []).join(' ').trim();
      broadcast(api, ctx.sender, text, {
        type: 0, range: RANGE_SPEECH, hue: HUE_DEFAULT,
      });
    },
  });

  return () => {
    for (const n of ['emote', 'whisper', 'yell', 'say']) {
      api.commands.unregister(n);
    }
  };
}
