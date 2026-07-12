import { describe, expect, it } from 'vitest';
import { abilitiesForMount, useMountAbility } from '../src/systems/pets/mount-abilities.js';
import { trainPet, trainingPointsAvailable, resetPetTraining } from '../src/systems/pets/pet-training.js';

describe('mount abilities and visual pet training backend', () => {
  it('unlocks mount abilities by pet level and enforces authoritative cooldown/stamina', () => {
    const pet = { serial: 2, name: 'horse', controlMaster: 1, petLevel: 3, stam: 50, stamMax: 100 };
    const rider = { serial: 1, mountedFrom: 2, stam: 50, stamMax: 100 };
    const world = { mobiles: new Map([[2, pet]]) };
    expect(abilitiesForMount(pet, 1000).map((entry) => entry.id)).toEqual(['sprint', 'second-wind', 'sure-footed', 'battle-charge']);
    expect(useMountAbility(world, rider, 'sprint', 1000).ok).toBe(true);
    expect(rider.stam).toBe(40);
    expect(rider._mountSprintUntil).toBe(5000);
    expect(useMountAbility(world, rider, 'sprint', 2000).ok).toBe(false);
  });

  it('spends training points once and reset restores the pre-training pet', () => {
    const pet = { serial: 3, controlMaster: 1, petLevel: 3, hp: 100, hpMax: 100, armor: 5, skills: {}, resists: {} };
    expect(trainingPointsAvailable(pet)).toBe(3);
    expect(trainPet(pet, 'extra-hp').ok).toBe(true);
    expect(pet.hpMax).toBe(300);
    expect(trainPet(pet, 'extra-hp').ok).toBe(false);
    expect(trainPet(pet, 'magic-resist').ok).toBe(true);
    expect(trainingPointsAvailable(pet)).toBe(0);
    resetPetTraining(pet);
    expect(pet.hpMax).toBe(100);
    expect(pet.armor).toBe(5);
    expect(pet.petTrainingAbilities).toBeUndefined();
  });
});
