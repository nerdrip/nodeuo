// Damageable item kinds — registers world-item kinds that take HP damage
// (Beacon, Chaos Blocker, Myrmidex Egg, Pumpkin, etc.) into the server's
// damageableItems engine. Each kind may carry an onDestroyed callback,
// which is why this lives as JS rather than JSON.

import { createItem } from '../../_items.js';

export default function register(api) {
  const sys = api.systems?.damageableItems;
  if (!sys?.registerDamageableKind) {
    api.log?.('damageable: engine API missing, skipping');
    return () => {};
  }
  const r = sys.registerDamageableKind;

  // ---- Quest / event objects ----
  r('beacon', {
    itemId: 0x1F1C, hp: 500, hpMax: 500, name: 'a beacon',
    onDestroyed(world, beacon, killer) {
      killer?.client?.sendSystemMessage?.('The beacon shatters!');
    },
  });
  r('chaos-blocker', {
    itemId: 0x1108, hp: 1000, hpMax: 1000, name: 'a chaos blocker',
  });
  r('myrmidex-egg', {
    itemId: 0x10A0, hp: 50, hpMax: 50, name: 'a myrmidex egg cluster',
    onDestroyed(world, _item, killer) {
      if (killer?.account) {
        const ps = world?.systems?.pointsSystems;
        ps?.award?.(killer.account, 'myrmidex', 5);
      }
    },
  });
  r('tribal-totem', {
    itemId: 0x1F19, hp: 200, hpMax: 200, name: 'a tribal totem',
    onDestroyed(world, item, killer) {
      killer?.client?.sendSystemMessage?.('The totem crumbles.');
    },
  });
  r('orc-banner', {
    itemId: 0x1F1A, hp: 80, hpMax: 80, name: 'an orc war-banner',
  });

  // ---- Practice / training dummies ----
  r('training-dummy-east',  { itemId: 0x1070, hp: 9999, hpMax: 9999, name: 'a training dummy' });
  r('training-dummy-south', { itemId: 0x1074, hp: 9999, hpMax: 9999, name: 'a training dummy' });
  r('archery-butte-east',   { itemId: 0x100A, hp: 9999, hpMax: 9999, name: 'an archery butte' });
  r('archery-butte-south',  { itemId: 0x100B, hp: 9999, hpMax: 9999, name: 'an archery butte' });

  // ---- Halloween jack-o-lantern (chance for pumpkin pie drop) ----
  r('jack-o-lantern', {
    itemId: 0x0C6A, hp: 40, hpMax: 40, name: 'a jack-o-lantern',
    onDestroyed(world, item, _killer) {
      if (Math.random() < 0.10) {
        createItem(api, world, {
          itemId: 0x171F, name: 'a pumpkin pie reward', hue: 0x0481,
          x: item.x, y: item.y, z: item.z, map: item.map,
        });
      }
    },
  });

  // ---- Misc training / quest objects ----
  r('practice-barrel',   { itemId: 0x0E77, hp: 60, hpMax: 60, name: 'a practice barrel' });
  r('combat-mannequin',  { itemId: 0x1F1B, hp: 200, hpMax: 200, name: 'a combat mannequin' });
  r('despise-pillar', {
    itemId: 0x1F1C, hue: 0x0480, hp: 600, hpMax: 600, name: 'a despise pillar',
    onDestroyed(world, item, killer) {
      killer?.client?.sendSystemMessage?.('The pillar collapses, freeing trapped souls!');
    },
  });
  r('bedlam-barricade', {
    itemId: 0x1E5E, hp: 800, hpMax: 800, name: 'a bedlam barricade',
  });
  r('khaldun-sarcophagus', {
    itemId: 0x1C5C, hp: 1500, hpMax: 1500, name: 'a Khaldun sarcophagus',
    onDestroyed(world, item, killer) {
      if (killer?.account) {
        const ps = world?.systems?.pointsSystems;
        ps?.award?.(killer.account, 'khaldun', 50);
      }
    },
  });

  api.log?.('damageable: registered 15 damageable kinds');
  return () => {
    for (const k of sys.listKinds()) sys.unregisterDamageableKind?.(k);
  };
}
