// Store-bought gender/race change tokens.  ServUO spreads this flow across
// token, confirmation-gump and client appearance packet classes; NodeUO keeps
// the authoritative consume/confirm operation in two native item scripts.

import { destroyItemBySerial } from '../../../_items.js';
import { isInPack } from '../../../_inventory.js';
import { openRaceChangeGump } from '../../../gumps/server-gumps.js';

const BODY_BY_RACE = {
  human: { male: 0x190, female: 0x191 },
  elf: { male: 0x25D, female: 0x25E },
  gargoyle: { male: 0x29A, female: 0x29B },
};

function originalForm(user) {
  return !user.isBodyMod && !(user.hueMod > 0) && !user.incognito;
}

function tokenInPack(api, item, user) {
  if (isInPack(api, item, user)) return true;
  user?.client?.sendSystemMessage?.('This token must be in your backpack to be used.');
  return false;
}

export function buildGenderChangeToken(api) {
  return {
    name: 'gender-change-token',
    servuoClasses: ['GenderChangeToken', 'GenderChangeConfirmGump', 'ChangeHairstyleGump'],
    onUse(_world, item, user) {
      const state = user?.client;
      if (!state || !tokenInPack(api, item, user)) return true;
      if (!originalForm(user)) {
        state.sendSystemMessage?.('You may only change gender while in your original form.');
        return true;
      }
      const targetFemale = !(user.female ?? user.sex === 1);
      const apply = () => {
        if (!tokenInPack(api, item, user) || !originalForm(user)) return;
        user.female = targetFemale;
        user.sex = targetFemale ? 1 : 0;
        const race = String(user.race ?? 'human').toLowerCase();
        user.body = BODY_BY_RACE[race]?.[targetFemale ? 'female' : 'male']
          ?? BODY_BY_RACE.human[targetFemale ? 'female' : 'male'];
        if (targetFemale || race === 'elf') user._beardItemId = 0;
        destroyItemBySerial(api, item.serial);
        state.sendSystemMessage?.(`You are now ${targetFemale ? 'a woman' : 'a man'}.`);
      };
      if (!api.gumps?.send) {
        state.sendSystemMessage?.('Confirmation interface unavailable; the token was not consumed.');
        return true;
      }
      api.gumps.send(state, {
        definitionId: 'servuo:gender-change-confirm',
        layout: '{ resizepic 0 0 9200 291 159 } { text 12 12 1153 0 } { text 12 42 1149 1 } { button 12 125 4017 4018 1 0 0 } { button 145 125 4005 4007 1 0 1 }',
        texts: ['Change your character\'s gender', `Permanently become ${targetFemale ? 'female' : 'male'}?`, 'Cancel', 'Confirm'],
      }, (response) => { if (response.buttonId === 1) apply(); });
      return true;
    },
  };
}

export function buildRaceChangeToken(api) {
  return {
    name: 'race-change-token',
    servuoClasses: ['RaceChangeToken', 'RaceChangeConfirmGump', 'HeritagePacket'],
    onUse(_world, item, user) {
      const state = user?.client;
      if (!state || !tokenInPack(api, item, user)) return true;
      if (!api.gumps?.send) {
        state.sendSystemMessage?.('Race selection interface unavailable; the token was not consumed.');
        return true;
      }
      openRaceChangeGump(api.gumps, state, (mob, race) => {
        if (!tokenInPack(api, item, mob) || !originalForm(mob)) return;
        const normalized = String(race).toLowerCase();
        if (!BODY_BY_RACE[normalized] || normalized === String(mob.race ?? 'human').toLowerCase()) return;
        mob.race = normalized;
        mob.body = BODY_BY_RACE[normalized][(mob.female ?? mob.sex === 1) ? 'female' : 'male'];
        if ((mob.female ?? mob.sex === 1) || normalized === 'elf') mob._beardItemId = 0;
        destroyItemBySerial(api, item.serial);
        state.sendSystemMessage?.(`You are now ${normalized}.`);
      });
      return true;
    },
  };
}
