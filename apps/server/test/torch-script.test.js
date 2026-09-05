// PHASE CF — torch script preserves the items.json default unlit graphic
// across toggle cycles (BUGFIX #48). The previous implementation
// hard-coded the toggle pair as 0x0A25 ↔ 0x0A12, but 0x0A25 is the
// LANTERN-lit graphic and 0x0F6B is the unlit torch graphic items.json
// declares — first use silently flipped to the wrong art and the
// natural unlit id was lost forever.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { World } from '../src/world/world.js';
import { createItem } from '../src/world/items.js';
import {
  registerItemScript, unregisterItemScript, dispatchItemEvent,
  allItemScripts,
} from '../src/world/item-scripts.js';
import buildTorchScript from '../../scripts/src/items/scripts/lights/torch.js';

const TORCH_UNLIT_DEFAULT = 0x0F6B;
const TORCH_LIT = 0x0A12;

describe('torch script (PHASE CF)', () => {
  let preExistingScripts;
  /** @type {*} */
  let api;

  beforeEach(() => {
    preExistingScripts = new Set(allItemScripts().map((s) => s.name));
    api = {
      protocol: { worldItemSA: () => new Uint8Array([0xF3]) },
      log: () => {},
    };
    registerItemScript(buildTorchScript(api));
  });
  afterEach(() => {
    if (!preExistingScripts.has('torch')) unregisterItemScript('torch');
  });

  it('toggles to lit on first use, preserving the original itemId for snuff', () => {
    const w = new World();
    const item = createItem(w, { itemId: TORCH_UNLIT_DEFAULT, x: 0, y: 0, z: 0, map: 1 });
    item.script = 'torch';
    dispatchItemEvent(w, item, 'onUse', { client: { sendSystemMessage: () => {} } });
    expect(item._lit).toBe(true);
    expect(item.itemId).toBe(TORCH_LIT);
    expect(item._unlitId).toBe(TORCH_UNLIT_DEFAULT);
  });

  it('snuff restores the captured original itemId, not a hard-coded constant', () => {
    const w = new World();
    const item = createItem(w, { itemId: TORCH_UNLIT_DEFAULT, x: 0, y: 0, z: 0, map: 1 });
    item.script = 'torch';
    const user = { client: { sendSystemMessage: () => {} } };
    dispatchItemEvent(w, item, 'onUse', user);  // light
    dispatchItemEvent(w, item, 'onUse', user);  // snuff
    expect(item._lit).toBe(false);
    expect(item.itemId).toBe(TORCH_UNLIT_DEFAULT);
  });

  it('handles a torch spawned with the lit graphic + _lit=true — captures fallback unlit id', () => {
    const w = new World();
    // Spawn pre-lit (legacy persistence might have a torch saved in
    // its lit form). The script captures the fallback unlit id and
    // toggles correctly on next use.
    const item = createItem(w, { itemId: TORCH_LIT, x: 0, y: 0, z: 0, map: 1 });
    item.script = 'torch';
    item._lit = true;
    const user = { client: { sendSystemMessage: () => {} } };
    dispatchItemEvent(w, item, 'onUse', user);  // toggle from lit-spawned → unlit
    expect(item._lit).toBe(false);
    expect(item.itemId).toBe(TORCH_UNLIT_DEFAULT);
  });

  it('onUnequip auto-snuffs while preserving the unlit id', () => {
    const w = new World();
    const item = createItem(w, { itemId: TORCH_UNLIT_DEFAULT, x: 0, y: 0, z: 0, map: 1 });
    item.script = 'torch';
    item.layer = 1;
    const user = { client: { sendSystemMessage: () => {} } };
    dispatchItemEvent(w, item, 'onUse', user);  // light
    dispatchItemEvent(w, item, 'onUnequip', { });  // remove from hand
    expect(item._lit).toBe(false);
    expect(item.itemId).toBe(TORCH_UNLIT_DEFAULT);
  });

  it('onDestroy clears state so a destroyed torch leaves no leak', () => {
    const w = new World();
    const item = createItem(w, { itemId: TORCH_UNLIT_DEFAULT, x: 0, y: 0, z: 0, map: 1 });
    item.script = 'torch';
    dispatchItemEvent(w, item, 'onUse', { client: { sendSystemMessage: () => {} } });
    expect(item._lit).toBe(true);
    dispatchItemEvent(w, item, 'onDestroy');
    expect(item._lit).toBeUndefined();
    expect(item._unlitId).toBeUndefined();
  });
});
