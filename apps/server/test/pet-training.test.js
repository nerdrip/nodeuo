// PHASE DF — pet training milestones (xp + level + stat scaling).

import { describe, it, expect } from 'vitest';
import {
  awardPetXp, petXpForKill, resetPetTraining, _PET_TRAINING_CONST,
} from '../src/systems/pets/pet-training.js';

describe('pet training (PHASE DF)', () => {
  it('awardPetXp does nothing for non-pet (no controlMaster)', () => {
    const wild = { hpMax: 100, str: 30 };
    expect(awardPetXp(wild, 500)).toBe(0);
    expect(wild.petXp).toBeUndefined();
  });

  it('awardPetXp accumulates and crosses level threshold', () => {
    const pet = { controlMaster: 0x1234, hpMax: 100, hp: 80, str: 30 };
    awardPetXp(pet, 500);
    expect(pet.petXp).toBe(500);
    expect(pet.petLevel).toBeFalsy(); // < 1000
    awardPetXp(pet, 600);
    expect(pet.petXp).toBe(1100);
    expect(pet.petLevel).toBe(1);
    // hp/str should have bumped: 100 × 1.10 = 110, 30 + 5 = 35.
    expect(pet.hpMax).toBe(110);
    expect(pet.hp).toBe(110);   // free heal on level-up
    expect(pet.str).toBe(35);
  });

  it('caps at MAX_LEVEL', () => {
    const pet = { controlMaster: 0x1234, hpMax: 100, str: 30 };
    awardPetXp(pet, 100_000);   // huge dump
    expect(pet.petLevel).toBe(_PET_TRAINING_CONST.MAX_LEVEL);
    // 100 × (1 + 0.10×5) = 150
    expect(pet.hpMax).toBe(150);
    expect(pet.str).toBe(30 + _PET_TRAINING_CONST.STR_BONUS_PER_LEVEL * 5);
    // Further xp ignored.
    awardPetXp(pet, 5000);
    expect(pet.petLevel).toBe(_PET_TRAINING_CONST.MAX_LEVEL);
  });

  it('does not double-bump stats on subsequent levels (uses snapshot baseline)', () => {
    const pet = { controlMaster: 0x1234, hpMax: 100, str: 30 };
    awardPetXp(pet, 1000);  // level 1: 110 hp / 35 str
    awardPetXp(pet, 1000);  // level 2: 120 hp / 40 str (NOT 110×1.10)
    expect(pet.hpMax).toBe(120);
    expect(pet.str).toBe(40);
  });

  it('petXpForKill scales by hp', () => {
    expect(petXpForKill({ hp: 30 })).toBe(0);   // tier-1 trash
    expect(petXpForKill({ hp: 100 })).toBe(5);
    expect(petXpForKill({ hp: 250 })).toBe(10);
    expect(petXpForKill({ hp: 600 })).toBe(30);
    expect(petXpForKill({ hp: 2000 })).toBe(100);
  });

  it('petXpForKill explicit override wins', () => {
    expect(petXpForKill({ hp: 30, petXp: 99 })).toBe(99);
  });

  it('resetPetTraining restores baseline stats', () => {
    const pet = { controlMaster: 0x1234, hpMax: 100, hp: 100, str: 30 };
    awardPetXp(pet, 3000);  // level 3
    expect(pet.hpMax).toBe(130);
    resetPetTraining(pet);
    expect(pet.hpMax).toBe(100);
    expect(pet.str).toBe(30);
    expect(pet.petXp).toBeUndefined();
    expect(pet.petLevel).toBeUndefined();
  });
});
