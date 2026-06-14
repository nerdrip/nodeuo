// FAZA CK / bugfix #53 — NPC honorific title round-trips through
// snapshotWorld / restoreWorld. The compact-paperdoll header builds
// "<name>, <title>" so dropping the title on restart was a visible
// regression ("Mira, the healer" → just "Mira").

import { describe, it, expect } from 'vitest';
import { World } from '../src/world/world.js';
import { snapshotWorld, restoreWorld } from '../src/world/persistence.js';

describe('NPC title persistence (BUGFIX #53)', () => {
  it('snapshotWorld / restoreWorld preserves mob.title', () => {
    const w = new World();
    const npc = w.createMobile({
      name: 'Mira', body: 0x0191, hue: 33770,
      x: 100, y: 100, z: 0, map: 1, notoriety: 1,
    });
    npc.title = 'the healer';
    const snap = snapshotWorld(w);
    const w2 = new World();
    restoreWorld(w2, snap);
    const restored = w2.mobiles.get(npc.serial);
    expect(restored).toBeTruthy();
    expect(restored.title).toBe('the healer');
    expect(restored.name).toBe('Mira');
  });

  it('a mob without title round-trips with title undefined', () => {
    const w = new World();
    const npc = w.createMobile({
      name: 'Plain Person', body: 0x0190, x: 0, y: 0, z: 0, map: 1,
    });
    const snap = snapshotWorld(w);
    const w2 = new World();
    restoreWorld(w2, snap);
    const restored = w2.mobiles.get(npc.serial);
    expect(restored.title).toBeUndefined();
  });
});
