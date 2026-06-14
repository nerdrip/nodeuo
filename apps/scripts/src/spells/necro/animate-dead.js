// Animate Dead — summons an undead servant from a nearby corpse.
// ServUO `AnimateDead.cs::TableEntry` picks the body based on the
// corpse's original creature: large beasts rise as skeletal drakes,
// daemons as ravagers, etc.
import { broadcastSound } from '../_helpers.js';
import { destroyItemBySerial } from '../../_items.js';
import { allItems } from '../../_spatial.js';

// Subset of ServUO's table — enough to cover the common cases. Keys
// are kind names (matches `_originalKind` stamped on corpses). Lookup
// failures fall through to skeleton (the canonical default).
const ANIMATE_TABLE = {
  'dog':           'skeletal-mage',
  'cat':           'skeletal-mage',
  'great-hart':    'bone-magi',
  'dragon':        'skeletal-dragon',
  'ancient-wyrm':  'skeletal-dragon',
  'drake':         'bone-knight',
  'wyrm':          'bone-knight',
  'daemon':        'ravager',
  'balron':        'ravager',
  'lich':          'wraith',
  'lich-lord':     'wraith',
  'troll':         'rotting-corpse',
  'ogre':          'rotting-corpse',
  'ettin':         'rotting-corpse',
  'orc':           'bone-magi',
  'orc-lord':      'bone-knight',
  'ratman':        'patchwork-skeleton',
};

function pickAnimateKind(api, caster) {
  // Find the nearest corpse (itemId 0x2006) within 2 tiles. The corpse
  // is consumed if found (matches ServUO).
  for (const it of allItems(api)) {
    if (it.itemId !== 0x2006 || it.parent) continue;
    if (it.map !== caster.map) continue;
    if (Math.abs(it.x - caster.x) > 2 || Math.abs(it.y - caster.y) > 2) continue;
    const k = it._originalKind ?? it.corpseKind;
    return { kind: ANIMATE_TABLE[k] ?? 'skeleton', corpse: it };
  }
  return { kind: 'skeleton', corpse: null };
}

export default {
  name: 'animate-dead', school: 'necromancy', circle: 5, mana: 23,
  cast(api, ctx) {
    const caster = ctx.sender;
    const factory = api.ctx?.spawnFactory;
    if (!factory) return ctx.state.sendSystemMessage('Animation not available on this shard.');
    const pick = pickAnimateKind(api, caster);
    const kind = pick.kind ?? 'skeleton';
    const minion = factory(api.world, kind, { x: caster.x, y: caster.y + 1, z: caster.z, map: caster.map });
    if (!minion) return ctx.state.sendSystemMessage('You fail to summon a corpse.');
    // Consume the corpse if we matched one (ServUO does this on success).
    if (pick.corpse) {
      try { destroyItemBySerial(api, pick.corpse.serial); }
      catch { /* already consumed */ }
    }
    minion.controlMaster = caster.serial >>> 0;
    minion.notoriety = 1;
    // Audit #32 P2 #9 — ServUO `AnimateDeadSpell.cs:401`
    // `BaseCreature.Summon(..., TimeSpan.FromDays(1.0))`. Stamp the
    // summon timer so the existing `summon-expire` sweep can clean it
    // up; without this the skeleton lived forever, leaking follower
    // slots and never decaying.
    minion.summoned = true;
    minion.summonedBy = caster.serial >>> 0;
    minion.summonedUntil = Date.now() + 24 * 60 * 60 * 1000;
    api.systems?.summons?.registerSummon?.(api.world, minion);
    api.ai?.attach?.(minion, 'pet', { command: 'follow', targetSerial: 0 });
    broadcastSound(api, api.world, caster, 0x217);
    ctx.state.sendSystemMessage(`A ${kind.replaceAll('-', ' ')} rises to serve you.`);
  },
};
