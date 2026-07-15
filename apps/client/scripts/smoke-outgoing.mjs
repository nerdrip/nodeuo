import assert from 'node:assert/strict';
import { readBookHeader } from '@uo/protocol';
import {
  buildBookHeader,
  buildBookHeaderOld,
  buildCreateCharacter,
  buildClickQuestArrow,
  buildDropReq,
  buildDropReqOld,
  buildLoginSeedOld,
  buildMapMessage,
  buildMegaClilocRequest,
  buildMegaClilocRequestOld,
  buildOpenSpellBook,
  buildPartyAccept,
  buildPartyCanLoot,
  buildPartyDecline,
  buildPartyMessage,
  buildPartyMessageTo,
  buildResyncRequest,
  buildUOLiveHashResponse,
  buildUseSkill,
} from '../src/net/outgoing.js';
import {
  SKILL_ACTION_IDS as CLIENT_SKILL_ACTION_IDS,
  skillClientIndexHasAction,
  skillIdFromName,
  skillNameFromClientIndex,
} from '../src/shared/skill-ids.js';
import { spellbookTypeFromKind } from '../src/shared/spellbook-types.js';
import { SKILL_ACTION_IDS as SERVER_SKILL_ACTION_IDS } from '../../server/src/net/skill-actions.js';

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

assert.equal(skillIdFromName('Hiding'), 22);
assert.equal(skillIdFromName('AnimalTaming'), 36);
assert.equal(skillIdFromName('Detecting Hidden'), 15);
assert.equal(skillIdFromName('MagicResist'), 27);
assert.equal(skillIdFromName('SpellWeaving'), 55);
assert.equal(skillIdFromName('47'), 47);
assert.equal(skillNameFromClientIndex(21), 'Hiding');
assert.equal(skillClientIndexHasAction(10), true);
assert.equal(skillClientIndexHasAction(21), true);
assert.equal(skillClientIndexHasAction(44), true);
assert.equal(skillClientIndexHasAction(45), true);
assert.equal(skillClientIndexHasAction(27), false);
assert.deepEqual(CLIENT_SKILL_ACTION_IDS, SERVER_SKILL_ACTION_IDS);
assert.equal(spellbookTypeFromKind('spellbook'), 0);
assert.equal(spellbookTypeFromKind('necromancy-spellbook'), 1);
assert.equal(spellbookTypeFromKind('bard-mastery-spellbook'), 7);

assert.equal(hex(buildUseSkill(22)), '1200082432322030');
assert.equal(hex(buildUseSkill(9)), '12000724392030');
assert.equal(hex(buildOpenSpellBook(0)), '1200054300');
assert.equal(hex(buildOpenSpellBook(6)), '1200054306');
assert.equal(hex(buildClickQuestArrow(false)), 'bf0006000700');
assert.equal(hex(buildClickQuestArrow(true)), 'bf0006000701');
assert.equal(hex(buildLoginSeedOld(0x0a000001)), '0a000001');
assert.equal(hex(buildResyncRequest()), '220000', 'client resync reserved bytes must stay canonical zeroes');
assert.equal(hex(buildDropReq(0x40000001, 0x1234, 0x5678, -1, 0x7f, 0xffffffff)), '084000000112345678ff7fffffffff');
assert.equal(hex(buildDropReqOld(0x40000001, 0x1234, 0x5678, -1, 0xffffffff)), '084000000112345678ffffffffff');
assert.equal(hex(buildMegaClilocRequest([0x40000001, 0x40000002])), 'd6000b4000000140000002');
assert.equal(hex(buildMegaClilocRequestOld(0x40000001)), 'bf0009001040000001');
assert.equal(hex(buildUOLiveHashResponse(0x00001234, 2, [0x1111, 0x2222])), '3f001300001234000000000000ff0211112222');
assert.equal(hex(buildMapMessage(0x40001234, 1, 2, 16, 32)), '5640001234010200100020');
{
  const pkt = buildCreateCharacter({
    name: 'Mira',
    sex: 1,
    race: 2,
    profession: 7,
    str: 60,
    dex: 15,
    int: 15,
    skills: [{ id: 8, value: 30 }, { id: 46, value: 30 }],
    city: 12,
    slot: 3,
    shirtHue: 1108,
    pantsHue: 1148,
  });
  assert.equal(pkt.length, 106);
  assert.equal(pkt[0], 0xF8);
  assert.equal(pkt[50], 0x00);
  assert.equal(pkt[53], 0x00);
  assert.equal(pkt[70], 7);
  assert.deepEqual([...pkt.slice(74, 82)], [7, 30, 45, 30, 0xff, 0, 0xff, 0]);
  assert.deepEqual([...pkt.slice(92, 98)], [0, 12, 0, 0, 0, 3]);
  assert.deepEqual([...pkt.slice(102, 106)], [0x04, 0x54, 0x04, 0x7c]);
}
assert.equal(hex(buildPartyMessage('hi')), 'bf000c000604006800690000');
assert.equal(hex(buildPartyMessageTo(0x01020304, 'hi')), 'bf001000060301020304006800690000');
assert.equal(hex(buildPartyCanLoot(true)), 'bf000700060601');
assert.equal(hex(buildPartyAccept(0x01020304)), 'bf000a00060801020304');
assert.equal(hex(buildPartyDecline(0x01020304)), 'bf000a00060901020304');
assert.equal(hex(buildBookHeader(0x01020304, 'A', 'B', 0)), 'd400110102030400000000000141000142');
assert.equal(buildBookHeaderOld(0x01020304, 'Title', 'Author').length, 99);
assert.deepEqual(readBookHeader(buildBookHeader(0x01020304, 'Caf\u00e9', 'Bj\u00f6rn', 2)), {
  serial: 0x01020304,
  writable: false,
  pages: 2,
  title: 'Caf\u00e9',
  author: 'Bj\u00f6rn',
});

console.log('client outgoing smoke ok');
