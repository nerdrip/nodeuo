// Doom Gauntlet entrance — 4-lever puzzle + controller registration.
// Physical landmarks are owned by `[createworld`; the behaviour remains
// registered on a clean shard without silently repopulating it at boot.

import { allItems, allMobiles } from '../_spatial.js';
import { itemBySerial, mobileBySerial } from '../_entities.js';
import { canCreateItem, createItem, destroyItemBySerial } from '../_items.js';
import { registerWorldContentSeed } from '../_world-content.js';

const PUZZLE_KEY = 'doom-entrance';
const ROOM = { map: 1, cx: 2526, cy: 900, cz: -50, radius: 12 };
const LEVER_TILES = [
  { x: 2519, y: 895, z: -50 },
  { x: 2519, y: 897, z: -50 },
  { x: 2519, y: 899, z: -50 },
  { x: 2519, y: 901, z: -50 },
];
const PORTCULLIS_TILE = { x: 2526, y: 904, z: -50 };
const CONTENT_NAMES = new Set([
  ...LEVER_TILES.map((_, index) => `Doom Lever #${index + 1}`),
  'Doom Gauntlet Seal',
]);

export default function register(api) {
  if (!api.world) return () => {};
  const doomLeverMod = api.systems?.doomLeverPuzzle;
  const { LeverPuzzleController, registerLeverPuzzle, unregisterLeverPuzzle } = doomLeverMod ?? {};
  if (!LeverPuzzleController || !registerLeverPuzzle) {
    api.log?.('doom-lever-puzzle: system unavailable');
    return () => {};
  }

  let levers = [];
  let portcullis = null;
  let ctrl = null;
  let resealTimer = null;

  const existingAt = (name, tile) => [...allItems(api)].find((item) =>
    item.name === name && item.map === ROOM.map && item.x === tile.x &&
    item.y === tile.y && item.z === tile.z);

  const unregisterController = () => {
    if (typeof resealTimer?.cancel === 'function') resealTimer.cancel();
    else if (resealTimer) clearTimeout(resealTimer);
    resealTimer = null;
    ctrl?.reset?.();
    unregisterLeverPuzzle?.(PUZZLE_KEY, ctrl);
    ctrl = null;
  };

  const wireController = () => {
    unregisterController();
    if (!portcullis) return;
    ctrl = new LeverPuzzleController(api.world, {
      ...ROOM,
      onSolved: (world, controller, solverSerial) => {
        try {
          if (!itemBySerial(api, portcullis.serial)) return;
          portcullis.door ??= { isOpen: false, openId: 0x6589, closedId: 0x6588 };
          portcullis.door.isOpen = true;
          portcullis.itemId = portcullis.door.openId;
          portcullis.solid = false;
          const sendSeal = () => {
            const packet = api.protocol?.worldItemSA?.({
              serial: portcullis.serial, itemId: portcullis.itemId, hue: portcullis.hue,
              amount: 1, x: portcullis.x, y: portcullis.y, z: portcullis.z,
            });
            if (!packet) return;
            for (const mobile of allMobiles({ world })) {
              if (!mobile.client || mobile.map !== portcullis.map) continue;
              if (Math.abs(mobile.x - portcullis.x) > 18 || Math.abs(mobile.y - portcullis.y) > 18) continue;
              mobile.client.send(packet);
            }
          };
          sendSeal();
          const solver = mobileBySerial({ world }, solverSerial >>> 0);
          solver?.client?.sendSystemMessage?.('The seal slides aside. The Doom Gauntlet beckons.');
          const schedule = api.lifecycle?.setTimeout ?? setTimeout;
          resealTimer = schedule(() => {
            resealTimer = null;
            if (!itemBySerial(api, portcullis.serial)) return;
            portcullis.door.isOpen = false;
            portcullis.itemId = portcullis.door.closedId;
            portcullis.solid = true;
            controller.reset();
            sendSeal();
          }, 60_000);
          resealTimer?.unref?.();
        } catch (error) {
          api.log?.(`[doom-lever] solve handler threw: ${error.stack ?? error.message}`);
        }
      },
    });
    registerLeverPuzzle(PUZZLE_KEY, ctrl);
  };

  const applyPuzzle = (opts = {}) => {
    if (opts.facets && !opts.facets.includes(ROOM.map)) return { added: 0 };
    if (!canCreateItem(api, api.world)) return { added: 0, failed: 1 };
    let added = 0;
    levers = LEVER_TILES.map((tile, index) => {
      const name = `Doom Lever #${index + 1}`;
      let lever = existingAt(name, tile);
      if (!lever) {
        lever = createItem(api, api.world, {
          itemId: 0x108C, hue: 0, ...tile, map: ROOM.map, name,
          movable: false, script: 'doom-lever',
        });
        added++;
      }
      lever._leverIndex = index;
      lever._leverCtrl = PUZZLE_KEY;
      lever._worldContentSeed = 'doom-lever-puzzle';
      return lever;
    });
    portcullis = existingAt('Doom Gauntlet Seal', PORTCULLIS_TILE);
    if (!portcullis) {
      portcullis = createItem(api, api.world, {
        itemId: 0x6588, hue: 0x47E, ...PORTCULLIS_TILE, map: ROOM.map,
        name: 'Doom Gauntlet Seal', movable: false,
        door: { isOpen: false, openId: 0x6589, closedId: 0x6588 }, solid: true,
      });
      added++;
    }
    portcullis._worldContentSeed = 'doom-lever-puzzle';
    wireController();
    api.log?.('[doom-lever-puzzle] entrance puzzle wired (4 levers + seal)');
    return { added };
  };

  const removePuzzle = (opts = {}) => {
    if (opts.facets && !opts.facets.includes(ROOM.map)) return { removed: 0 };
    unregisterController();
    const serials = new Set();
    for (const item of allItems(api)) {
      if (item._worldContentSeed === 'doom-lever-puzzle' || CONTENT_NAMES.has(item.name)) {
        serials.add(item.serial >>> 0);
      }
    }
    for (const item of [...levers, portcullis]) if (item) serials.add(item.serial >>> 0);
    let removed = 0;
    for (const serial of serials) {
      try { if (itemBySerial(api, serial)) { destroyItemBySerial(api, serial); removed++; } }
      catch (error) { api.log?.(`[doom-lever] remove failed: ${error.message}`); }
    }
    levers = [];
    portcullis = null;
    return { removed };
  };

  const unregisterSeed = registerWorldContentSeed(api, 'doom-lever-puzzle', {
    apply: applyPuzzle,
    remove: removePuzzle,
  });
  if (api.world._createWorldDone !== false) applyPuzzle();

  return () => {
    unregisterSeed();
    removePuzzle();
  };
}
