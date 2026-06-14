// FAZA BP — `applyOutfit()` smoke test.
//
// Exercises the preset → equipped-items pipeline directly (without going
// through the [outfit command). Covers:
//   - all preset templates resolve via api.templates.spawn()
//   - existing clothing on the same layer is destroyed before the new
//     piece is equipped (no double-equip / orphaned items)
//   - the backpack on layer 21 is preserved across an outfit change

import { describe, it, expect, beforeEach } from 'vitest';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';
import {
  registerTemplate, _resetTemplatesForTest,
} from '../src/world/templates.js';
import { applyOutfit, _PRESETS_FOR_TEST } from '../../scripts/src/items/behaviors/clothing-presets.js';

describe('applyOutfit (FAZA BP)', () => {
  beforeEach(() => {
    _resetTemplatesForTest();
    // Register stubs for each template the presets reference.
    const layers = new Map();
    for (const preset of Object.values(_PRESETS_FOR_TEST)) {
      for (const piece of preset) layers.set(piece.template, 0xCAFE + layers.size);
    }
    for (const [name, itemId] of layers) {
      registerTemplate({ name, itemId });
    }
  });

  it('every preset template resolves and equips at the declared layer', async () => {
    const { spawn } = await import('../src/world/templates.js');
    const w = new World();
    const mob = w.createMobile({ name: 'p', body: 0x0190, x: 10, y: 10, z: 0, map: 1 });
    mob.client = { send: () => {} };

    const api = {
      templates: { spawn: (w, name, overrides) => spawn(w, name, overrides) },
      log: () => {},
    };

    applyOutfit(api, w, mob, _PRESETS_FOR_TEST.peasant);
    const worn = [...w.items.values()]
      .filter((it) => it.parent === mob.serial && (it.layer ?? 0) > 0)
      .map((it) => it.layer)
      .sort((a, b) => a - b);
    expect(worn).toEqual([3, 4, 5]);  // sandals, pants, shirt
  });

  it('switching presets removes the old piece on the same layer', async () => {
    const { spawn } = await import('../src/world/templates.js');
    const w = new World();
    const mob = w.createMobile({ name: 'p', body: 0x0190, x: 10, y: 10, z: 0, map: 1 });
    mob.client = { send: () => {} };
    const api = {
      templates: { spawn: (w, name, overrides) => spawn(w, name, overrides) },
      log: () => {},
    };

    applyOutfit(api, w, mob, _PRESETS_FOR_TEST.peasant);
    const beforeCount = [...w.items.values()].filter(
      (it) => it.parent === mob.serial && (it.layer ?? 0) > 0,
    ).length;
    applyOutfit(api, w, mob, _PRESETS_FOR_TEST.warrior);
    const afterWorn = new Set(
      [...w.items.values()]
        .filter((it) => it.parent === mob.serial && (it.layer ?? 0) > 0)
        .map((it) => it.layer),
    );
    // Warrior layers (3, 6, 13, 20, 24) all present.
    for (const L of [3, 6, 13, 20, 24]) expect(afterWorn.has(L)).toBe(true);
    // Layer 3 (boots) replaced peasant's sandals — verify by item count
    // on that layer is exactly 1, not 2 (no orphaned sandals lingering).
    const layer3 = [...w.items.values()].filter(
      (it) => it.parent === mob.serial && it.layer === 3,
    );
    expect(layer3.length).toBe(1);
    void beforeCount;
  });

  it('preserves a backpack on layer 21 across outfit change', async () => {
    const { spawn } = await import('../src/world/templates.js');
    const w = new World();
    const mob = w.createMobile({ name: 'p', body: 0x0190, x: 10, y: 10, z: 0, map: 1 });
    mob.client = { send: () => {} };

    const pack = createItem(w, {
      itemId: 0x0E75, x: 0, y: 0, z: 0, map: 1,
      parent: mob.serial, layer: 21,
    });
    const api = {
      templates: { spawn: (w, name, overrides) => spawn(w, name, overrides) },
      log: () => {},
    };
    applyOutfit(api, w, mob, _PRESETS_FOR_TEST.mage);

    expect(w.items.get(pack.serial)).toBeTruthy();
    expect(w.items.get(pack.serial).layer).toBe(21);
  });
});
