import { spawnNPC } from './_spawn.js';
import { normalizeSkillValue } from '../../_rules.js';
import { packItems } from '../../_inventory.js';
import { destroyItemBySerial } from '../../_items.js';

// Trainer NPC — port of ServUO `Engines/SkillTeachers/SBSkillTeacher.cs`.
//
// A trainer says "I can teach you <skills>" when a nearby player speaks
// a relevant keyword ("teach", "train", or the skill name itself), then
// raises the player's base skill to a cap of 30.0 in exchange for gold.
// ServUO charges by gap-to-cap; we use a flat 25 gold per teaching call.
//
// Each spawned trainer carries a `teaches: number[]` (skill IDs) on the
// mob. The speech hook reads `mob._heardSpeech` (filled by handleUnicode-
// Speech in handlers.js — same queue the Banker uses).
//
// Trainer kinds:
//   combat-trainer    Tactics + Anatomy + Parrying + Wrestling
//   weapon-trainer    Swordsmanship + Mace Fighting + Fencing + Archery
//   magery-trainer    Magery + Eval Int + Resisting Spells + Meditation
//   craft-trainer     Tailoring + Blacksmithy + Carpentry + Tinkering
//   thief-trainer     Stealing + Snooping + Hiding + Stealth + Lockpicking
//   bard-trainer      Musicianship + Discordance + Peacemaking + Provocation
//
// Spawn with `[trainer <kind>` admin command at GM accessLevel.

const HEAR_RANGE = 6;
const TEACH_CAP = 30; // 30.0 — ServUO trainer ceiling
const TEACH_COST_GOLD = 25;

const TRAINER_KINDS = {
  'combat-trainer':  { name: 'Combat Trainer', body: 0x0190, hue: 0x83EA, teaches: [28, 2, 6, 44] },
  'weapon-trainer':  { name: 'Weapon Trainer', body: 0x0190, hue: 0x03E2, teaches: [41, 42, 43, 32] },
  'magery-trainer':  { name: 'Mage Trainer',   body: 0x0191, hue: 0x0455, teaches: [26, 17, 27, 47] },
  'craft-trainer':   { name: 'Craft Trainer',  body: 0x0191, hue: 0x0353, teaches: [35, 8, 12, 38] },
  'thief-trainer':   { name: 'Thief Trainer',  body: 0x0190, hue: 0x023F, teaches: [34, 29, 22, 48, 25] },
  'bard-trainer':    { name: 'Bard Trainer',   body: 0x0191, hue: 0x0396, teaches: [30, 16, 10, 23] },
  // Special-move trainers — AoS / SE / SA / ML expansion skills. Each
  // teaches one or two of: Chivalry(52), Bushido(53), Ninjitsu(54),
  // Necromancy(50), Spellweaving(55), Mysticism(56), Imbuing(57),
  // Throwing(58). See `apps/scripts/src/data/config/skills.json`.
  'chivalry-trainer':    { name: 'Paladin Trainer', body: 0x0190, hue: 0x07A1, teaches: [52, 18] },
  'samurai-trainer':     { name: 'Samurai Trainer', body: 0x0190, hue: 0x47E,  teaches: [53, 6] },     // Bushido + Parrying
  'ninja-trainer':       { name: 'Ninja Trainer',   body: 0x0190, hue: 0x0455, teaches: [54, 22, 48] }, // Ninjitsu + Hiding + Stealth
  'necromancer-trainer': { name: 'Necromancer Trainer', body: 0x0191, hue: 0x0488, teaches: [50, 33] }, // Necromancy + Spirit Speak
  'spellweaver-trainer': { name: 'Arcanist Trainer', body: 0x0191, hue: 0x0500, teaches: [55, 26] },    // Spellweaving + Magery (req)
  'mystic-trainer':      { name: 'Mystic Trainer',  body: 0x029A, hue: 0,      teaches: [56, 17] },    // Mysticism + Eval Int
  'imbuing-trainer':     { name: 'Imbuing Trainer', body: 0x029B, hue: 0,      teaches: [57, 1, 24] }, // Imbuing + Alchemy + Inscription
  'throwing-trainer':    { name: 'Throwing Trainer', body: 0x029A, hue: 0,     teaches: [58, 28] },    // Throwing + Tactics
};

// Skill name → id, lowercase keys. Used to match player speech against a
// teachable skill. Keep aligned with skills.json (1-based).
const SKILL_NAME_TO_ID = {
  'alchemy': 1, 'anatomy': 2, 'animal lore': 3, 'arms lore': 5,
  'parrying': 6, 'begging': 7, 'blacksmithy': 8, 'bowcraft': 9, 'fletching': 9,
  'peacemaking': 10, 'camping': 11, 'carpentry': 12, 'cartography': 13,
  'cooking': 14, 'detect hidden': 15, 'discordance': 16,
  'evaluating intelligence': 17, 'eval int': 17, 'evalint': 17,
  'healing': 18, 'fishing': 19, 'forensic evaluation': 20, 'herding': 21,
  'hiding': 22, 'provocation': 23, 'inscription': 24, 'lockpicking': 25,
  'magery': 26, 'resisting spells': 27, 'resist': 27, 'tactics': 28,
  'snooping': 29, 'musicianship': 30, 'poisoning': 31, 'archery': 32,
  'spirit speak': 33, 'stealing': 34, 'tailoring': 35, 'animal taming': 36,
  'taste id': 37, 'tinkering': 38, 'tracking': 39, 'veterinary': 40,
  'swordsmanship': 41, 'mace fighting': 42, 'fencing': 43, 'wrestling': 44,
  'lumberjacking': 45, 'mining': 46, 'meditation': 47, 'stealth': 48,
  'remove trap': 49, 'necromancy': 50, 'focus': 51, 'chivalry': 52,
  'bushido': 53, 'ninjitsu': 54, 'spellweaving': 55, 'mysticism': 56,
  'imbuing': 57, 'throwing': 58,
};

function distance(a, b) { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); }

function destroyWorldItem(api, item) {
  if (!item) return;
  destroyItemBySerial(api, item.serial);
}

function debitPackGold(api, mob, amount) {
  const piles = [...packItems(api, mob)]
    .filter((item) => item.itemId === 0x0EED && (item.amount ?? 1) > 0);
  if (piles.reduce((sum, item) => sum + (item.amount ?? 1), 0) < amount) return false;
  let remaining = amount;
  for (const pile of piles) {
    if (remaining <= 0) break;
    const available = pile.amount ?? 1;
    const take = Math.min(available, remaining);
    pile.amount = available - take;
    remaining -= take;
    if (pile.amount <= 0) {
      destroyWorldItem(api, pile);
      mob.client?.send?.(api.protocol.removeEntity(pile.serial));
    } else {
      mob.client?.send?.(api.protocol.containerContentUpdate({
        serial: pile.serial, itemId: pile.itemId, amount: pile.amount,
        hue: pile.hue ?? 0, gridX: pile.gridX ?? 0, gridY: pile.gridY ?? 0,
        gridLocation: pile.gridLocation ?? 0,
      }, pile.parent ?? mob.serial));
    }
  }
  return remaining === 0;
}

export default function register(api) {
  if (!api.commands || !api.protocol) return () => {};

  api.ai?.registerBehavior?.({
    name: 'trainer',
    initState() { return { lastSpeak: 0, lastTeach: 0 }; },
    tick(ctx, mob, state) {
      const queue = mob._heardSpeech;
      if (!queue || queue.length === 0) return;
      const now = ctx.now;
      while (queue.length > 0) {
        const entry = queue.shift();
        if (!entry?.speaker || !entry.text) continue;
        const speaker = entry.speaker;
        if (!speaker.client) continue;
        if (distance(speaker, mob) > HEAR_RANGE) continue;
        if (speaker.map !== mob.map) continue;
        const text = String(entry.text).toLowerCase();

        // Greeting prompts ("teach", "train", "skills") — list teachable
        // skills via overhead speech. Throttled to once per 4s per
        // trainer so a chatty player can't flood the channel.
        if ((text.includes('teach') || text.includes('train') || text.includes('skill'))
            && now - state.lastSpeak >= 4_000) {
          state.lastSpeak = now;
          const names = (mob.teaches ?? [])
            .map((id) => api.skills?.byId?.get?.(id)?.name ?? `skill ${id}`)
            .join(', ');
          ctx.broadcastSpeech?.(mob, `I can teach you: ${names}. Say a skill's name to learn.`, 0x35);
          continue;
        }

        // Skill-name match — find a teachable skill the player named.
        let askedSkill = null;
        for (const [name, id] of Object.entries(SKILL_NAME_TO_ID)) {
          if (!text.includes(name)) continue;
          if (!mob.teaches?.includes(id)) continue;
          askedSkill = id; break;
        }
        if (askedSkill == null) continue;
        if (now - state.lastTeach < 2_000) continue;
        state.lastTeach = now;

        // Check player's current skill — refuse if already at/above the
        // teaching cap (30.0).
        const rawCur = (speaker.skills?.[askedSkill]
                     ?? speaker.skills?.[String(askedSkill)]
                     ?? 0);
        const cur = normalizeSkillValue(rawCur);
        if (cur >= TEACH_CAP) {
          ctx.broadcastSpeech?.(mob, 'You already know all I can teach.', 0x35);
          continue;
        }
        // Charge gold.
        if (!debitPackGold(api, speaker, TEACH_COST_GOLD)) {
          ctx.broadcastSpeech?.(mob, `That will cost you ${TEACH_COST_GOLD} gold. Bring it and try again.`, 0x35);
          continue;
        }
        // Teach to 30.0 if below; otherwise nudge by 1.
        speaker.skills ??= {};
        speaker.skills[askedSkill] = Math.max(cur, TEACH_CAP);
        const skillName = api.skills?.byId?.get?.(askedSkill)?.name ?? `skill ${askedSkill}`;
        ctx.broadcastSpeech?.(mob, `${skillName} — let me show you the basics.`, 0x35);
        speaker.client.sendSystemMessage?.(`You learn ${skillName} (now ${(speaker.skills[askedSkill]).toFixed(1)}).`);
      }
    },
  });

  api.commands.register({
    name: 'trainer',
    help: '[trainer <combat|weapon|magery|craft|thief|bard> — spawn a skill trainer.',
    access: 'Admin',
    run(ctx) {
      const kind = String(ctx.args[0] ?? '').toLowerCase();
      const cfgKey = kind.endsWith('-trainer') ? kind : `${kind}-trainer`;
      const cfg = TRAINER_KINDS[cfgKey];
      if (!cfg) {
        ctx.state.sendSystemMessage(`Unknown trainer kind. Try: ${Object.keys(TRAINER_KINDS).join(', ')}`);
        return;
      }
      // BUGFIX #44 (PHASE CB): same fix as banker — was created without
      // mobileIncoming broadcast and naked. Routes through spawnNPC.
      const lcSkillNames = (cfg.teaches || [])
        .map((id) => (api.skills?.byId?.get?.(id)?.name ?? '').toLowerCase())
        .filter(Boolean);
      const mob = spawnNPC(api, ctx.sender, {
        name: cfg.name, body: cfg.body, hue: cfg.hue,
        kind: 'trainer', outfit: 'mage',
        keywords: ['teach', 'train', ...lcSkillNames],
        behavior: 'trainer',
        fields: { teaches: cfg.teaches },
      });
      ctx.state.sendSystemMessage(
        `${cfg.name} 0x${mob.serial.toString(16)} spawned (teaches: ${cfg.teaches.length} skills).`,
      );
    },
  });

  return () => {
    api.ai?.unregisterBehavior?.('trainer');
    api.commands.unregister('trainer');
  };
}
