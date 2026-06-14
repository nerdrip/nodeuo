import { destroyItemBySerial } from '../../../_items.js';
import { isInPack } from '../../../_inventory.js';
import { createMobile } from '../../../_mobiles.js';

const DEFAULT_SUMMONS = Object.freeze({
  ShimmeringFerret: {
    kind: 'ShimmeringFerret',
    name: 'a shimmering ferret',
    body: 0x0117,
    hue: 0,
    skills: { 26: 1000, 27: 1000, 43: 1000, 1: 1000 },
    servuoClasses: ['ShimmeringFerret', 'Ferret', 'BaseCreature'],
  },
  TravestyDog: {
    kind: 'TravestyDog',
    name: 'a travesty dog',
    body: 0x00D9,
    hue: 0x08FD,
    skills: { 26: 1000, 27: 1000, 43: 1000, 1: 1000 },
    servuoClasses: ['TravestyDog', 'Dog', 'ClonedItem', 'BaseCreature'],
  },
});

function addClasses(item, classes) {
  item.servuoClasses = [...new Set([...(item.servuoClasses ?? []), ...classes.filter(Boolean)])];
}

function normalizeSummon(item) {
  const src = item.imprisonedSummon ?? {};
  const key = src.kind ?? item.summonKind ?? item.servuoSummonClass ?? 'ShimmeringFerret';
  const base = DEFAULT_SUMMONS[key] ?? DEFAULT_SUMMONS[String(key).replace(/[-_\s]/g, '')] ?? {};
  return {
    ...base,
    ...src,
    kind: src.kind ?? base.kind ?? key,
    servuoClasses: [...new Set([...(base.servuoClasses ?? []), ...(src.servuoClasses ?? [])])],
  };
}

function followerSlots(user, summon) {
  return summon.controlSlots ?? summon._followerCost ?? 1;
}

function canControl(user, summon) {
  return ((user?.followers ?? 0) + followerSlots(user, summon)) <= (user?.followersMax ?? 5);
}

function stampPet(user, mob, summon) {
  mob.controlMaster = user.serial >>> 0;
  mob.controlTarget = user.serial >>> 0;
  mob.controlOrder = 'follow';
  mob.bonded = true;
  mob.isBonded = true;
  mob.deleteOnRelease = true;
  mob._summonedFromCrystal = true;
  mob.servuoClass = summon.kind;
  mob.servuoClasses = summon.servuoClasses;
  mob.skills = { ...(mob.skills ?? {}), ...(summon.skills ?? {}) };
}

export default function buildImprisonedMobile(api) {
  return {
    name: 'imprisoned-mobile',
    onCreate(_world, item) {
      const summon = normalizeSummon(item);
      item.weight ??= 1;
      item.forceShowProperties = true;
      item.summonKind = summon.kind;
      item.servuoClass ??= item.imprisonedServuoClass ?? 'BaseImprisonedMobile';
      addClasses(item, [
        item.servuoClass,
        'BaseImprisonedMobile',
        'ConfirmBreakCrystalGump',
        summon.kind,
        ...(summon.servuoClasses ?? []),
      ]);
    },
    onUse(world, item, user) {
      if (!user?.client) return true;
      if (!isInPack({ ...api, world }, item, user)) {
        user.client.sendSystemMessage?.('That must be in your pack for you to use it.');
        return true;
      }
      const summon = normalizeSummon(item);
      if (!canControl(user, summon)) {
        user.client.sendSystemMessage?.('You have too many followers to control that creature.');
        return true;
      }
      const mob = createMobile({ ...api, world }, {
        ...summon,
        x: user.x,
        y: user.y,
        z: user.z,
        map: user.map ?? 1,
        notoriety: 1,
        controlSlots: followerSlots(user, summon),
      });
      if (!mob) {
        user.client.sendSystemMessage?.('The creature cannot be released right now.');
        return true;
      }
      stampPet(user, mob, summon);
      user.followers = (user.followers ?? 0) + followerSlots(user, summon);
      api.ai?.attach?.(mob, 'pet', { command: 'follow', targetSerial: user.serial });
      destroyItemBySerial({ ...api, world }, item.serial);
      user.client.sendSystemMessage?.('It seems to accept you as master.');
      user.client.sendSystemMessage?.('Your pet has bonded with you!');
      return true;
    },
  };
}
