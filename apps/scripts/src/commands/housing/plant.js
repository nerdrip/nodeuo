// `[plant` — farming + pot-plant routing.
//
//   [plant <crop>            — sow a farmable food crop at your feet
//                              (admin-only; legacy ground-tile path)
//   [plant pot <species>     — spawn a pot-plant seed in your backpack
//   [plant water             — target a pot plant to water it
//   [plant harvest           — target a flowering pot plant for seeds
//   [plant cross             — target two adjacent flowering pots to
//                              cross-pollinate; outputs a hybrid seed
//   [plant list              — print available pot-plant species
//
// Farmable crops live in `items/scripts/world/farmable.js`.
// Decorative pot plants + crossbreeding live in `items/pot-plants.js`.

import { nearbyClients } from '../../_spatial.js';
import { FARMABLE_PLANT_KINDS } from '../../items/scripts/world/farmable.js';
import { itemBySerial } from '../../_entities.js';
import { createItem } from '../../_items.js';
import {
  POT_SPECIES, PLANTABLE_KEYS,
  makePotPlant, waterPotPlant, harvestSeeds, crossPollinate,
} from '../../items/behaviors/pot-plants.js';

export default function register(api) {
  if (!api.commands || !api.world || !api.items) return () => {};

  api.commands.register({
    name: 'plant',
    help: '[plant <crop|pot|water|harvest|cross|list> — farm or grow a pot plant.',
    access: 'Player',
    run(ctx) {
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      const mob = ctx.sender;

      if (sub === 'list') {
        ctx.state.sendSystemMessage(`Farmable crops: ${FARMABLE_PLANT_KINDS.join(', ')}`);
        ctx.state.sendSystemMessage(`Pot plant species: ${PLANTABLE_KEYS.length} (use [plant pot <species>)`);
        const cols = 3;
        const rows = Math.ceil(PLANTABLE_KEYS.length / cols);
        for (let r = 0; r < rows; r++) {
          const line = [];
          for (let c = 0; c < cols; c++) {
            const i = r + c * rows;
            if (i < PLANTABLE_KEYS.length) line.push(PLANTABLE_KEYS[i].padEnd(22));
          }
          ctx.state.sendSystemMessage('  ' + line.join(''));
        }
        return;
      }

      if (sub === 'pot') {
        const species = String(ctx.args[1] ?? '').toLowerCase();
        if (!species || !POT_SPECIES[species] || POT_SPECIES[species].hybridOnly) {
          ctx.state.sendSystemMessage(
            `Usage: [plant pot <species>. Run [plant list to see options.`,
          );
          return;
        }
        const desc = makePotPlant(species, null, mob.map ?? 1, 60, 60, 0);
        const item = api.game?.mobile?.giveItem?.(mob, desc);
        if (!item) { ctx.state.sendSystemMessage('You have no backpack.'); return; }
        item.potPlant = desc.potPlant;
        ctx.state.sendSystemMessage(`A ${POT_SPECIES[species].name} seed appears in your pack.`);
        return;
      }

      if (sub === 'water') {
        ctx.state.sendSystemMessage('Water which plant?');
        api.targeting?.request(ctx.state, (picked) => {
          if (!picked?.serial) return;
          const item = itemBySerial(api, picked.serial >>> 0);
          if (!item?.potPlant) {
            ctx.state.sendSystemMessage('That is not a pot plant.');
            return;
          }
          const r = waterPotPlant(item, mob);
          if (!r.ok) {
            const msg = {
              'not-a-plant':     'That is not a pot plant.',
              'unknown-species': 'Unknown plant species.',
              'already-watered': 'You already watered it recently.',
            }[r.reason] ?? `Cannot water: ${r.reason}`;
            ctx.state.sendSystemMessage(msg);
            return;
          }
          ctx.state.sendSystemMessage(
            r.revived ? 'You revive the withered plant.' : 'You water the plant.',
          );
        }, { kind: 0 });
        return;
      }

      if (sub === 'harvest') {
        ctx.state.sendSystemMessage('Harvest which plant?');
        api.targeting?.request(ctx.state, (picked) => {
          if (!picked?.serial) return;
          const item = itemBySerial(api, picked.serial >>> 0);
          if (!item?.potPlant) { ctx.state.sendSystemMessage('That is not a pot plant.'); return; }
          const r = harvestSeeds(item);
          if (!r.ok) {
            const msg = {
              'not-a-plant':   'That is not a pot plant.',
              'not-flowering': 'Only flowering plants yield seeds.',
              'cooldown':      'You harvested it too recently.',
            }[r.reason] ?? `Cannot harvest: ${r.reason}`;
            ctx.state.sendSystemMessage(msg);
            return;
          }
          for (const seedDesc of r.seeds) {
            const seed = api.game?.mobile?.giveItem?.(mob, {
              ...seedDesc,
              movable: true,
            }, { randomGrid: true });
            if (!seed) { ctx.state.sendSystemMessage('You have no backpack.'); return; }
            seed.potSeed = seedDesc.potSeed;
          }
          ctx.state.sendSystemMessage(`Harvested ${r.seeds.length} seed${r.seeds.length === 1 ? '' : 's'}.`);
        }, { kind: 0 });
        return;
      }

      if (sub === 'cross') {
        ctx.state.sendSystemMessage('Target the FIRST flowering plant.');
        api.targeting?.request(ctx.state, (picked1) => {
          if (!picked1?.serial) return;
          const a = itemBySerial(api, picked1.serial >>> 0);
          if (!a?.potPlant) { ctx.state.sendSystemMessage('Not a plant.'); return; }
          ctx.state.sendSystemMessage('Target the SECOND flowering plant.');
          api.targeting?.request(ctx.state, (picked2) => {
            if (!picked2?.serial) return;
            const b = itemBySerial(api, picked2.serial >>> 0);
            if (!b?.potPlant) { ctx.state.sendSystemMessage('Not a plant.'); return; }
            // Adjacency check — plants must be within 2 tiles of each
            // other (real UO requires them placed in adjacent pots).
            const dx = Math.abs((a.x | 0) - (b.x | 0));
            const dy = Math.abs((a.y | 0) - (b.y | 0));
            if (a.map !== b.map || Math.max(dx, dy) > 2) {
              ctx.state.sendSystemMessage('Plants must be adjacent (within 2 tiles).');
              return;
            }
            const r = crossPollinate(a, b);
            if (!r.ok) {
              const msg = {
                'not-plants':       'Both targets must be pot plants.',
                'need-flowering':   'Both plants must be flowering.',
                'unknown-species':  'Unknown species.',
              }[r.reason] ?? `Cannot cross: ${r.reason}`;
              ctx.state.sendSystemMessage(msg);
              return;
            }
            const seed = api.game?.mobile?.giveItem?.(mob, {
              ...r.seed,
              movable: true,
            });
            if (!seed) { ctx.state.sendSystemMessage('You have no backpack.'); return; }
            seed.potSeed = r.seed.potSeed;
            ctx.state.sendSystemMessage(
              r.hybrid
                ? `Cross-pollination yields a HYBRID seed (${r.seed.name}).`
                : `Cross-pollination yields a ${r.seed.name}.`,
            );
          }, { kind: 0 });
        }, { kind: 0 });
        return;
      }

      // Default — legacy farmable crop path (admin only). Drops a
      // crop sprout at the caller's feet that grows on its own timer.
      const access = ctx.state?.account?.accessLevel ?? 'Player';
      if (access !== 'GM' && access !== 'Admin' && access !== 'Seer') {
        ctx.state.sendSystemMessage('Usage: [plant pot <species> | water | harvest | cross | list');
        return;
      }
      const kind = sub;
      if (!FARMABLE_PLANT_KINDS.includes(kind)) {
        ctx.state.sendSystemMessage(`Crops: ${FARMABLE_PLANT_KINDS.join(', ')}. Or use [plant pot <species> for decorative pots.`);
        return;
      }
      const item = createItem(api, api.world, {
        itemId: 0x18B5, x: mob.x, y: mob.y, z: mob.z,
        map: mob.map ?? 1, name: `${kind} sprout`, movable: false,
      });
      item.script = 'farmable-plant';
      item.farm = { kind };
      const cfgFn = api.itemScripts?.get?.('farmable-plant')?.onCreate;
      if (typeof cfgFn === 'function') cfgFn(api.world, item);
      const wi = api.protocol?.worldItemSA?.({
        serial: item.serial, itemId: item.itemId, hue: item.hue,
        amount: 1, x: item.x, y: item.y, z: item.z,
      });
      if (wi) for (const m of nearbyClients(api.world, item)) m.client.send(wi);
      ctx.state.sendSystemMessage(`You sow ${kind}.`);
    },
  });

  return () => api.commands.unregister('plant');
}
