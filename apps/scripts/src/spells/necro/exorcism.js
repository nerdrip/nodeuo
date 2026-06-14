// Exorcism — banishes hostile undead and ghosts within ~6 tiles to the
// nearest shrine. ServUO's spell is champion-spawn scoped and targets
// dead hostile players; our shard keeps the useful local banish behavior,
// but it must never move living vendors/pets just because they are nearby.
import { aura, broadcastEffect, broadcastSound, mobilesNear } from '../_helpers.js';
import { moveMobile } from '../../_movement.js';
const RADIUS = 6;

// ServUO shrine tables from `Necromancy/Exorcism.cs::GetNearestShrine`.
// Map ids in this project: 0 Felucca, 1 Trammel, 2 Ilshenar, 3 Malas,
// 4 Tokuno. Unknown facets fall back to Trammel, same as ServUO's null
// map fallback.
const SHRINES_BRITANNIA = Object.freeze([
  { x: 1470, y: 843, z: 0 },
  { x: 1857, y: 865, z: -1 },
  { x: 4220, y: 563, z: 36 },
  { x: 1732, y: 3528, z: 0 },
  { x: 1300, y: 644, z: 8 },
  { x: 3355, y: 302, z: 9 },
  { x: 1606, y: 2490, z: 5 },
  { x: 2500, y: 3931, z: 3 },
  { x: 4264, y: 3707, z: 0 },
]);

const SHRINES_BY_MAP = Object.freeze({
  0: SHRINES_BRITANNIA,
  1: SHRINES_BRITANNIA,
  2: Object.freeze([
    { x: 1222, y: 474, z: -17 },
    { x: 718, y: 1360, z: -60 },
    { x: 297, y: 1014, z: -19 },
    { x: 986, y: 1006, z: -36 },
    { x: 1180, y: 1288, z: -30 },
    { x: 1538, y: 1341, z: -3 },
    { x: 528, y: 223, z: -38 },
  ]),
  3: Object.freeze([
    { x: 976, y: 517, z: -30 },
  ]),
  4: Object.freeze([
    { x: 710, y: 1162, z: 25 },
    { x: 1034, y: 515, z: 18 },
    { x: 295, y: 712, z: 55 },
  ]),
});

const UNDEAD_WORDS = /\b(undead|skeleton|skelet(?:al|on)?|zombie|lich|wraith|spectre|specter|shade|ghost|mummy|bone|bogle|ghoul|revenant|vampire|rotworm|rotting|animated dead|bone knight|bone mage)\b/i;

function nearestShrine(mob) {
  const map = (mob?.map ?? 1) | 0;
  const locs = SHRINES_BY_MAP[map] ?? SHRINES_BRITANNIA;
  let best = locs[0];
  let bestD = Infinity;
  for (const s of locs) {
    const d = Math.abs(s.x - mob.x) + Math.abs(s.y - mob.y);
    if (d < bestD) { bestD = d; best = s; }
  }
  return { ...best, map: SHRINES_BY_MAP[map] ? map : 1 };
}

function targetText(mob) {
  const classes = [mob?.servuoClass, ...(mob?.servuoClasses ?? [])].filter(Boolean);
  return [
    mob?.kind, mob?.npcKind, mob?.template, mob?.name,
    mob?.title, mob?.baseKind, mob?.baseType,
    ...classes,
  ].filter(Boolean).join(' ');
}

function isExorcismTarget(mob) {
  if (!mob) return false;
  if (mob.ghost || mob.dead || (mob.hp ?? 1) <= 0) return true;
  if (mob.client) return false;
  if (mob.undead === true || mob.isUndead === true) return true;
  return UNDEAD_WORDS.test(targetText(mob));
}

export default {
  name: 'exorcism', school: 'necromancy', circle: 6, mana: 40,
  cast(api, ctx) {
    const caster = ctx.sender;
    let banished = 0;
    for (const m of mobilesNear(api, caster, RADIUS, caster)) {
      if (!isExorcismTarget(m)) continue;
      const shrine = nearestShrine(m);
      moveMobile(api, m, shrine);
      banished++;
    }
    broadcastEffect(api, api.world, caster, aura(api, caster, { itemId: 0x3728, hue: 0x4F2 }));
    broadcastSound(api, api.world, caster, 0x0216);
    ctx.state.sendSystemMessage(`Banished ${banished} undead to the nearest shrine.`);
  },
};
