// PHASE CU — Animal Lore + Arms Lore + Item Identification.
//
// Three thin skill commands that target a creature/item and print a
// stat dump as system messages. ServUO opens dedicated gumps for
// Animal Lore (Skills/AnimalLore.cs) and Arms Lore (Skills/ArmsLore.cs)
// — we ship them as multi-line journal output for now; gumpification
// is a follow-up.
//
// Skill IDs (skills.json canonical, fixed 2026-05-16):
//   Animal Lore         = 3   (was 2 = Anatomy)
//   Item Identification = 4   (was 23 = Provocation)
//   Arms Lore           = 5   (was 4 = Item Identification)
// Prior values landed every gain on the wrong slot and rolled the wrong
// skill on every check.

import { normalizeSkillValue } from '../_rules.js';
import { itemBySerial, mobileBySerial } from '../_entities.js';

const SKILL_ANIMAL_LORE = 3;
const SKILL_ARMS_LORE   = 5;
const SKILL_ITEM_ID     = 4;
const RANGE = 6;

export default function register(api) {
  if (!api.commands || !api.targeting) return () => {};

  function withinRange(a, b, range = RANGE) {
    if (a.map !== b.map) return false;
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= range;
  }

  function skillOf(mob, id) {
    if (!mob?.skills) return 0;
    return normalizeSkillValue(mob.skills[id] ?? mob.skills[String(id)] ?? 0);
  }

  // ── Animal Lore ────────────────────────────────────────────────
  api.commands.register({
    name: 'lore',
    help: '[lore — target a creature to read its stats and bonded status.',
    access: 'Player',
    run(ctx) {
      ctx.state.sendSystemMessage('What creature do you wish to study?');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked?.serial) {
          ctx.state.sendSystemMessage('You decide against it.');
          return;
        }
        const mob = mobileBySerial(api, picked.serial >>> 0);
        if (!mob) { ctx.state.sendSystemMessage('That isn\'t there.'); return; }
        if (mob.client) { ctx.state.sendSystemMessage('You can not gain insight into another player.'); return; }
        if (!withinRange(ctx.sender, mob)) { ctx.state.sendSystemMessage('That is too far away.'); return; }
        const cfg = api.monsters?.get?.(mob.kind) ?? api.npcs?.get?.(mob.kind) ?? null;
        const tameable = mob.tameable ?? cfg?.tameable ?? false;
        const skill = skillOf(ctx.sender, SKILL_ANIMAL_LORE);
        const required = cfg?.tameMinSkill ?? 0;
        if (skill < required - 20) {
          ctx.state.sendSystemMessage('You have no idea what manner of creature this is.');
          api.skillGain?.tryGain?.(ctx.sender, SKILL_ANIMAL_LORE, required, required + 30);
          return;
        }
        api.skillGain?.tryGain?.(ctx.sender, SKILL_ANIMAL_LORE, required, required + 30);
        const owner = mob.controlMaster
          ? mobileBySerial(api, mob.controlMaster >>> 0)?.name ?? 'an unknown master'
          : null;
        const lines = [
          `═══ ${mob.name ?? 'creature'} ═══`,
          `Kind: ${mob.kind ?? '???'}${tameable ? ' (tameable)' : ''}`,
          `Body: 0x${(mob.body ?? 0).toString(16)}    Hue: 0x${(mob.hue ?? 0).toString(16)}`,
          `HP: ${mob.hp ?? 0}/${mob.hpMax ?? 0}`,
          `Str/Dex/Int: ${mob.str ?? '-'} / ${mob.dex ?? '-'} / ${mob.int ?? '-'}`,
        ];
        if (tameable) {
          lines.push(`Taming required: ${cfg?.tameMinSkill ?? '-'} (max ${cfg?.tameMaxSkill ?? '-'})`);
        }
        if (owner) lines.push(`Master: ${owner}`);
        if (mob.petCommand) lines.push(`Currently obeying: ${mob.petCommand}`);
        // Server parity #9 #7 — full ServUO AnimalLoreGump output:
        // resistances, damage range, AI archetype, hunger/loyalty.
        const r = mob.resists ?? {};
        const rEntries = [];
        if (r.phys != null)   rEntries.push(`Phys ${r.phys}`);
        if (r.fire != null)   rEntries.push(`Fire ${r.fire}`);
        if (r.cold != null)   rEntries.push(`Cold ${r.cold}`);
        if (r.poison != null) rEntries.push(`Poison ${r.poison}`);
        if (r.energy != null) rEntries.push(`Energy ${r.energy}`);
        if (rEntries.length > 0) lines.push(`Resists: ${rEntries.join(' / ')}`);
        if (cfg?.damageMin != null && cfg?.damageMax != null) {
          lines.push(`Damage: ${cfg.damageMin}..${cfg.damageMax}`);
        }
        const aiTag = mob.ai ?? cfg?.behavior ?? mob._behavior;
        if (aiTag) lines.push(`AI: ${aiTag}`);
        if (mob.controlMaster) {
          lines.push(`Hunger: ${mob.hunger ?? 18}/18    Loyalty: ${mob.loyalty ?? 100}`);
        }
        if (mob.bonded) lines.push('Status: bonded');
        if (cfg?.slayerVuln) lines.push(`Vulnerable to: ${cfg.slayerVuln}`);
        for (const line of lines) ctx.state.sendSystemMessage(line);
      }, { kind: 0 /* mobile */ });
    },
  });

  // ── Arms Lore ──────────────────────────────────────────────────
  api.commands.register({
    name: 'armslore',
    help: '[armslore — inspect a weapon or armor to gauge its quality.',
    access: 'Player',
    run(ctx) {
      ctx.state.sendSystemMessage('What item do you wish to inspect?');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked?.serial) { ctx.state.sendSystemMessage('You shrug.'); return; }
        const item = itemBySerial(api, picked.serial >>> 0);
        if (!item) { ctx.state.sendSystemMessage('That isn\'t there.'); return; }
        const skill = skillOf(ctx.sender, SKILL_ARMS_LORE);
        api.skillGain?.tryGain?.(ctx.sender, SKILL_ARMS_LORE, 0, 100);
        const name = item.name ?? `item 0x${(item.itemId ?? 0).toString(16)}`;
        // Quality verbs scale with skill — basic ServUO Arms Lore output.
        const tier = skill >= 90 ? 'masterfully crafted' :
                     skill >= 70 ? 'finely made' :
                     skill >= 50 ? 'sturdy' :
                     skill >= 30 ? 'simple' : 'crude';
        ctx.state.sendSystemMessage(`You inspect the ${name}: it is ${tier}.`);
        if (item.crafter) ctx.state.sendSystemMessage(`Crafted by: ${item.crafter}`);
        if (item.quality === 'exceptional') {
          ctx.state.sendSystemMessage('It bears the mark of an exceptional craftsman.');
        }
        if (item.weight != null) ctx.state.sendSystemMessage(`Weight: ${item.weight} stones.`);
      }, { kind: 1 /* item */ });
    },
  });

  // ── Item Identification ────────────────────────────────────────
  api.commands.register({
    name: 'itemid',
    help: '[itemid — identify magic properties on an item.',
    access: 'Player',
    run(ctx) {
      ctx.state.sendSystemMessage('What do you wish to identify?');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked?.serial) { ctx.state.sendSystemMessage('You decide against it.'); return; }
        const item = itemBySerial(api, picked.serial >>> 0);
        if (!item) { ctx.state.sendSystemMessage('That isn\'t there.'); return; }
        const skill = skillOf(ctx.sender, SKILL_ITEM_ID);
        api.skillGain?.tryGain?.(ctx.sender, SKILL_ITEM_ID, 0, 100);
        // Identifying flags on the item — magic / poison / power-scroll.
        const props = [];
        if (item.poisoned)        props.push('It is coated in poison.');
        if (item.bod)             props.push(`Bulk Order Deed: ${item.bod.label}`);
        if (item.powerScroll)     props.push(`Power Scroll: +${item.powerScroll.amount} skill cap`);
        if (item.spellSlug)       props.push(`Inscribed with: ${item.spellSlug}`);
        if (item.script === 'magic-scroll' && !item.spellSlug) {
          props.push('A blank magic scroll.');
        }
        if (props.length === 0) {
          if (skill >= 60) ctx.state.sendSystemMessage('You sense no magic upon it.');
          else             ctx.state.sendSystemMessage('You can\'t make out anything special.');
          return;
        }
        if (skill < 30) {
          ctx.state.sendSystemMessage('You sense magic upon it but can\'t parse the runes.');
          return;
        }
        ctx.state.sendSystemMessage(`Item analysis (${item.name ?? 'item'}):`);
        for (const p of props) ctx.state.sendSystemMessage(`  ${p}`);
      }, { kind: 1 /* item */ });
    },
  });

  return () => {
    api.commands.unregister('lore');
    api.commands.unregister('armslore');
    api.commands.unregister('itemid');
  };
}
