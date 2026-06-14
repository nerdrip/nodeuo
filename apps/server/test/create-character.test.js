// FAZA BR + BUGFIX #34 — `parseCreateCharacter` extracts the user's
// CreateCharacter selections (sex, hue, hair, profession, skills) from
// the 0x00 / 0xF8 packet. Previously `bringIntoWorld()` silently dropped
// every selection except the name, so a player who picked female + red
// hair always spawned as a default male newbie.

import { describe, it, expect } from 'vitest';
import { _parseCreateCharacterForTest } from '../src/net/handlers.js';
import { PacketWriter } from '@uo/protocol';

/** Build a synthetic CreateCharacter packet. Skill ids passed here use the
 * runtime's canonical 1..58 ids and are encoded as UO's zero-based wire ids. */
function buildCreateChar({
  extended = false,
  name = 'TestHero',
  sex = 0,
  profession = 1,
  str = 60, dex = 30, intel = 10,
  skills = [[41, 50], [28, 30], [18, 20]],
  skinHue = 1004,
  hairId = 0x203B, hairHue = 1109,
  beardId = 0x203F, beardHue = 0x0021,
} = {}) {
  const w = new PacketWriter(extended ? 106 : 104);
  w.writeU8(extended ? 0xF8 : 0x00);
  w.writeU32(0xEDEDEDED);   // patternRevision
  w.writeU32(0);            // clientFlag
  w.writeU8(0);             // unk
  w.writeAsciiFixed(name, 30);
  w.writeU16(0);            // unk
  w.writeU32(0);            // featureFlags
  w.writeU32(0);            // unk
  w.writeU32(1);            // loginCount
  w.writeU8(profession);
  for (let i = 0; i < 15; i++) w.writeU8(0); // pad
  w.writeU8(sex);
  w.writeU8(str);
  w.writeU8(dex);
  w.writeU8(intel);
  for (const [skillId, val] of skills.slice(0, extended ? 4 : 3)) {
    const wireId = skillId >= 1 && skillId <= 58 ? skillId - 1 : skillId;
    w.writeU8(wireId); w.writeU8(val);
  }
  w.writeU16(skinHue);
  w.writeU16(hairId);
  w.writeU16(hairHue);
  w.writeU16(beardId);
  w.writeU16(beardHue);
  // Trailing: city/charSlot/startCity/startMap/etc — pad with zeroes.
  while (w.length < 104) w.writeU8(0);
  return w.bytes();
}

describe('parseCreateCharacter (FAZA BR / bugfix #34)', () => {
  it('round-trips name, sex=female, profession=mage', () => {
    const pkt = buildCreateChar({
      name: 'Mira', sex: 1, profession: 2,
    });
    const c = _parseCreateCharacterForTest(pkt, false);
    expect(c.name).toBe('Mira');
    expect(c.sex).toBe(1);
    expect(c.profession).toBe(2);
  });

  it('decodes zero-based wire skill ids into canonical runtime ids', () => {
    const pkt = buildCreateChar({
      skills: [[41, 50], [28, 30], [18, 20]],
    });
    const c = _parseCreateCharacterForTest(pkt, false);
    expect(c.skills).toEqual({ 41: 50, 28: 30, 18: 20 });
  });

  it('captures the fourth modern 0xF8 skill slot', () => {
    const pkt = buildCreateChar({
      extended: true,
      skills: [[2, 30], [18, 30], [41, 30], [28, 30]],
    });
    const c = _parseCreateCharacterForTest(pkt, true);
    expect(c.skills).toEqual({ 2: 30, 18: 30, 41: 30, 28: 30 });
  });

  it('decodes race from the ClassicUO gender/race byte', () => {
    const pkt = buildCreateChar({ extended: true, sex: 7 });
    const c = _parseCreateCharacterForTest(pkt, true);
    expect(c.sex).toBe(1);
    expect(c.race).toBe(2);
  });

  it('decodes the modern 0xF8 elf race byte using ServUO semantics', () => {
    const pkt = buildCreateChar({ extended: true, sex: 5 });
    const c = _parseCreateCharacterForTest(pkt, true);
    expect(c.sex).toBe(1);
    expect(c.race).toBe(1);
  });

  it('keeps legacy 0x00 elf race bytes compatible', () => {
    const pkt = buildCreateChar({ extended: false, sex: 3 });
    const c = _parseCreateCharacterForTest(pkt, false);
    expect(c.sex).toBe(1);
    expect(c.race).toBe(1);
  });

  it('captures stat allocation', () => {
    const pkt = buildCreateChar({ str: 80, dex: 20, intel: 25 });
    const c = _parseCreateCharacterForTest(pkt, false);
    expect(c.str).toBe(80);
    expect(c.dex).toBe(20);
    expect(c.int).toBe(25);
  });

  it('captures hair, beard and skin hue', () => {
    const pkt = buildCreateChar({
      skinHue: 1023,
      hairId: 0x203C, hairHue: 0x0466,
      beardId: 0x2041, beardHue: 0x0466,
    });
    const c = _parseCreateCharacterForTest(pkt, false);
    expect(c.skinHue).toBe(1023);
    expect(c.hair).toEqual({ itemId: 0x203C, hue: 0x0466 });
    expect(c.beard).toEqual({ itemId: 0x2041, hue: 0x0466 });
  });

  it('hair/beard are null when itemId is 0 (player chose "none")', () => {
    const pkt = buildCreateChar({ hairId: 0, beardId: 0 });
    const c = _parseCreateCharacterForTest(pkt, false);
    expect(c.hair).toBeNull();
    expect(c.beard).toBeNull();
  });

  it('skips skill entries with val=0 (empty slots)', () => {
    const pkt = buildCreateChar({
      skills: [[41, 50], [1, 0], [28, 30]],
    });
    const c = _parseCreateCharacterForTest(pkt, false);
    expect(c.skills).toEqual({ 41: 50, 28: 30 });
  });

  it('rejects out-of-range skill ids instead of creating skill 0 or 99', () => {
    const pkt = buildCreateChar({
      skills: [[255, 50], [26, 30], [99, 20]],
    });
    const c = _parseCreateCharacterForTest(pkt, false);
    expect(c.skills).toEqual({ 26: 30 });
  });
});
