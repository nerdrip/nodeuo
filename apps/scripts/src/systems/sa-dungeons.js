// Stygian Abyss dungeon furniture — port of ServUO
// `Services/Underworld/`, `Services/Tomb of Kings/`, and
// `Services/ExploringTheDeep/`.

import { moveMobile } from '../_movement.js';
import { canCreateItem, createItem, destroyItemBySerial } from '../_items.js';
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

export default function register(api) {
  if (!api.world || !canCreateItem(api, api.world)) return () => {};

  // -------------------------------------------------------------------
  // Tomb of Kings — Sacred Quest blocker.
  //
  // ServUO `SacredQuestBlocker.cs`: an invisible item that bounces any
  // mobile stepping on it back unless their party has the Sacred Quest
  // active. We use the existing `script: 'teleporter'` chassis with a
  // gate that resolves to the same tile (no movement) when the quest is
  // missing, and to the inside tile when it's present.
  const blocker = createItem(api, api.world, {
    itemId: 0x1BCB, hue: 0,           // invisible tile (ServUO 0x1BCB)
    x: 1010, y: 3415, z: -42, map: 4,
    name: 'Sacred Quest Blocker',
    movable: false, visible: false,
    script: 'sa-quest-blocker',
    questId: 'sacred-quest',
    teleportTo: TOMB_DEST_INSIDE,
  });

  // Bridge teleporter — at the bridge entry, drops players into the
  // first chamber.
  const bridge = createItem(api, api.world, {
    itemId: 0x1BCB, hue: 0,
    x: 1010, y: 3420, z: -42, map: 4,
    name: 'Bridge to the Tomb',
    movable: false, visible: false,
    script: 'teleporter',
    teleportTo: { map: 4, x: 1015, y: 3460, z: -50 },
    cooldownMs: 2000,
  });

  // Secret door — requires the tomb key in the mobile's pack. Reuses
  // the standard 'teleporter' script which already honours `requireItemId`
  // and bounces the mobile with a system message when missing.
  const secret = createItem(api, api.world, {
    itemId: 0x0E76, hue: 0x47E,        // closed door, dimly hued
    x: 1015, y: 3470, z: -50, map: 4,
    name: 'Secret Door',
    movable: false,
    script: 'teleporter',
    requireItemId: TOMB_KEY_ITEMID,
    teleportTo: { map: 4, x: 1015, y: 3475, z: -50 },
    cooldownMs: 2000,
  });

  // -------------------------------------------------------------------
  // Underworld — three pit teleporters cascading down and an exit.
  const pit1 = createItem(api, api.world, {
    itemId: 0x1BCB, hue: 0,
    x: UW_LEVEL1.x, y: UW_LEVEL1.y - 6, z: UW_LEVEL1.z, map: 4,
    name: 'Pit (level 1)', movable: false, visible: false,
    script: 'teleporter', teleportTo: UW_LEVEL2, cooldownMs: 2500,
  });
  const pit2 = createItem(api, api.world, {
    itemId: 0x1BCB, hue: 0,
    x: UW_LEVEL2.x, y: UW_LEVEL2.y - 6, z: UW_LEVEL2.z, map: 4,
    name: 'Pit (level 2)', movable: false, visible: false,
    script: 'teleporter', teleportTo: UW_LEVEL3, cooldownMs: 2500,
  });
  const exit = createItem(api, api.world, {
    itemId: 0x1BCB, hue: 0,
    x: UW_LEVEL3.x, y: UW_LEVEL3.y + 4, z: UW_LEVEL3.z, map: 4,
    name: 'Underworld Exit', movable: false, visible: false,
    script: 'teleporter', teleportTo: ROYAL_CITY, cooldownMs: 2500,
  });
  // Same exit accessible from inside the Tomb of Kings.
  const tombExit = createItem(api, api.world, {
    itemId: 0x1BCB, hue: 0,
    x: 1010, y: 3550, z: -50, map: 4,
    name: 'Leave the Tomb', movable: false, visible: false,
    script: 'teleporter', teleportTo: TOMB_DEST_OUTSIDE, cooldownMs: 2500,
  });

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
    const serials = [blocker, bridge, secret, pit1, pit2, exit, tombExit]
      .map((it) => it?.serial).filter(Boolean);
    for (const s of serials) {
      try { destroyItemBySerial(api, s); }
      catch { /* already removed */ }
    }
  };
}
