// `[track` — Tracking skill (id 39).
//
// ServUO `Skills/Tracking.cs`: scans nearby mobiles within
//   `(skill * 0.2) + 10` tiles
// and lists their names + cardinal direction. Higher skill widens the
// search; success on each individual mobile gates by skill check.

// Audit #41 P1 #6 — Tracking is skill id 39 (skill 38 = Tinkering).
// Was: a 100-Tinker / 0-Track player tracked farther than a GM tracker.
import { normalizeSkillValue } from '../_rules.js';
import { allMobiles } from '../_spatial.js';

const SKILL_TRACKING = 39;
const COOLDOWN_MS = 6000;
const cooldown = new WeakMap();

function dirOf(dx, dy) {
  // 8-way cardinal ordered by atan2.
  const labels = ['E','SE','S','SW','W','NW','N','NE'];
  const a = Math.atan2(dy, dx);
  return labels[(Math.round(a / (Math.PI / 4)) + 8) & 7];
}

export default function register(api) {
  if (!api.commands || !api.world) return () => {};
  api.commands.register({
    name: 'track',
    help: '[track — find nearby mobiles by direction.',
    access: 'Player',
    run(ctx) {
      const sender = ctx.sender;
      const now = Date.now();
      const last = cooldown.get(sender) ?? 0;
      if (now - last < COOLDOWN_MS) {
        ctx.state.sendSystemMessage('You must rest before tracking again.');
        return;
      }
      // Audit #37 P3 #2 — class filter. ServUO opens a `TrackWhatGump`
      // with 4 buttons (Animal/Monster/Human-NPC/Player) and filters
      // by body kind. We collapse to a subcommand: `[track <kind>` ∈
      // animals / monsters / npcs / players. Falls through to "all"
      // when no kind given (legacy MVP behaviour).
      const subKind = String(ctx.args?.[0] ?? '').toLowerCase();
      const classFilter = (m) => {
        const b = m.body | 0;
        const isHumanoid = (b >= 0x190 && b <= 0x193)
                        || (b === 0x025D || b === 0x025E)
                        || (b === 0x029A || b === 0x029B);
        const isPlayer = !!m.client;
        const isAnimal = !isHumanoid && !isPlayer
                      && (b >= 0x00D0 && b <= 0x01F0);   // CUO BodyType.Animal range
        const isMonster = !isHumanoid && !isPlayer && !isAnimal;
        if (subKind === 'animals')  return isAnimal;
        if (subKind === 'monsters') return isMonster;
        if (subKind === 'npcs')     return isHumanoid && !isPlayer;
        if (subKind === 'players')  return isPlayer;
        return true;     // no filter
      };
      const skill = normalizeSkillValue(
        sender.skills?.[SKILL_TRACKING] ?? sender.skills?.[String(SKILL_TRACKING)] ?? 0,
      );
      const range = 10 + Math.floor(skill * 0.2);
      const found = [];
      const iter = api.game?.mobilesNear?.(sender, { range, self: sender })
        ?? api.query?.mobilesNear?.(sender, range, sender)
        ?? allMobiles({ world: ctx.world });
      for (const m of iter) {
        if (m === sender) continue;
        if (m.map !== sender.map) continue;
        if (!classFilter(m)) continue;
        const dx = m.x - sender.x, dy = m.y - sender.y;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        if (dist > range) continue;
        // Hidden mobiles need `Detect Hidden` or higher Tracking.
        if (m.hidden && skill < 80) continue;
        // Skill check per-target — failures show up as "you sense
        // something nearby" without revealing identity.
        if (Math.random() * 100 > Math.max(20, skill / 1.2)) {
          found.push({ name: '?', dist, dir: dirOf(dx, dy) });
          continue;
        }
        found.push({ name: m.name ?? `0x${m.serial.toString(16)}`, dist, dir: dirOf(dx, dy) });
      }
      cooldown.set(sender, now);
      if (found.length === 0) {
        ctx.state.sendSystemMessage('You find no signs of life nearby.');
        return;
      }
      found.sort((a, b) => a.dist - b.dist);
      sender._trackingInfo = {
        at: now,
        range,
        kind: subKind || 'all',
        results: found.slice(0, 12).map((f) => ({ name: f.name, dist: f.dist, dir: f.dir })),
      };
      sender.servuoClasses = [...new Set([...(sender.servuoClasses ?? []), 'TrackTimer'])];
      ctx.state.sendSystemMessage(`You spot ${found.length} creature(s):`);
      for (const f of found.slice(0, 12)) {
        ctx.state.sendSystemMessage(`  ${f.name} — ${f.dist} tiles ${f.dir}`);
      }
      api.skillGain?.tryGain?.(sender, SKILL_TRACKING, 60);
    },
  });
  return () => api.commands.unregister('track');
}
