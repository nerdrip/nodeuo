import { allItems } from './_spatial.js';

// Canonical equipment snapshot for script-authored MobileIncoming packets.
// A 0x78 packet owns the complete layer list; sending [] merely to refresh a
// hue/visibility flag strips the subject in unmodified ClassicUO clients.

function paperdollBody(body) {
  const b = body | 0;
  return (b >= 0x0190 && b <= 0x0193)
    || b === 0x025d || b === 0x025e
    || b === 0x029a || b === 0x029b;
}

export function equipmentForMobile(apiOrWorld, mob, { paperdollOnly = false } = {}) {
  if (!apiOrWorld || !mob || (paperdollOnly && !paperdollBody(mob.body))) return [];
  const result = [];
  // Use the public script query boundary. Runtime implementations are backed
  // by the indexed inventory API; the compatibility helper also covers tests
  // and legacy worlds without exposing private maps to content modules.
  for (const item of allItems(apiOrWorld)) {
    if ((item.parent >>> 0) !== (mob.serial >>> 0) || !(item.layer | 0)) continue;
    result.push({
      serial: item.serial, itemId: item.itemId,
      layer: item.layer, hue: item.hue ?? 0,
    });
  }
  result.sort((a, b) => (a.layer | 0) - (b.layer | 0));
  return result;
}
