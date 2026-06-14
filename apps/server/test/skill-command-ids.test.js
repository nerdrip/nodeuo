import { afterEach, describe, expect, it, vi } from 'vitest';

import registerForensic from '../../scripts/src/skills/forensic.js';
import registerHerd from '../../scripts/src/skills/herd.js';
import registerPoison from '../../scripts/src/skills/poison.js';
import registerSnoop from '../../scripts/src/skills/snoop.js';
import registerSpiritSpeak from '../../scripts/src/skills/spiritspeak.js';
import registerTasteId from '../../scripts/src/skills/tasteid.js';
import registerVet from '../../scripts/src/skills/vet.js';
import registerPowerup from '../../scripts/src/commands/admin/powerup.js';
import registerBard from '../../scripts/src/commands/economy/bard.js';
import registerSkills from '../../scripts/src/commands/economy/skills.js';
import registerSoulstone from '../../scripts/src/commands/crafting/soulstone.js';
import { effectiveSkill } from '../src/combat-formulas.js';

function commandMap() {
  const map = new Map();
  return {
    map,
    api: {
      register(cmd) { map.set(cmd.name, cmd); },
      unregister(name) { map.delete(name); },
    },
  };
}

function state(messages = []) {
  return {
    send: vi.fn(),
    sendSystemMessage(msg) { messages.push(String(msg)); },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('skill command canonical ids', () => {
  it('normalizes legacy x10 skill values through effectiveSkill', () => {
    expect(effectiveSkill({ skills: { 31: 100 } }, 31)).toBe(100);
    expect(effectiveSkill({ skills: { 31: 1000 } }, 31)).toBe(100);
  });

  it('Forensic Evaluation reads and gains canonical skill 20', () => {
    const commands = commandMap();
    const targets = [];
    const messages = [];
    const world = {
      mobiles: new Map(),
      items: new Map([[0xCAFE, { serial: 0xCAFE, itemId: 0x2006, killerName: 'a lich' }]]),
    };
    const api = {
      commands: commands.api,
      targeting: { request: (_state, cb) => targets.push(cb) },
      world,
      skillGain: { tryGain: vi.fn() },
    };
    registerForensic(api);

    const sender = { serial: 1, skills: { 20: 55, 17: 0 } };
    commands.map.get('forensic').run({ sender, state: state(messages), world });
    targets[0]({ serial: 0xCAFE });

    expect(messages.some((m) => m.includes('fell to a lich'))).toBe(true);
    expect(api.skillGain.tryGain).toHaveBeenCalledWith(sender, 20, 50);
  });

  it('Herding reads and gains canonical skill 21', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const commands = commandMap();
    const targets = [];
    const animal = { serial: 2, notoriety: 1 };
    const world = { mobiles: new Map([[2, animal]]), items: new Map() };
    const api = {
      commands: commands.api,
      targeting: { request: (_state, cb) => targets.push(cb) },
      world,
      skillGain: { tryGain: vi.fn() },
    };
    registerHerd(api);

    const sender = { serial: 1, skills: { 21: 100, 13: 0 } };
    commands.map.get('herd').run({ sender, state: state(), world });
    targets[0]({ serial: 2 });
    targets[1]({ x: 10, y: 20 });

    expect(animal.goal).toMatchObject({ x: 10, y: 20 });
    expect(api.skillGain.tryGain).toHaveBeenCalledWith(sender, 21, 1.0);
  });

  it('Taste Identification reads and gains canonical skill 37', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const commands = commandMap();
    const targets = [];
    const item = { serial: 3, poison: 2 };
    const world = { mobiles: new Map(), items: new Map([[3, item]]) };
    const api = {
      commands: commands.api,
      targeting: { request: (_state, cb) => targets.push(cb) },
      world,
      skillGain: { tryGain: vi.fn() },
    };
    registerTasteId(api);

    const sender = { serial: 1, skills: { 37: 100, 31: 0 } };
    commands.map.get('tasteid').run({ sender, state: state(), world });
    targets[0]({ serial: 3 });

    expect(api.skillGain.tryGain).toHaveBeenCalledWith(sender, 37, 1.0);
  });

  it('Snooping reads and gains canonical skill 29', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const commands = commandMap();
    const targets = [];
    const pack = { serial: 9 };
    const target = { serial: 4, client: {}, equipment: new Map([[21, pack]]), skills: { 15: 0 } };
    const world = { mobiles: new Map([[4, target]]), items: new Map() };
    const api = {
      commands: commands.api,
      targeting: { request: (_state, cb) => targets.push(cb) },
      world,
      skillGain: { tryGain: vi.fn() },
    };
    registerSnoop(api);

    const sender = { serial: 1, skills: { 29: 100, 28: 0 } };
    commands.map.get('snoop').run({ sender, state: state(), world });
    targets[0]({ serial: 4 });

    expect(api.skillGain.tryGain).toHaveBeenCalledWith(sender, 29, 1.0);
  });

  it('Spirit Speak reads and gains canonical skill 33', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const commands = commandMap();
    const sender = {
      serial: 1, x: 0, y: 0, map: 1,
      skills: { 33: 100, 32: 0 },
      mana: 50, hp: 10, hpMax: 50,
    };
    const api = {
      commands: commands.api,
      statusEffects: { apply: vi.fn() },
      world: { items: new Map(), mobiles: new Map([[1, sender]]) },
      skillGain: { tryGain: vi.fn() },
    };
    registerSpiritSpeak(api);

    commands.map.get('spiritspeak').run({ sender, state: state(), world: api.world });

    expect(api.statusEffects.apply).toHaveBeenCalledWith(sender, expect.objectContaining({ name: 'spiritspeak' }));
    expect(api.skillGain.tryGain).toHaveBeenCalledWith(sender, 33, 60);
  });

  it('Veterinary reads canonical skills 40 and 3', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const commands = commandMap();
    const targets = [];
    const pack = { serial: 9 };
    const bandage = { serial: 10, parent: 9, itemId: 0x0E21, amount: 2 };
    const pet = { serial: 5, body: 0x00D0, hp: 10, hpMax: 50, name: 'pet' };
    const world = {
      mobiles: new Map([[5, pet]]),
      items: new Map([[10, bandage]]),
    };
    const api = {
      commands: commands.api,
      targeting: { request: (_state, cb) => targets.push(cb) },
      world,
      skillGain: { tryGain: vi.fn() },
    };
    registerVet(api);

    const sender = { serial: 1, equipment: new Map([[21, pack]]), skills: { 40: 100, 3: 100, 36: 0, 4: 0 } };
    commands.map.get('vet').run({ sender, state: state(), world });
    targets[0]({ serial: 5 });

    expect(pet.hp).toBeGreaterThan(10);
    expect(api.skillGain.tryGain).toHaveBeenCalledWith(sender, 40, 1.0);
  });

  it('Poisoning reads canonical skill 31', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const commands = commandMap();
    const targets = [];
    const potion = { serial: 6, parent: 1, itemId: 0x0F0C };
    const weapon = { serial: 7, parent: 1, weapon: true };
    const world = {
      mobiles: new Map(),
      items: new Map([[6, potion], [7, weapon]]),
    };
    const api = {
      commands: commands.api,
      targeting: { request: (_state, cb) => targets.push(cb) },
      world,
      items: { consumeUpTo: vi.fn(() => 1), destroyItem: vi.fn() },
    };
    registerPoison(api);

    const sender = { serial: 1, skills: { 31: 100, 30: 0 } };
    commands.map.get('poison').run({ sender, state: state(), world });
    targets[0]({ serial: 7 });

    expect(weapon.poison).toMatchObject({ level: 2 });
  });

  it('Musicianship registers playinstrument and gains canonical skill 30', () => {
    const commands = commandMap();
    const instrument = { serial: 8, parent: 1, kind: 'instrument', usesRemaining: 2 };
    const sender = { serial: 1, skills: { 30: 100 } };
    const api = {
      commands: commands.api,
      systems: { bardSkills: { musicCheck: vi.fn(() => true) } },
      world: { items: new Map([[8, instrument]]) },
      skillGain: { tryGain: vi.fn() },
      items: { destroyItem: vi.fn(), invalidateProps: vi.fn() },
    };
    registerBard(api);

    commands.map.get('playinstrument').run({ sender, state: state(), world: api.world });

    expect(api.systems.bardSkills.musicCheck).toHaveBeenCalledWith(sender, instrument);
    expect(api.skillGain.tryGain).toHaveBeenCalledWith(sender, 30, 50);
    expect(instrument.usesRemaining).toBe(1);
  });

  it('powerup fills canonical skill ids 1..58 on the runtime scale', () => {
    const commands = commandMap();
    const api = {
      commands: commands.api,
      world: {},
      protocol: {
        sendSkills: vi.fn(() => new Uint8Array([0x3A])),
        mobileStatus: vi.fn(() => new Uint8Array([0x11])),
        healthUpdate: vi.fn(() => new Uint8Array([0xA1])),
        staminaUpdate: vi.fn(() => new Uint8Array([0xA3])),
        manaUpdate: vi.fn(() => new Uint8Array([0xA2])),
      },
    };
    registerPowerup(api);

    const sender = { serial: 1, skills: {}, body: 0x190 };
    const st = state();
    commands.map.get('powerup').run({ sender, state: st, world: api.world });

    expect(sender.skills[0]).toBeUndefined();
    expect(sender.skills[1]).toBe(100);
    expect(sender.skills[58]).toBe(100);
    const sentSkills = api.protocol.sendSkills.mock.calls[0][0].skills;
    expect(sentSkills).toHaveLength(58);
    expect(sentSkills[0]).toMatchObject({ id: 1, value: 100, base: 100 });
    expect(sentSkills[57]).toMatchObject({ id: 58, value: 100, base: 100 });
  });

  it('setskill accepts only canonical ids 1..58 and displays normalized legacy values', () => {
    const commands = commandMap();
    const api = {
      commands: commands.api,
      protocol: { sendSkills: vi.fn(() => new Uint8Array([0x3A])) },
    };
    registerSkills(api);

    const messages = [];
    const st = state(messages);
    const sender = { serial: 1, skills: { 26: 1000 } };

    commands.map.get('setskill').run({ sender, state: st }, ['0', '100']);
    commands.map.get('setskill').run({ sender, state: st }, ['59', '100']);
    commands.map.get('setskill').run({ sender, state: st }, ['58', '75']);
    commands.map.get('skills').run({ sender, state: st });

    expect(sender.skills[0]).toBeUndefined();
    expect(sender.skills[58]).toBe(75);
    expect(api.protocol.sendSkills).toHaveBeenCalledWith({
      skills: [{ id: 58, value: 75, base: 75, cap: 100 }],
      type: 0xFF,
    });
    expect(messages.filter((m) => m === 'Invalid skill id (1..58).')).toHaveLength(2);
    expect(messages).toContain('  Magery: 100.0');
    expect(messages).toContain('  Throwing: 75.0');
  });

  it('soulstones store and restore canonical skill ids on the normalized runtime scale', () => {
    const commands = commandMap();
    const targets = [];
    const stone = { serial: 0x40000000, itemId: 0x2A94 };
    const api = {
      commands: commands.api,
      targeting: { request: (_state, cb) => targets.push(cb) },
      world: { items: new Map([[stone.serial, stone]]) },
    };
    registerSoulstone(api);

    const messages = [];
    const st = state(messages);
    const sender = { serial: 1, skills: { 26: 1000 } };

    commands.map.get('ss-save').run({ sender, state: st, args: ['26'] });
    targets.shift()({ serial: stone.serial });

    expect(stone.soulstone).toEqual({ skillId: 26, value: 100 });
    expect(sender.skills[26]).toBe(0);
    expect(messages).toContain('Stored 100 in skill 26.');

    commands.map.get('ss-load').run({ sender, state: st, args: [] });
    targets.shift()({ serial: stone.serial });

    expect(stone.soulstone).toBeUndefined();
    expect(sender.skills[26]).toBe(100);
    expect(messages).toContain('Restored 100 in skill 26.');
  });
});
