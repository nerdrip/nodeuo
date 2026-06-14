// FAZA DA — bugfix #69 regression: broadcastHealthUpdate ships 0xA1 to
// BOTH the mob's own client AND nearby observers. Mass-heal spells
// were previously single-recipient, so observer health bars stayed
// stale on every Arch Cure / Noble Sacrifice.

import { describe, it, expect } from 'vitest';
import { World } from '../src/world/world.js';
import { broadcastHealthUpdate } from '../../scripts/src/spells/_helpers.js';

function fakeApi() {
  return {
    protocol: {
      // Build a marker packet: 0xA1 op + serial bytes so tests can
      // recover the target serial from the buffer.
      healthUpdate: (e) => new Uint8Array([
        0xA1,
        (e.serial >> 24) & 0xFF, (e.serial >> 16) & 0xFF,
        (e.serial >> 8) & 0xFF, e.serial & 0xFF,
        (e.max >> 8) & 0xFF, e.max & 0xFF,
        (e.current >> 8) & 0xFF, e.current & 0xFF,
      ]),
    },
  };
}

describe('broadcastHealthUpdate (bugfix #69)', () => {
  it('sends 0xA1 to the mob AND nearby observers', () => {
    const w = new World();
    const subjectSent = [];
    const observerSent = [];
    const farSent = [];
    const subject = w.createMobile({
      name: 's', body: 0x190, x: 100, y: 100, z: 0, map: 1,
      hp: 50, hpMax: 100,
    });
    subject.client = { send: (b) => subjectSent.push(b) };
    const observer = w.createMobile({
      name: 'o', body: 0x190, x: 102, y: 100, z: 0, map: 1,
    });
    observer.client = { send: (b) => observerSent.push(b) };
    const far = w.createMobile({
      name: 'far', body: 0x190, x: 5000, y: 5000, z: 0, map: 1,
    });
    far.client = { send: (b) => farSent.push(b) };

    broadcastHealthUpdate(fakeApi(), w, subject);

    expect(subjectSent.length).toBe(1);
    expect(observerSent.length).toBe(1);
    expect(farSent.length).toBe(0);
    expect(subjectSent[0][0]).toBe(0xA1);
  });

  it('skips broadcast when api.protocol.healthUpdate is missing', () => {
    const w = new World();
    const subject = w.createMobile({
      name: 's', body: 0x190, x: 0, y: 0, z: 0, map: 1, hp: 10, hpMax: 50,
    });
    expect(() => broadcastHealthUpdate({ protocol: {} }, w, subject)).not.toThrow();
  });

  it('respects map boundaries', () => {
    const w = new World();
    const subject = w.createMobile({
      name: 's', body: 0x190, x: 0, y: 0, z: 0, map: 1, hp: 50, hpMax: 100,
    });
    const otherMap = w.createMobile({
      name: 'o', body: 0x190, x: 0, y: 0, z: 0, map: 0,
    });
    const sent = [];
    otherMap.client = { send: (b) => sent.push(b) };
    broadcastHealthUpdate(fakeApi(), w, subject);
    expect(sent.length).toBe(0);
  });
});
