// `[tmap` — admin / player commands for the treasure-map system.
// Wires apps/server/src/systems/treasure-maps.js to in-game commands:
//
//   [tmap make <level> [x y]   — admin: create a treasure map item in pack
//   [tmap decode               — try to decode held map (uses Cartography)
//   [tmap dig                  — dig at current location for the held map
//
// Server-side resolution still runs through `api.systems.treasureMaps`;
// this script just provides the convenience commands.

import { effectiveSkill } from '../../_rules.js';
import { allItems } from '../../_spatial.js';
import { itemBySerial } from '../../_entities.js';

function isInPack(world, item, mob) {
  let parent = item?.parent;
  for (let depth = 0; depth < 8 && parent != null; depth++) {
    if (parent === mob.serial) return true;
    parent = itemBySerial({ world }, parent)?.parent;
  }
  return false;
}

export default function register(api) {
  if (!api.commands) return () => {};
  const treasureMaps = api.systems?.treasureMaps;
  if (!treasureMaps) {
    api.log?.('tmap: treasure maps system unavailable');
    return () => {};
  }

  api.commands.register({
    name: 'tmap',
    help: '[tmap make|decode|dig — treasure-map ops.',
    access: 'Player',
    run(ctx) {
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      const sender = ctx.sender;

      if (sub === 'make') {
        if (!ctx.checkAccess?.('Admin')) {
          ctx.state.sendSystemMessage('Admin only.');
          return;
        }
        // Level 7 is the Stygian-Abyss "Trove" map — extra-deep loot
        // pool (Crystalline Ring + SA artifacts), 4-6k gold base,
        // L7-tier guardians (Ancient Lich pool). Was clamped at 6.
        const lvl = Math.max(1, Math.min(7, Number(ctx.args[1] ?? 1) | 0));
        const x = Number(ctx.args[2] ?? sender.x) | 0;
        const y = Number(ctx.args[3] ?? sender.y) | 0;
        const desc = treasureMaps.createTreasureMap({ level: lvl, x, y, map: sender.map });
        const { treasureMap, ...itemData } = desc;
        const it = api.game?.mobile?.giveItem?.(sender, itemData, { randomGrid: true });
        if (!it) {
          ctx.state.sendSystemMessage('You have no backpack for the treasure map.');
          return;
        }
        it.treasureMap = treasureMap;
        // Paragon roll — 5% chance the dug chest will spawn as a
        // paragon (hue 0x501 orange, +50% gold, +30% magic count,
        // 1.5× harder guardians). Surface in the map name so the
        // player knows what they're walking into. ServUO's "Paragon
        // Chest" mechanic, post-AOS.
        if (Math.random() < 0.05) {
          it.treasureMap.paragon = true;
          it.name = `${it.name} (Paragon)`;
        }
        ctx.state.sendSystemMessage(
          `Spawned a level ${lvl} map → (${x},${y})${it.treasureMap.paragon ? ' [PARAGON]' : ''}.`,
        );
        return;
      }

      // Find a treasure map in the player's pack.
      const map = (() => {
        for (const it of allItems(api)) {
          if (isInPack(api.world, it, sender) && it.treasureMap) return it;
        }
        return null;
      })();
      if (!map) {
        ctx.state.sendSystemMessage('You have no treasure map in your pack.');
        return;
      }

      if (sub === 'decode') {
        const ok = treasureMaps.decodeTreasureMap(sender, map, { effectiveSkill });
        if (ok && map.treasureMap.paragon) {
          ctx.state.sendSystemMessage(
            '⚠ The map is marked with a paragon sigil — guardians will be stronger.',
          );
        }
        if (ok) {
          // Sextant-style readout — UO calls this "navigation coordinates".
          //   X = (x - 1024) / 16 → degrees east-of-Britain
          //   Y = (y - 1024) / 16 → degrees south-of-Britain
          // ServUO `Items/SkillItems/Sextant.cs` formula. Keeps decimal
          // precision to one minute.
          const t = map.treasureMap;
          const xDeg = ((t.x - 1024) / 16);
          const yDeg = ((t.y - 1024) / 16);
          const xH = xDeg >= 0 ? 'E' : 'W';
          const yH = yDeg >= 0 ? 'S' : 'N';
          const xMin = Math.floor(Math.abs(xDeg % 1) * 60);
          const yMin = Math.floor(Math.abs(yDeg % 1) * 60);
          const sextant = `${Math.abs(yDeg)|0}° ${yMin}'${yH}, ${Math.abs(xDeg)|0}° ${xMin}'${xH}`;
          ctx.state.sendSystemMessage(`Map decoded: ${t.x},${t.y}.`);
          ctx.state.sendSystemMessage(`  Navigator's reading: ${sextant}`);
          ctx.state.sendSystemMessage(`  Facet: ${t.map === 0 ? 'Felucca' : t.map === 1 ? 'Trammel' : t.map === 2 ? 'Ilshenar' : t.map === 3 ? 'Malas' : t.map === 4 ? 'Tokuno' : t.map === 5 ? 'Ter Mur' : 'Unknown'}`);
          ctx.state.sendSystemMessage(`  Level: ${t.level} of 7`);
        } else {
          const need = (() => {
            const t = map.treasureMap;
            // Level-7 Trove maps require 105 Carto (SA cap) — mirrors
            // the LEVEL_REQ_CARTO table in treasure-maps.js.
            return [24, 50, 70, 80, 90, 100, 105][t.level - 1] ?? 100;
          })();
          ctx.state.sendSystemMessage(`Your Cartography is too low (need ${need}).`);
        }
        return;
      }

      if (sub === 'dig') {
        const r = treasureMaps.digForTreasure(sender, map);
        if (!r.ok) {
          const msg = {
            'not-decoded': 'Decode the map first.',
            'wrong-spot':  'You must be at the marked location.',
            'wrong-map':   'You are on the wrong facet.',
            'already-dug': 'This map has already been dug.',
          }[r.reason] ?? `Dig failed: ${r.reason}.`;
          ctx.state.sendSystemMessage(msg);
          return;
        }
        const { chest, guardians } = treasureMaps.spawnTreasureChest(
          api.world, r.level, r.x, r.y, r.map,
          {
            rollMagicProperties: api.loot?.rollMagicProperties,
            // Paragon flag is read by spawnTreasureChest if the system
            // supports it; we also stash on the chest so the [disarm
            // / loot path can apply the +50% gold post-spawn.
            paragon: !!map.treasureMap.paragon,
            kindsByLevel: {
              1: ['skeleton','orc','ratman'],
              2: ['orc','troll','lizardman'],
              3: ['troll','ettin','ogre'],
              4: ['ogre-lord','elder-gazer','daemon'],
              5: ['daemon','poison-elemental','lich'],
              6: ['ancient-lich','ancient-wyrm','daemon'],
              // L7 Trove pool — Stygian Abyss endgame mobs. Drops
              // include Crystalline Ring + SA artifacts (loot table
              // wired via api.loot.rollMagicProperties tier=7).
              7: ['ancient-lich','ancient-wyrm','greater-dragon','succubus'],
            },
          },
        );
        // Paragon chest post-process: hue the chest gold-orange so it
        // visually pops, and stamp the flag so disarm/loot apply
        // bonuses. Hue 0x501 matches ServUO `BaseCreature.PARAGON_HUE`.
        if (map.treasureMap.paragon && chest) {
          chest.hue = 0x501;
          chest.paragon = true;
          // Buff guardians' HP × 4 (ServUO paragon canon: HP×4 + Str×2)
          for (const g of guardians) {
            if (g.hp != null) g.hp = Math.floor(g.hp * 4);
            if (g.hpMax != null) g.hpMax = Math.floor(g.hpMax * 4);
            if (g.str != null) g.str = Math.floor(g.str * 2);
            g.paragon = true;
          }
        }
        ctx.state.sendSystemMessage(
          `You dig up a${map.treasureMap.paragon ? ' PARAGON' : ''} treasure chest! ${guardians.length} guardian(s) appear.`,
        );
        return;
      }

      ctx.state.sendSystemMessage('Usage: [tmap make|decode|dig');
    },
  });

  return () => api.commands.unregister('tmap');
}
