// Doom Gauntlet entrance — 4-lever puzzle + controller registration.
//
// Places 4 lever items in the Doom entrance room, wires them to a
// shared `LeverPuzzleController`. On solve, broadcasts an unsealed
// notice + opens the gauntlet portcullis (paired item via _portcullis).

import { allMobiles } from '../_spatial.js';
import { mobileBySerial } from '../_entities.js';
import { canCreateItem, createItem, destroyItemBySerial } from '../_items.js';

const PUZZLE_KEY = 'doom-entrance';

// Doom gauntlet entrance — Felucca facet 0 historical coordinates.
const ROOM = { map: 1, cx: 2526, cy: 900, cz: -50, radius: 12 };
const LEVER_TILES = [
  { x: 2519, y: 895, z: -50 },
  { x: 2519, y: 897, z: -50 },
  { x: 2519, y: 899, z: -50 },
  { x: 2519, y: 901, z: -50 },
];
const PORTCULLIS_TILE = { x: 2526, y: 904, z: -50 };

export default function register(api) {
  if (!canCreateItem(api, api.world)) return () => {};
  const doomLeverMod = api.systems?.doomLeverPuzzle;
  const { LeverPuzzleController, registerLeverPuzzle } = doomLeverMod ?? {};
  if (!LeverPuzzleController || !registerLeverPuzzle) {
    api.log?.('doom-lever-puzzle: system unavailable');
    return () => {};
  }

  // Place levers.
  const levers = [];
  for (let i = 0; i < LEVER_TILES.length; i++) {
    const t = LEVER_TILES[i];
    const lv = createItem(api, api.world, {
      itemId: 0x108C, hue: 0,
      x: t.x, y: t.y, z: t.z, map: ROOM.map,
      name: `Doom Lever #${i + 1}`,
      movable: false,
      script: 'doom-lever',
    });
    lv._leverIndex = i;
    lv._leverCtrl = PUZZLE_KEY;
    levers.push(lv);
  }

  // Portcullis (gauntlet entry seal). Closed graphic 0x6588; open 0x6589.
  const portcullis = createItem(api, api.world, {
    itemId: 0x6588, hue: 0x47E,
    x: PORTCULLIS_TILE.x, y: PORTCULLIS_TILE.y, z: PORTCULLIS_TILE.z,
    map: ROOM.map,
    name: 'Doom Gauntlet Seal',
    movable: false,
    door: { isOpen: false, openId: 0x6589, closedId: 0x6588 },
    solid: true,
  });

  // Controller — onSolved unseals the portcullis + emits a broadcast.
  const ctrl = new LeverPuzzleController(api.world, {
    ...ROOM,
    onSolved: (world, c, solverSerial) => {
      try {
        portcullis.door.isOpen = true;
        portcullis.itemId = portcullis.door.openId;
        portcullis.solid = false;
        const pkt = api.protocol?.worldItemSA?.({
          serial: portcullis.serial, itemId: portcullis.itemId, hue: portcullis.hue,
          amount: 1, x: portcullis.x, y: portcullis.y, z: portcullis.z,
        });
        if (pkt) {
          for (const m of allMobiles({ world })) {
            if (!m.client) continue;
            if (m.map !== portcullis.map) continue;
            if (Math.abs(m.x - portcullis.x) > 18 || Math.abs(m.y - portcullis.y) > 18) continue;
            m.client.send(pkt);
          }
        }
        const solver = mobileBySerial({ world }, solverSerial >>> 0);
        if (solver?.client) {
          solver.client.sendSystemMessage?.('The seal slides aside. The Doom Gauntlet beckons.');
        }
        // Re-seal after 60s so the next group has to re-solve.
        setTimeout(() => {
          portcullis.door.isOpen = false;
          portcullis.itemId = portcullis.door.closedId;
          portcullis.solid = true;
          c.reset();
          const wi2 = api.protocol?.worldItemSA?.({
            serial: portcullis.serial, itemId: portcullis.itemId, hue: portcullis.hue,
            amount: 1, x: portcullis.x, y: portcullis.y, z: portcullis.z,
          });
          if (wi2) {
            for (const m of allMobiles({ world })) {
              if (!m.client) continue;
              if (m.map !== portcullis.map) continue;
              if (Math.abs(m.x - portcullis.x) > 18 || Math.abs(m.y - portcullis.y) > 18) continue;
              m.client.send(wi2);
            }
          }
        }, 60_000).unref?.();
      } catch (e) { console.error('[doom-lever] solve handler threw:', e); }
    },
  });
  registerLeverPuzzle(PUZZLE_KEY, ctrl);
  // Expose the puzzle module on `api.systems` so the doom-lever item
  // script can resolve the controller via `getLeverPuzzle`.
  api.log?.('[doom-lever-puzzle] entrance puzzle wired (4 levers + seal)');

  return () => {
    for (const it of [...levers, portcullis]) {
      try { destroyItemBySerial(api, it.serial); } catch { /* defensive */ }
    }
  };
}
