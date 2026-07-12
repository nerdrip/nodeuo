import { describe, expect, it } from 'vitest';
import { repairGeneratedTeleporters } from '../../scripts/src/commands/admin/telgen.js';

describe('telgen hidden anchors', () => {
  it('repairs only generated decorations and leaves visible custom gates alone', () => {
    const generated = {
      serial: 0x40000001, itemId: 0x1BC3, visible: true,
      script: 'teleporter', isDecoration: true,
      x: 10, y: 20, z: 0, map: 1,
      teleportTo: { x: 30, y: 40, z: 0, map: 1 },
    };
    const customGate = {
      serial: 0x40000002, itemId: 0x1BC3, visible: true,
      script: 'teleporter', isDecoration: false,
      x: 11, y: 20, z: 0, map: 1,
      teleportTo: { x: 31, y: 40, z: 0, map: 1 },
    };
    const api = { world: { items: new Map([[generated.serial, generated], [customGate.serial, customGate]]) } };

    const result = repairGeneratedTeleporters(api);

    expect(result.repaired).toBe(1);
    expect(generated.visible).toBe(false);
    expect(generated.itemId).toBe(0x1BCB);
    expect(customGate.visible).toBe(true);
    expect(customGate.itemId).toBe(0x1BC3);
  });
});
