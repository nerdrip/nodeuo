// SkillsGroupManager — folder-tree organisation for the SkillsGump.
// Mirrors CUO `Game/Managers/SkillsGroupManager.cs` simplified.
//
// CUO supports user-named groups + drag-reorder + persisted XML. We ship
// fixed CUO-canonical groups (Combat / Actions / Lore & Knowledge / Magic
// / Wilderness / Thievery / Bardic / Crafting / Misc) and let the gump
// query `groupFor(skillId)`.
//
// `decodeSkills` stores rows as 0-based UI ids (`wireId - 1`) so the gump
// can index directly into its SKILL_NAMES array. Keep this map in the same
// 0-based coordinate space; comments pin each row to the canonical 1-based
// skill id used by the server and wire snapshots.

import { profile } from './profile-manager.js';

export const Groups = Object.freeze({
  Combat:        'Combat',
  Actions:       'Actions',
  Lore:          'Lore & Knowledge',
  Magic:         'Magic',
  Wilderness:    'Wilderness',
  Thievery:      'Thievery',
  Bardic:        'Bardic',
  Crafting:      'Crafting',
  Misc:          'Misc',
});

// Map: client skill id (canonical id - 1) -> group label.
const SKILL_GROUP = new Map([
  // Combat
  [5,  Groups.Combat],        // canon 6  Parrying
  [27, Groups.Combat],        // canon 28 Tactics
  [31, Groups.Combat],        // canon 32 Archery
  [40, Groups.Combat],        // canon 41 Swordsmanship
  [41, Groups.Combat],        // canon 42 Mace Fighting
  [42, Groups.Combat],        // canon 43 Fencing
  [43, Groups.Combat],        // canon 44 Wrestling
  [51, Groups.Combat],        // canon 52 Chivalry
  [52, Groups.Combat],        // canon 53 Bushido
  [53, Groups.Combat],        // canon 54 Ninjitsu
  [57, Groups.Combat],        // canon 58 Throwing

  // Magic
  [25, Groups.Magic],         // canon 26 Magery
  [26, Groups.Magic],         // canon 27 Resisting Spells
  [32, Groups.Magic],         // canon 33 Spirit Speak
  [46, Groups.Magic],         // canon 47 Meditation
  [49, Groups.Magic],         // canon 50 Necromancy
  [50, Groups.Magic],         // canon 51 Focus
  [54, Groups.Magic],         // canon 55 Spellweaving
  [55, Groups.Magic],         // canon 56 Mysticism

  // Lore
  [1,  Groups.Lore],          // canon 2  Anatomy
  [2,  Groups.Lore],          // canon 3  Animal Lore
  [3,  Groups.Lore],          // canon 4  Item Identification
  [4,  Groups.Lore],          // canon 5  Arms Lore
  [16, Groups.Lore],          // canon 17 Evaluating Intelligence
  [19, Groups.Lore],          // canon 20 Forensic Evaluation
  [36, Groups.Lore],          // canon 37 Taste Identification

  // Wilderness
  [10, Groups.Wilderness],    // canon 11 Camping
  [12, Groups.Wilderness],    // canon 13 Cartography
  [13, Groups.Wilderness],    // canon 14 Cooking
  [18, Groups.Wilderness],    // canon 19 Fishing
  [20, Groups.Wilderness],    // canon 21 Herding
  [35, Groups.Wilderness],    // canon 36 Animal Taming
  [38, Groups.Wilderness],    // canon 39 Tracking
  [39, Groups.Wilderness],    // canon 40 Veterinary
  [44, Groups.Wilderness],    // canon 45 Lumberjacking
  [45, Groups.Wilderness],    // canon 46 Mining

  // Thievery
  [14, Groups.Thievery],      // canon 15 Detect Hidden
  [21, Groups.Thievery],      // canon 22 Hiding
  [24, Groups.Thievery],      // canon 25 Lockpicking
  [28, Groups.Thievery],      // canon 29 Snooping
  [30, Groups.Thievery],      // canon 31 Poisoning
  [33, Groups.Thievery],      // canon 34 Stealing
  [47, Groups.Thievery],      // canon 48 Stealth
  [48, Groups.Thievery],      // canon 49 Remove Trap

  // Bardic
  [9,  Groups.Bardic],        // canon 10 Peacemaking
  [15, Groups.Bardic],        // canon 16 Discordance
  [22, Groups.Bardic],        // canon 23 Provocation
  [29, Groups.Bardic],        // canon 30 Musicianship

  // Crafting
  [0,  Groups.Crafting],      // canon 1  Alchemy
  [7,  Groups.Crafting],      // canon 8  Blacksmithy
  [8,  Groups.Crafting],      // canon 9  Bowcraft/Fletching
  [11, Groups.Crafting],      // canon 12 Carpentry
  [23, Groups.Crafting],      // canon 24 Inscription
  [34, Groups.Crafting],      // canon 35 Tailoring
  [37, Groups.Crafting],      // canon 38 Tinkering
  [56, Groups.Crafting],      // canon 57 Imbuing
]);

class SkillsGroupManager {
  constructor() {
    /** runtime overrides — user can move a skill via UI, persisted */
    this._overrides = new Map();
    /** user-edited group ordering (default Object.values(Groups)) */
    this._order = null;
    /** user-renamed group labels (default = canonical Groups value) */
    this._renames = new Map();
    /** lock state per group (Up / Down / Locked) for bulk lock-all */
    this._locks = new Map();
    this._installed = false;
  }
  install() {
    if (this._installed) return;
    this._installed = true;
    const saved = profile.get?.('skillsGroups.overrides') ?? {};
    for (const [k, v] of Object.entries(saved)) this._overrides.set(+k, v);
    const savedOrder = profile.get?.('skillsGroups.order');
    if (Array.isArray(savedOrder) && savedOrder.length) this._order = savedOrder.slice();
    const savedRenames = profile.get?.('skillsGroups.renames') ?? {};
    for (const [k, v] of Object.entries(savedRenames)) this._renames.set(k, v);
  }
  groupFor(skillId) {
    const ov = this._overrides.get(skillId | 0);
    if (ov) return ov;
    return SKILL_GROUP.get(skillId | 0) ?? Groups.Misc;
  }
  setGroupFor(skillId, group) {
    this._overrides.set(skillId | 0, group);
    try {
      const obj = Object.fromEntries(this._overrides);
      profile.set?.('skillsGroups.overrides', obj);
    } catch { /* noop */ }
  }
  /** Order of folders in the gump. */
  groups() {
    if (this._order && this._order.length) return this._order.slice();
    return Object.values(Groups);
  }
  /** Display label for a group (honours user renames). */
  labelFor(group) {
    return this._renames.get(group) ?? group;
  }
  /** Audit #46 P2 — drag-reorder cross-group. Caller passes (fromIndex,
   *  toIndex) for the folder list; we splice + persist. */
  reorderGroup(fromIdx, toIdx) {
    const order = this.groups();
    if (fromIdx < 0 || fromIdx >= order.length) return;
    if (toIdx < 0 || toIdx > order.length) return;
    const [moved] = order.splice(fromIdx, 1);
    order.splice(toIdx > fromIdx ? toIdx - 1 : toIdx, 0, moved);
    this._order = order;
    try { profile.set?.('skillsGroups.order', order); } catch { /* noop */ }
  }
  /** Rename a group (persisted). */
  renameGroup(group, label) {
    if (!group || !label) return;
    this._renames.set(group, String(label));
    try { profile.set?.('skillsGroups.renames', Object.fromEntries(this._renames)); }
    catch { /* noop */ }
  }
  /** Lock-all in a group to a given state (Up=0, Down=1, Locked=2). */
  lockAll(group, state) {
    this._locks.set(group, state | 0);
  }
  getGroupLock(group) {
    return this._locks.get(group);
  }
}

export const skillsGroupManager = new SkillsGroupManager();
