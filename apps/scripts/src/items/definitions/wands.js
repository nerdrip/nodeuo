// Wands — magic-charge consumable weapons. ServUO `BaseWand.cs` +
// 8 derived classes (one per spell school: Lightning / Heal / Greater
// Heal / Magic Arrow / Fire / Identification / Magic Trap / Magic
// Untrap / Clumsy / Fireball / Mana Drain). On double-click the wand
// casts its bound spell at no mana cost; charges decrement; at 0 the
// wand crumbles.
//
// Bind via `wandSpell: <spellId>`. The use-handler reads `magicCharges`
// (per-item field already on the persistence whitelist as `magicCharges`)
// and decrements per cast.

import { itemBySerial, mobileBySerial } from '../../_entities.js';
import { destroyItemBySerial } from '../../_items.js';

// --- script loader pattern: queue at module-load, flush in default register() ---
const __PENDING__ = [];
let _spells = null;
let _commands = null;


// Audit #33 P1 #1 — wands that bind to offensive spells must prompt for
// a target. ServUO `BaseWand.OnDoubleClick` opens a WandTarget cursor;
// the picked mobile becomes the spell's target. Previously every wand
// fired with `target: user`, so Lightning/Fireball/Flamestrike/Mana
// Drain fried the wielder. Spells that are self-cast on retail (Heal,
// Greater Heal, Identification, Magic Trap/Untrap) stay on the self
// short-circuit so a double-click does the right thing without an
// extra cursor roundtrip.
// Audit #43 P1-2 — dropped 21 (Telekinesis). Identification wand now
// routes via the `wandIdentify` flag, not as a self-cast spell, so
// hiding 21 in this set no longer masks the wrong-spell binding.
const SELF_CAST_SPELLS = new Set([4, 29, 13, 14]);

function wandUse(user, scope) {
  const item = scope?.item;
  if (!item) return;
  if ((item.magicCharges | 0) <= 0) {
    user.client?.sendSystemMessage?.('The wand has no charges remaining.');
    if (scope?.def) item._noConsume = true; // don't auto-decrement; caller handles
    return;
  }
  const def = scope?.def;
  const spellId = def?.wandSpell;
  const world = scope?.world ?? user?.client?.ctx?.world;
  const state = user.client;
  const targeting = state?.ctx?.targeting;
  const consumeCharge = () => {
    item.magicCharges = Math.max(0, (item.magicCharges | 0) - 1);
    if (item.magicCharges === 0) {
      try { user.client?.sendSystemMessage?.(`Your ${item.name ?? 'wand'} crumbles to dust.`); }
      catch { /* socket transient */ }
      if (world) {
        try { destroyItemBySerial({ world }, item.serial); }
        catch { /* already crumbled */ }
      }
    }
  };
  if (def?.wandIdentify) {
    item._noConsume = true;
    if (!world || !state || !targeting?.request || !_commands?.dispatch) {
      user.client?.sendSystemMessage?.('The identification magic is unavailable.');
      return;
    }
    user.client?.sendSystemMessage?.('What item do you wish to identify?');
    targeting.request(state, (picked) => {
      const targetItem = picked?.serial ? itemBySerial({ world }, picked.serial >>> 0) : null;
      if (!targetItem) {
        user.client?.sendSystemMessage?.('That is not an item.');
        return;
      }
      _commands.dispatch(`identify ${targetItem.serial >>> 0}`, {
        sender: user, state, world,
      });
      consumeCharge();
    });
    return;
  }
  if (!spellId) {
    item._noConsume = true;
    return;
  }
  const spell = _spells?.getSpell?.(spellId);
  if (!spell) { item._noConsume = true; return; }
  if (!world) { item._noConsume = true; return; }
  const isSelfCast = SELF_CAST_SPELLS.has(spellId);
  const destroyWand = (w) => {
    try { destroyItemBySerial({ world: w }, item.serial); }
    catch { /* already crumbled */ }
  };
  if (!isSelfCast && targeting?.request && state) {
    // Don't consume a charge until the player actually picks a target;
    // ESC cancels for free. Also opt out of the template auto-consume.
    item._noConsume = true;
    user.client?.sendSystemMessage?.(`Aim the ${item.name ?? 'wand'}.`);
    targeting.request(state, (picked) => {
      if (!picked) return;
      const target = picked.serial ? mobileBySerial({ world }, picked.serial >>> 0) : null;
      if (!target) {
        user.client?.sendSystemMessage?.('Invalid target.');
        return;
      }
      try {
        _spells.castSpell({ caster: user, spellId, world, target, scroll: true, instant: true });
      } catch (e) { console.error('[wand] cast', e); }
      consumeCharge();
    });
    return;
  }
  try {
    _spells.castSpell({
      caster: user, spellId, world,
      target: user, scroll: true, instant: true,
    });
  } catch (e) {
    console.error('[wand] cast', e);
  }
  item.magicCharges = Math.max(0, (item.magicCharges | 0) - 1);
  // ServUO `BaseWand.OnCharge` — wand crumbles when its last charge is
  // spent. Destroy via the items module so sectors / _tickingItems /
  // _childrenByParent indices all clean up. Player gets a system
  // message + a small visual cue (the wand vanishes from their hand).
  if (item.magicCharges === 0) {
    try {
      user.client?.sendSystemMessage?.(`Your ${item.name ?? 'wand'} crumbles to dust.`);
    } catch { /* socket transient */ }
    try {
      const w = scope?.world ?? user?.client?.ctx?.world;
      if (w) destroyWand(w);
    } catch { /* world ctx missing */ }
    return;
  }
  // Wand stays in hand; opt out of consumption.
  item._noConsume = true;
}

function wand(def) {
  __PENDING__.push({
    kind: 'weapon',
    category: 'wand',
    layer: 1,
    twoHanded: false,
    weight: 1,
    weaponSkill: 25, // magery
    chargeable: true,
    script: 'magic-wand',
    magicCharges: def.magicCharges ?? def.defaultCharges ?? 30,
    effect: wandUse,
    ...def,
  });
}

// School-bound wands (id matches ServUO `Wand.cs` — alternate art ids
// 0x0DF2..0x0DF5 stand for Magery / Greater Magery sets).
wand({ id: 0x0DF2, name: 'Lightning Wand',     servuoClass: 'LightningWand', wandSpell: 30 /* Lightning */, defaultCharges: 30 });
// Audit #43 P1-2 — Magic Arrow is spell id 5 (Create Food is 2).
// Was: Magic Arrow Wand fired Create Food.
wand({ id: 0x0DF3, name: 'Magic Arrow Wand',   servuoClass: 'MagicArrowWand', wandSpell:  5 /* Magic Arrow */, defaultCharges: 50 });
wand({ id: 0x0DF4, name: 'Fireball Wand',      servuoClass: 'FireballWand', wandSpell: 18 /* Fireball */, defaultCharges: 30 });
wand({ id: 0x0DF5, name: 'Greater Heal Wand',  servuoClass: 'GreaterHealWand', wandSpell: 29 /* Greater Heal */, defaultCharges: 25 });
wand({ id: 0x0DF2, tagId: 'wand-heal', name: 'Heal Wand', servuoClass: 'HealWand', wandSpell:  4 /* Heal */, defaultCharges: 50 });
wand({ id: 0x0DF2, tagId: 'wand-clumsy', name: 'Clumsy Wand', servuoClass: 'ClumsyWand', wandSpell:  1 /* Clumsy */, defaultCharges: 50 });
// Audit #43 P1-2 — Mana Drain is spell id 31 (32 = Recall). Was:
// Mana Drain Wand fired Recall (and warped the wielder).
wand({ id: 0x0DF2, tagId: 'wand-mana-drain', name: 'Mana Drain Wand', servuoClass: 'ManaDrainWand', wandSpell: 31 /* Mana Drain */, defaultCharges: 30 });
wand({ id: 0x0DF2, tagId: 'wand-flame-strike', name: 'Flamestrike Wand', servuoClass: 'FlameStrikeWand', wandSpell: 51 /* Flamestrike */, defaultCharges: 15 });
// Audit #43 P1-2 — There is no Magery "Identification" spell; id 21 is
// Telekinesis. ServUO routes wand-identify through ItemID skill (25)
// instead. For now bind to a no-op handler-side identify pseudo-spell
// rather than mis-fire Telekinesis. Use itemId 0x0F4B as the canonical
// identification-wand graphic per ServUO and stamp `wandIdentify: true`
// so the use-handler can route it to skill 25 dispatch.
wand({ id: 0x0DF2, tagId: 'wand-identification', name: 'Identification Wand', servuoClass: 'IdentificationWand', wandSpell: 0 /* see use-handler */, wandIdentify: true, defaultCharges: 50 });
wand({ id: 0x0DF2, tagId: 'wand-magic-trap', name: 'Magic Trap Wand', servuoClass: 'MagicTrapWand', wandSpell: 13 /* Magic Trap */, defaultCharges: 25 });
wand({ id: 0x0DF2, tagId: 'wand-magic-untrap', name: 'Magic Untrap Wand', servuoClass: 'MagicUntrapWand', wandSpell: 14 /* Magic Untrap */, defaultCharges: 25 });
wand({ id: 0x0DF2, tagId: 'wand-explosion', name: 'Explosion Wand', servuoClass: 'ExplosionWand', wandSpell: 43 /* Explosion */, defaultCharges: 15 });
wand({ id: 0x0DF2, tagId: 'wand-weakness', name: 'Weakness Wand', servuoClass: 'WeaknessWand', wandSpell: 8 /* Weaken */, magicSpell: 'weaken', defaultCharges: 30 });

export function createRandomWandDefinition(rng = Math.random) {
  const pool = __PENDING__.filter((def) => def.category === 'wand' && def.servuoClass !== 'RandomWand');
  return pool[Math.floor(rng() * pool.length)] ?? pool[0] ?? null;
}

// ServUO exposes RandomWand as a factory class. Registering this marker
// keeps audit and admin tooling discoverable; loot code can call
// `createRandomWandDefinition()` to materialize a concrete wand.
__PENDING__.push({
  id: 0x0DF2,
  tagId: 'wand-random',
  name: 'Random Wand',
  servuoClass: 'RandomWand',
  kind: 'weapon',
  category: 'wand-factory',
  script: 'magic-wand',
  magicCharges: 1,
  wandFactory: 'random',
  movable: true,
});


// --- script entry point ----------------------------------------------
export default function register(api) {
  _spells = api.systems?.spells;
  _commands = api.commands;
  if (!_spells?.castSpell || !_spells?.getSpell) {
    api.log?.('wands: spells system missing, skipping');
    return () => { _spells = null; _commands = null; };
  }
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('wands: registerItem missing, skipping'); return () => { _spells = null; _commands = null; }; }
  let count = 0;
  for (const def of __PENDING__) { try { reg(def); count++; } catch (e) { api.log?.('wands: ' + e.message); } }
  api.log?.('wands: registered ' + count + ' items');
  return () => { _spells = null; _commands = null; };
}
