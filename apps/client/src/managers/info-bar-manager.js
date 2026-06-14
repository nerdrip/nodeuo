// InfoBarManager — configurable HUD strip with stats / gold / weight.
// Mirrors CUO `Game/Managers/InfoBarManager.cs` + `InfoBarItem`.
//
// CUO ships ~25 InfoBarVar entries (HitPoints, Mana, Stamina, Weight,
// Gold, Followers, Damage, Reagents...). Each user-defined item has a
// label string + Var enum + display hue. The InfoBarGump renders one
// label per item, each polling `varValue(var)`.

import { bus } from '../core/event-bus.js';
import { profile } from './profile-manager.js';
import { world } from '../world/world.js';

export const InfoBarVar = Object.freeze({
  HitPoints:    1,
  Mana:         2,
  Stamina:      3,
  Weight:       4,
  Followers:    5,
  Damage:       6,
  Gold:         7,
  PhysResist:   8,
  FireResist:   9,
  ColdResist:  10,
  PoisonResist:11,
  EnergyResist:12,
  Luck:        13,
  TithingPoints:14,
  Str:         15,
  Dex:         16,
  Int:         17,
  StatCap:     18,
  // CUO Profile.cs::InfoBarVar parity additions (audit #44). Max-only,
  // delta tracking, and combat chance fields the previous list missed.
  HitMax:       19,
  ManaMax:      20,
  StamMax:      21,
  HitLoss:      22,             // delta since last 0x11 push
  ManaLoss:     23,
  StamLoss:     24,
  HitChanceInc: 25,             // HCI %
  DefChanceInc: 26,             // DCI %
  DamageInc:    27,             // DI %
  SpellDamageInc:28,            // SDI %
  SwingSpeedInc:29,             // SSI %
  LowerManaCost:30,             // LMC %
  LowerReagentCost:31,          // LRC %
  ReflectPhysical:32,           // RPD %
  ResistAll:    33,             // sum of 5 resists
  EquippedWeapon:34,            // currently-wielded weapon name
});

const VAR_LABEL = {
  [InfoBarVar.HitPoints]: 'HP',
  [InfoBarVar.Mana]:      'MP',
  [InfoBarVar.Stamina]:   'ST',
  [InfoBarVar.Weight]:    'Wt',
  [InfoBarVar.Followers]: 'Pets',
  [InfoBarVar.Damage]:    'Dmg',
  [InfoBarVar.Gold]:      'Gold',
  [InfoBarVar.PhysResist]:'Phys',
  [InfoBarVar.FireResist]:'Fire',
  [InfoBarVar.ColdResist]:'Cold',
  [InfoBarVar.PoisonResist]:'Pois',
  [InfoBarVar.EnergyResist]:'Engy',
  [InfoBarVar.Luck]:      'Luck',
  [InfoBarVar.TithingPoints]: 'Tith',
  [InfoBarVar.Str]:       'Str',
  [InfoBarVar.Dex]:       'Dex',
  [InfoBarVar.Int]:       'Int',
  [InfoBarVar.StatCap]:   'Cap',
  [InfoBarVar.HitMax]:    'HPM',
  [InfoBarVar.ManaMax]:   'MPM',
  [InfoBarVar.StamMax]:   'STM',
  [InfoBarVar.HitLoss]:   '-HP',
  [InfoBarVar.ManaLoss]:  '-MP',
  [InfoBarVar.StamLoss]:  '-ST',
  [InfoBarVar.HitChanceInc]:    'HCI',
  [InfoBarVar.DefChanceInc]:    'DCI',
  [InfoBarVar.DamageInc]:       'DI',
  [InfoBarVar.SpellDamageInc]:  'SDI',
  [InfoBarVar.SwingSpeedInc]:   'SSI',
  [InfoBarVar.LowerManaCost]:   'LMC',
  [InfoBarVar.LowerReagentCost]:'LRC',
  [InfoBarVar.ReflectPhysical]: 'RPD',
  [InfoBarVar.ResistAll]:       'RAll',
  [InfoBarVar.EquippedWeapon]:  'Wpn',
};

const DEFAULT_ITEMS = [
  { var: InfoBarVar.HitPoints, hue: 0x80c060 },
  { var: InfoBarVar.Mana,      hue: 0x4080d0 },
  { var: InfoBarVar.Stamina,   hue: 0xd0a040 },
  { var: InfoBarVar.Weight,    hue: 0xc0b890 },
  { var: InfoBarVar.Gold,      hue: 0xffe080 },
  { var: InfoBarVar.Followers, hue: 0xc0a070 },
];

class InfoBarManager {
  constructor() {
    /** @type {{var:number, hue:number, label?:string}[]} */
    this._items = [];
    this._installed = false;
  }

  install() {
    if (this._installed) return;
    this._installed = true;
    const saved = profile.get?.('infoBar.items');
    this._items = Array.isArray(saved) && saved.length ? saved : DEFAULT_ITEMS.slice();
  }

  /** Get configured items (returns a copy). */
  getItems() { return this._items.slice(); }

  setItems(items) {
    this._items = Array.isArray(items) ? items.slice() : [];
    try { profile.set?.('infoBar.items', this._items); } catch { /* noop */ }
    bus.emit('infobar:changed', { items: this.getItems() });
  }

  labelFor(varId) { return VAR_LABEL[varId] ?? '?'; }

  /** Resolve the current numeric value for `var`. Returns null when the
   *  field is unknown / not yet pushed by 0x11. */
  valueFor(varId) {
    const p = world.player;
    if (!p) return null;
    switch (varId) {
      case InfoBarVar.HitPoints:    return p.hpMax    ? `${p.hp ?? 0}/${p.hpMax}`     : null;
      case InfoBarVar.Mana:         return p.mpMax    ? `${p.mp ?? p.mana ?? 0}/${p.mpMax ?? p.manaMax}` : null;
      case InfoBarVar.Stamina:      return (p.stMax || p.stamMax) ? `${p.st ?? p.stam ?? 0}/${p.stMax ?? p.stamMax}` : null;
      case InfoBarVar.Weight:       return p.weight != null ? `${p.weight}/${p.weightMax ?? '?'}` : null;
      case InfoBarVar.Gold:         return p.gold ?? null;
      case InfoBarVar.Followers:    return p.followers != null ? `${p.followers}/${p.followersMax ?? '?'}` : null;
      case InfoBarVar.Str:          return p.str ?? null;
      case InfoBarVar.Dex:          return p.dex ?? null;
      case InfoBarVar.Int:          return p.int ?? null;
      case InfoBarVar.StatCap:      return p.statCap ?? null;
      case InfoBarVar.PhysResist:   return p.ar ?? null;
      case InfoBarVar.FireResist:   return p.fireResist ?? null;
      case InfoBarVar.ColdResist:   return p.coldResist ?? null;
      case InfoBarVar.PoisonResist: return p.poisonResist ?? null;
      case InfoBarVar.EnergyResist: return p.energyResist ?? null;
      case InfoBarVar.Luck:         return p.luck ?? null;
      case InfoBarVar.TithingPoints:return p.tithingPoints ?? null;
      case InfoBarVar.Damage:       return p.dmgMin && p.dmgMax ? `${p.dmgMin}-${p.dmgMax}` : null;
      // Max / delta / combat-chance pushes from 0x11 ExtendedStats —
      // canonical field names match the keys mobile.js writes.
      case InfoBarVar.HitMax:       return p.hpMax ?? null;
      case InfoBarVar.ManaMax:      return p.mpMax ?? p.manaMax ?? null;
      case InfoBarVar.StamMax:      return p.stMax ?? p.stamMax ?? null;
      case InfoBarVar.HitLoss:      return p.hpLoss   ?? this._delta(p, '_lastHp',   p.hp);
      case InfoBarVar.ManaLoss:     return p.manaLoss ?? this._delta(p, '_lastMp',   p.mp ?? p.mana);
      case InfoBarVar.StamLoss:     return p.stamLoss ?? this._delta(p, '_lastStam', p.st ?? p.stam);
      case InfoBarVar.HitChanceInc: return p.hci ?? null;
      case InfoBarVar.DefChanceInc: return p.dci ?? null;
      case InfoBarVar.DamageInc:    return p.di  ?? null;
      case InfoBarVar.SpellDamageInc: return p.sdi ?? null;
      case InfoBarVar.SwingSpeedInc:  return p.ssi ?? null;
      case InfoBarVar.LowerManaCost:  return p.lmc ?? null;
      case InfoBarVar.LowerReagentCost: return p.lrc ?? null;
      case InfoBarVar.ReflectPhysical: return p.rpd ?? null;
      case InfoBarVar.ResistAll:    return [p.ar, p.fireResist, p.coldResist, p.poisonResist, p.energyResist]
                                       .filter((v) => v != null)
                                       .reduce((a, b) => a + b, 0) || null;
      case InfoBarVar.EquippedWeapon: return p.weaponName ?? null;
      default: return null;
    }
  }

  /** Compute a "loss" delta against a stashed previous value. We stash
   *  on the mobile object so the next tick can diff against it. */
  _delta(p, key, cur) {
    if (cur == null) return null;
    const prev = p[key] ?? cur;
    p[key] = cur;
    return Math.max(0, prev - cur) || null;
  }
}

export const infoBar = new InfoBarManager();
