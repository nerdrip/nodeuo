// `[enhance` — ServUO `Items/Resources/Misc/Enhance.cs` material upgrade.
//
// Target a crafted weapon / armor / shield in pack, plus a material
// ingot resource. The item's `material` field is upgraded to the new
// material if the player has skill ≥ thresholds; on failure the item
// shatters (5..10% chance scaling with skill margin).
//
// Available materials:
//   - blacksmith: dull-copper, shadow-iron, copper, bronze, gold,
//                 agapite, verite, valorite
//   - tailoring:  spined-leather, horned-leather, barbed-leather
//   - carpentry:  oak-board, ash-board, yew-board, heartwood-board,
//                 bloodwood-board
//
// Material → resist bonus mapping mirrors ServUO `CraftResource`. Each
// material has a `skillReq` (minimum craft skill) + `breakChance`
// (failure penalty even at cap).

import { normalizeSkillValue } from '../../_rules.js';
import { findInPack, isPackedOrWorn } from '../../_inventory.js';
import { destroyItemBySerial } from '../../_items.js';
import { allItems } from '../../_spatial.js';
import { itemBySerial } from '../../_entities.js';

const SKILL_BLACKSMITHY = 8;
const SKILL_TAILORING   = 35;
const SKILL_CARPENTRY   = 12;
const SKILL_FORGE_RANGE = 2;
const FORGE_IDS = new Set([0x1985, 0x1986, 0x1987, 0x1988, 0x1995, 0x1996, 0x1997, 0x1998, 0x1999, 0x199A]);

const MATERIALS = {
  // Metals (blacksmithy / tinker).
  'dull-copper-ingot':  { material: 'dull copper',  skill: SKILL_BLACKSMITHY, skillReq: 65,  hueShift: 0x973 },
  'shadow-iron-ingot':  { material: 'shadow iron',  skill: SKILL_BLACKSMITHY, skillReq: 70,  hueShift: 0x966 },
  'copper-ingot':       { material: 'copper',       skill: SKILL_BLACKSMITHY, skillReq: 75,  hueShift: 0x96D },
  'bronze-ingot':       { material: 'bronze',       skill: SKILL_BLACKSMITHY, skillReq: 80,  hueShift: 0x972 },
  'gold-ingot':         { material: 'gold',         skill: SKILL_BLACKSMITHY, skillReq: 85,  hueShift: 0x8A5 },
  'agapite-ingot':      { material: 'agapite',      skill: SKILL_BLACKSMITHY, skillReq: 90,  hueShift: 0x979 },
  'verite-ingot':       { material: 'verite',       skill: SKILL_BLACKSMITHY, skillReq: 95,  hueShift: 0x89F },
  'valorite-ingot':     { material: 'valorite',     skill: SKILL_BLACKSMITHY, skillReq: 100, hueShift: 0x8AB },
  // Leather (tailoring).
  'spined-leather':     { material: 'spined',       skill: SKILL_TAILORING,   skillReq: 65,  hueShift: 0x8AC },
  'horned-leather':     { material: 'horned',       skill: SKILL_TAILORING,   skillReq: 80,  hueShift: 0x845 },
  'barbed-leather':     { material: 'barbed',       skill: SKILL_TAILORING,   skillReq: 100, hueShift: 0x851 },
  // Wood (carpentry / fletching).
  'oak-board':          { material: 'oak',          skill: SKILL_CARPENTRY,   skillReq: 65,  hueShift: 0x7DA },
  'ash-board':          { material: 'ash',          skill: SKILL_CARPENTRY,   skillReq: 80,  hueShift: 0x4A7 },
  'yew-board':          { material: 'yew',          skill: SKILL_CARPENTRY,   skillReq: 95,  hueShift: 0x4A8 },
  'heartwood-board':    { material: 'heartwood',    skill: SKILL_CARPENTRY,   skillReq: 100, hueShift: 0x4A9 },
  'bloodwood-board':    { material: 'bloodwood',    skill: SKILL_CARPENTRY,   skillReq: 100, hueShift: 0x4AA },
};

function skillOf(mob, id) {
  const raw = mob?.skills?.[id] ?? mob?.skills?.[String(id)] ?? 0;
  return normalizeSkillValue(raw);
}

export default function register(api) {
  if (!api.commands || !api.world) return () => {};

  api.commands.register({
    name: 'enhance',
    help: '[enhance <ingot-kind> — upgrade your worn / packed crafted item to the named material.',
    access: 'Player',
    run(ctx) {
      const mob = ctx.sender;
      const resourceKind = String(ctx.args[0] ?? '').toLowerCase();
      const mat = MATERIALS[resourceKind];
      if (!mat) {
        ctx.state.sendSystemMessage(`Usage: [enhance <ingot-kind>. Known: ${Object.keys(MATERIALS).join(', ')}.`);
        return;
      }
      const skill = skillOf(mob, mat.skill);
      if (skill < mat.skillReq) {
        ctx.state.sendSystemMessage(`You lack the skill (${mat.skillReq}+) to enhance with ${resourceKind}.`);
        return;
      }
      // Blacksmithing-bound materials require forge proximity.
      if (mat.skill === SKILL_BLACKSMITHY) {
        let nearForge = false;
        const iter = api.game?.itemsNear?.(mob, { range: SKILL_FORGE_RANGE })
          ?? api.query?.itemsNear?.(mob, SKILL_FORGE_RANGE)
          ?? allItems(api);
        for (const it of iter) {
          if (!FORGE_IDS.has(it.itemId)) continue;
          if (it.parent) continue;
          if (it.map !== mob.map) continue;
          if (Math.abs(it.x - mob.x) <= SKILL_FORGE_RANGE && Math.abs(it.y - mob.y) <= SKILL_FORGE_RANGE) {
            nearForge = true; break;
          }
        }
        if (!nearForge) {
          ctx.state.sendSystemMessage('You must stand near a forge to enhance metal items.');
          return;
        }
      }
      // Require resource in pack.
      const resource = findInPack(api, mob, (it) => it.kind === resourceKind && (it.amount | 0) >= 1);
      if (!resource) {
        ctx.state.sendSystemMessage(`You need a ${resourceKind} in your pack.`);
        return;
      }
      ctx.state.sendSystemMessage('Target the item to enhance.');
      api.targeting.request(ctx.state, (picked) => {
        if (!picked?.serial) return;
        const item = itemBySerial(api, picked.serial >>> 0);
        if (!item) { ctx.state.sendSystemMessage('Not an item.'); return; }
        if (!isPackedOrWorn(api, item, mob)) {
          ctx.state.sendSystemMessage('The item must be in your pack or worn.');
          return;
        }
        if (item.material && item.material !== 'iron' && item.material !== '') {
          ctx.state.sendSystemMessage('That item has already been enhanced.');
          return;
        }
        // Consume one charge of the resource regardless of outcome.
        if (resource.amount > 1) {
          resource.amount -= 1;
          try { api.broadcast?.itemUpdate?.(api.world, resource); } catch { /* advisory */ }
        } else {
          try { destroyItemBySerial(api, resource.serial); } catch { /* */ }
        }
        // Roll for success. Margin above skillReq gives bonus; minimum
        // 25% success at cap req, peaking at 95%.
        const margin = skill - mat.skillReq;
        const chance = Math.max(0.25, Math.min(0.95, 0.40 + margin / 100));
        if (Math.random() < chance) {
          item.material = mat.material;
          item.hue = mat.hueShift;
          // Bump durability and resist a touch — ServUO scales these
          // from material tier. Simple flat boost suffices for MVP.
          if (item.durabilityMax) item.durabilityMax = Math.floor(item.durabilityMax * 1.1);
          if (item.physicalResist != null) item.physicalResist = (item.physicalResist | 0) + 2;
          ctx.state.sendSystemMessage(`Enhanced to ${mat.material}!`);
          api.skillGain?.tryGain?.(mob, mat.skill, mat.skillReq);
        } else if (Math.random() < 0.5) {
          ctx.state.sendSystemMessage('The enhancement fails and the item shatters!');
          try { destroyItemBySerial(api, item.serial); } catch { /* */ }
        } else {
          ctx.state.sendSystemMessage('The enhancement fails. The item is unharmed.');
        }
      }, { kind: 0 });
    },
  });
  return () => api.commands.unregister('enhance');
}
