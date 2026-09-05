// Stygian Abyss dungeon furniture — port of ServUO
// `Services/Underworld/`, `Services/Tomb of Kings/`, and
// `Services/ExploringTheDeep/`.

import { moveMobile } from '../_movement.js';
import { canCreateItem, createItem, destroyItemBySerial } from '../_items.js';
import { allItems } from '../_spatial.js';
import { registerWorldContentSeed } from '../_world-content.js';
import { itemBySerial } from '../_entities.js';
//
// Each ServUO service is a tiny collection of items that exist only to
// gate entry, transition between levels, or block players who haven't
// taken the relevant quest. We mirror them as item-scripts so the
// physical world has the same gates without needing C# classes.
//
// Coverage:
//   Underworld          → 3 pit teleporters (lvl 1 → 2 → 3) + exit back
//                         to Royal City + "Mariah's voice" hint NPC.
//   Tomb of Kings       → Sacred-quest blocker (refuses entry without
//                         the Sacred Quest active), bridge teleporter,
//                         secret door (requires "tomb key" in pack).
//   Exploring the Deep  → 3-stage quest chain (Mariah → Aelorn the
//                         Adept → Halls of the Reaver) registered in
//                         the mlquests engine.

const TOMB_KEY_ITEMID = 0x1010;       // ServUO 'tomb key' graphic alias
const TOMB_DEST_INSIDE = { map: 4, x: 1010, y: 3480, z: -50 };
const TOMB_DEST_OUTSIDE = { map: 4, x: 1010, y: 3398, z: -42 };
const UW_LEVEL1 = { map: 4, x: 1010, y: 3720, z: 0 };
const UW_LEVEL2 = { map: 4, x: 1010, y: 3790, z: -22 };
const UW_LEVEL3 = { map: 4, x: 1020, y: 3820, z: -44 };
const ROYAL_CITY = { map: 4, x: 990,  y: 3400, z: -45 };

const LANDMARK_DEFS = [
  {
    itemId: 0x1BCB, hue: 0, x: 1010, y: 3415, z: -42, map: 4,
    name: 'Sacred Quest Blocker', movable: false, visible: false,
    script: 'sa-quest-blocker', questId: 'sacred-quest', teleportTo: TOMB_DEST_INSIDE,
  },
  {
    itemId: 0x1BCB, hue: 0, x: 1010, y: 3420, z: -42, map: 4,
    name: 'Bridge to the Tomb', movable: false, visible: false,
    script: 'teleporter', teleportTo: { map: 4, x: 1015, y: 3460, z: -50 }, cooldownMs: 2000,
  },
  {
    itemId: 0x0E76, hue: 0x47E, x: 1015, y: 3470, z: -50, map: 4,
    name: 'Secret Door', movable: false, script: 'teleporter',
    requireItemId: TOMB_KEY_ITEMID,
    teleportTo: { map: 4, x: 1015, y: 3475, z: -50 }, cooldownMs: 2000,
  },
  {
    itemId: 0x1BCB, hue: 0, x: UW_LEVEL1.x, y: UW_LEVEL1.y - 6, z: UW_LEVEL1.z, map: 4,
    name: 'Pit (level 1)', movable: false, visible: false,
    script: 'teleporter', teleportTo: UW_LEVEL2, cooldownMs: 2500,
  },
  {
    itemId: 0x1BCB, hue: 0, x: UW_LEVEL2.x, y: UW_LEVEL2.y - 6, z: UW_LEVEL2.z, map: 4,
    name: 'Pit (level 2)', movable: false, visible: false,
    script: 'teleporter', teleportTo: UW_LEVEL3, cooldownMs: 2500,
  },
  {
    itemId: 0x1BCB, hue: 0, x: UW_LEVEL3.x, y: UW_LEVEL3.y + 4, z: UW_LEVEL3.z, map: 4,
    name: 'Underworld Exit', movable: false, visible: false,
    script: 'teleporter', teleportTo: ROYAL_CITY, cooldownMs: 2500,
  },
  {
    itemId: 0x1BCB, hue: 0, x: 1010, y: 3550, z: -50, map: 4,
    name: 'Leave the Tomb', movable: false, visible: false,
    script: 'teleporter', teleportTo: TOMB_DEST_OUTSIDE, cooldownMs: 2500,
  },
];

export default function register(api) {
  if (!api.world) return () => {};

  let landmarks = [];
  const applyLandmarks = (opts = {}) => {
    const facets = opts.facets ? new Set(opts.facets) : null;
    if (!canCreateItem(api, api.world)) return { added: 0, failed: 1 };
    if (!facets) landmarks = [];
    let added = 0;
    for (const def of LANDMARK_DEFS) {
      if (facets && !facets.has(def.map)) continue;
      let item = [...allItems(api)].find((candidate) =>
        candidate.name === def.name && candidate.map === def.map &&
        candidate.x === def.x && candidate.y === def.y && candidate.z === def.z);
      if (!item) {
        item = createItem(api, api.world, { ...def });
        added++;
      }
      item._worldContentSeed = 'sa-dungeons';
      if (!landmarks.some((candidate) => candidate.serial === item.serial)) landmarks.push(item);
    }
    return { added };
  };
  const removeLandmarks = (opts = {}) => {
    const facets = opts.facets ? new Set(opts.facets) : null;
    const serials = new Set();
    for (const item of allItems(api)) {
      const canonical = LANDMARK_DEFS.some((def) => item.name === def.name &&
        item.map === def.map && item.x === def.x && item.y === def.y && item.z === def.z);
      if ((item._worldContentSeed === 'sa-dungeons' && (!facets || facets.has(item.map))) ||
          (canonical && (!facets || facets.has(item.map)))) {
        serials.add(item.serial >>> 0);
      }
    }
    for (const item of landmarks) if (!facets || facets.has(item.map)) serials.add(item.serial >>> 0);
    let removed = 0;
    for (const serial of serials) {
      try { if (itemBySerial(api, serial)) { destroyItemBySerial(api, serial); removed++; } }
      catch (error) { api.log?.(`sa-dungeons: landmark removal failed: ${error.message}`); }
    }
    landmarks = facets ? landmarks.filter((item) => !facets.has(item.map)) : [];
    return { removed };
  };
  const unregisterSeed = registerWorldContentSeed(api, 'sa-dungeons', {
    apply: applyLandmarks,
    remove: removeLandmarks,
  });
  if (api.world._createWorldDone !== false) applyLandmarks();

  // -------------------------------------------------------------------
  // Exploring the Deep — 4-stage quest. Register in the mlquests engine
  // if available. Mirrors `ExploringTheDeepQuestChain.cs`.
  const mlReg = api.mlQuests?.registerQuest ?? api.systems?.mlQuests?.registerQuest;
  if (mlReg) {
    try {
      mlReg({
        id: 'exploring-the-deep',
        title: 'Exploring the Deep',
        description: 'Aid Mariah in uncovering the secret of the Halls of the Reaver.',
        giverKind: 'Mariah',
        objectives: [
          { type: 'talk',    keyword: 'speak to aelorn' },
          { type: 'collect', itemType: 'reaver-fragment',     count: 3 },
          { type: 'slay',    kind: 'corrupted-reaver',        count: 1 },
          { type: 'deliver', itemType: 'reaver-tome', toKind: 'Mariah' },
        ],
        rewards: [
          { type: 'gold',  amount: 1500 },
          { type: 'item',  itemType: 'mariah-token' },
          { type: 'fame',  amount: 250 },
        ],
        unique: true,
      });
    } catch (e) {
      if (!String(e?.message ?? '').includes('Duplicate')) {
        api.log?.(`sa-dungeons: exploring-the-deep quest failed: ${e.message}`);
      }
    }
  }

  // Item-script registration: the SA quest-blocker behaviour. Re-uses
  // the existing 'teleporter' script for cascading pits and the
  // existing 'secret-door' script for the keyed door.
  api.itemScripts?.register?.({
    name: 'sa-quest-blocker',
    onWalkOn(world, item, mob) {
      if (!mob) return;
      const ml = api.systems?.mlQuests ?? api.mlQuests;
      const active = ml?.listActive?.(mob.serial) ?? [];
      const hasQuest = active.some((q) => q.id === item.questId);
      const isStaff = mob.accessLevel === 'GM' || mob.accessLevel === 'Admin';
      if (!hasQuest && !isStaff) {
        mob.client?.sendSystemMessage?.(
          'A presence forbids you to enter. Speak to the keeper of the Sacred Quest first.',
        );
        // Bounce back two tiles south.
        moveMobile(api, mob, { x: item.x, y: item.y + 2, z: item.z, map: item.map });
        return;
      }
      const t = item.teleportTo;
      if (!t) return;
      moveMobile(api, mob, { x: t.x, y: t.y, z: t.z, map: t.map ?? mob.map });
    },
  });
  // Secret-door already provided by `simple-items.js#buildSecretDoor`;
  // the door we placed above carries `requireItemId` which the existing
  // script consults on use.

  api.log?.('sa-dungeons: Tomb of Kings + Underworld + Exploring the Deep wired');

  return () => {
    unregisterSeed();
    removeLandmarks();
  };
}
