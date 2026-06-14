// Master Storyteller NPC — port of ServUO `Engines/Storyteller/`.
//
// A tavern-bound NPC who, when greeted with "tell me a story", begins
// a 2-3 minute scripted monologue picked from a rotating tale pool.
// Listening from start to finish grants a small Compassion virtue tick
// + a 5-min "well-rested" status effect (regen bonus). Players can
// have only ONE story going at a time; trying to start another while
// one's running re-broadcasts the current tale.
//
// Spawn at any tavern via `[storyteller spawn` (Admin); the canonical
// shard ships one at the Britain Brittany Inn coordinate.

// Tale pool + cadence — `data/world/spawns/storyteller-tales.json`.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { allMobiles } from '../_spatial.js';
import { canCreateMobile, createMobile } from '../_mobiles.js';

const __HERE = path.dirname(url.fileURLToPath(import.meta.url));
const __DATA = path.resolve(__HERE, '../data/world/spawns/storyteller-tales.json');

let __CFG = { stories: [], lineDelayMs: 30_000 };
try { __CFG = { ...__CFG, ...JSON.parse(fs.readFileSync(__DATA, 'utf8')) }; }
catch (e) { console.warn('[storyteller] tales load failed:', e.message); }

const STORIES = __CFG.stories;
const LINE_DELAY_MS = __CFG.lineDelayMs;

function speakLineOverhead(api, npc, text) {
  const pkt = api.protocol?.unicodeMessage?.({
    text,
    hue: 0x481, font: 3, name: npc.name ?? 'Storyteller',
  });
  if (!pkt) return;
  // Broadcast within hearing range (12 tiles).
  for (const m of allMobiles(api)) {
    if (!m.client) continue;
    if (m.map !== npc.map) continue;
    if (Math.abs(m.x - npc.x) > 12 || Math.abs(m.y - npc.y) > 12) continue;
    m.client.send(pkt);
  }
}

function startStory(api, npc) {
  if (npc._storyActive) return false;
  const story = STORIES[(Math.random() * STORIES.length) | 0];
  npc._storyActive = true;
  npc._storyTitle = story.title;
  let lineIdx = 0;
  const tick = () => {
    if (lineIdx === 0) {
      speakLineOverhead(api, npc, `*clears throat* "Gather 'round — I shall tell ye of: ${story.title}."`);
    }
    if (lineIdx >= story.lines.length) {
      speakLineOverhead(api, npc, '"…and that, my friends, is the tale."');
      // Reward — Compassion tick + status effect to all players within
      // hearing range.
      for (const m of allMobiles(api)) {
        if (!m.client) continue;
        if (m.map !== npc.map) continue;
        if (Math.abs(m.x - npc.x) > 12 || Math.abs(m.y - npc.y) > 12) continue;
        try { api.systems?.virtues?.awardVirtue?.(m, 'compassion', 10); }
        catch { /* virtues optional */ }
        try { api.statusEffects?.apply?.(m, {
          name: 'well-rested', durationMs: 5 * 60 * 1000,
          regenHp: 1, regenMana: 1, regenStam: 1,
        }); } catch { /* effects optional */ }
        m.client.sendSystemMessage?.('You feel inspired by the tale.');
      }
      npc._storyActive = false;
      return;
    }
    speakLineOverhead(api, npc, story.lines[lineIdx++]);
    setTimeout(tick, LINE_DELAY_MS).unref?.();
  };
  tick();
  return true;
}

function placeStoryteller(api, x, y, z, map) {
  if (!canCreateMobile(api, api.world)) return null;
  try {
    const npc = createMobile(api, api.world, {
      name: 'Master Storyteller',
      body: 0x0190, hue: 0x0481,
      x, y, z, map,
      hp: 100, hpMax: 100,
      notoriety: 2,                  // Townfolk
      kind: 'storyteller',
    });
    if (npc) {
      npc._storyteller = true;
      npc.flags = (npc.flags | 0) | 0x10;        // frozen
    }
    return npc;
  } catch (e) {
    api.log?.(`[storyteller] spawn threw: ${e.message}`);
    return null;
  }
}

export default function register(api) {
  if (!api.commands || !api.world) return () => {};

  // Place one at the Britain inn on boot.
  (api.lifecycle?.setImmediate ?? setImmediate)(() => placeStoryteller(api, 1496, 1624, 10, 1));

  api.commands.register({
    name: 'storyteller',
    help: '[storyteller spawn|tell — manage / interact with the Master Storyteller.',
    access: 'Player',
    run(ctx) {
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      const mob = ctx.sender;

      if (sub === 'spawn') {
        const access = ctx.state?.account?.accessLevel ?? 'Player';
        if (access !== 'GM' && access !== 'Admin') {
          ctx.state.sendSystemMessage?.('GM only.');
          return;
        }
        const npc = placeStoryteller(api, mob.x, mob.y, mob.z, mob.map ?? 1);
        ctx.state.sendSystemMessage?.(
          npc ? `Storyteller placed.` : 'Spawn failed.',
        );
        return;
      }

      if (sub === 'tell') {
        // Find a nearby storyteller within 6 tiles.
        let teller = null;
        for (const m of allMobiles(api)) {
          if (!m._storyteller) continue;
          if (m.map !== mob.map) continue;
          if (Math.max(Math.abs(m.x - mob.x), Math.abs(m.y - mob.y)) > 6) continue;
          teller = m; break;
        }
        if (!teller) {
          ctx.state.sendSystemMessage?.('No storyteller within earshot.');
          return;
        }
        if (teller._storyActive) {
          ctx.state.sendSystemMessage?.(`A story is already underway: "${teller._storyTitle}".`);
          return;
        }
        startStory(api, teller);
        ctx.state.sendSystemMessage?.('The storyteller clears their throat…');
        return;
      }

      ctx.state.sendSystemMessage?.('Usage: [storyteller spawn|tell');
    },
  });

  return () => api.commands.unregister('storyteller');
}
