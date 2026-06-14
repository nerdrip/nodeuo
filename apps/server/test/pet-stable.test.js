import { describe, it, expect } from 'vitest';
import { stable } from '../src/systems/pets/pet-stable.js';

const mkMaster = () => ({ serial: 1 });
const mkPet = (master) => ({
  serial: 100, kind: 'dog', name: 'Rex',
  body: 0x00D9, hue: 0,
  hp: 50, hpMax: 60, mana: 0, manaMax: 0, stam: 30, stamMax: 30,
  controlMaster: master.serial,
  bonded: false, hunger: 18, loyalty: 100,
});

describe('pet-stable', () => {
  it('deposit + list + withdraw round-trip', () => {
    const master = mkMaster();
    const pet = mkPet(master);
    const r1 = stable.deposit({}, master, pet);
    expect(r1.ok).toBe(true);
    expect(r1.slot).toBe(0);
    expect(stable.list(master).length).toBe(1);

    const r2 = stable.withdraw({}, master, 0);
    expect(r2.ok).toBe(true);
    expect(r2.snapshot.kind).toBe('dog');
    expect(r2.snapshot.name).toBe('Rex');
    expect(stable.list(master).length).toBe(0);
  });

  it('refuses if pet not owned by master', () => {
    const master = mkMaster();
    const stranger = { serial: 999 };
    const pet = mkPet(stranger);
    const r = stable.deposit({}, master, pet);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not-yours');
  });

  it('respects slot cap', () => {
    const master = { serial: 1, stableSlots: 2 };
    for (let i = 0; i < 2; i++) stable.deposit({}, master, mkPet(master));
    const r = stable.deposit({}, master, mkPet(master));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no-slots');
  });

  it('marks pet >30 days as lost', () => {
    const master = mkMaster();
    const pet = mkPet(master);
    stable.deposit({}, master, pet);
    // Backdate the entry.
    master._stable[0].stabledAt = Date.now() - 31 * 86_400_000;
    const r = stable.withdraw({}, master, 0);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('lost');
    expect(r.snapshot).toBeTruthy();
  });

  it('sweepExpired drops old entries', () => {
    const master = mkMaster();
    stable.deposit({}, master, mkPet(master));
    stable.deposit({}, master, mkPet(master));
    master._stable[0].stabledAt = Date.now() - 31 * 86_400_000;
    const lost = stable.sweepExpired(master);
    expect(lost.length).toBe(1);
    expect(stable.list(master).length).toBe(1);
  });
});
