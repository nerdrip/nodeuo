// Easter event — port of ServUO `Engines/Misc/EasterEggHunt.cs`. Hot
// during the week leading up to the calculated Easter Sunday each
// year. Players use `[hunt-egg` near a guarded-region NPC to receive
// a colored Easter egg (small chance of a rare golden egg with a
// bonus reward).

const EGG_HUES = [
  0x0048,  // pastel pink
  0x0046,  // pastel blue
  0x004A,  // mint green
  0x0049,  // butter yellow
  0x0044,  // light purple
  0x0481,  // white
];
// Easter egg art id — ServUO uses 0x9B40 (colored egg). The classic
// pre-AOS art id used 0x9B40 + variants. Fallback to 0x1773 (egg).
const EASTER_EGG_ID = 0x9B40;
const GOLDEN_EGG_HUE = 0x0026;   // bright gold

let _override = null;

/**
 * Compute Easter Sunday (Gregorian, anonymous Gauss algorithm) for a
 * given year. Returns Date at 00:00 UTC of Easter Sunday.
 */
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const L = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * L) / 451);
  const month = Math.floor((h + L - 7 * m + 114) / 31);     // 3 = March, 4 = April
  const day = ((h + L - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

/** True if today is within the 7-day window ending on Easter Sunday. */
export function isActive(now = new Date()) {
  if (_override === 'on') return true;
  if (_override === 'off') return false;
  const easter = easterSunday(now.getUTCFullYear());
  const windowStart = new Date(easter.getTime() - 7 * 24 * 60 * 60 * 1000);
  // Window: 7 days before Easter through end of Easter Sunday.
  const windowEnd = new Date(easter.getTime() + 24 * 60 * 60 * 1000);
  return now >= windowStart && now < windowEnd;
}
export function setOverride(mode) {
  if (mode === 'on' || mode === 'off' || mode === null) _override = mode;
}
export { easterSunday };

/** Roll one egg result: hue + golden flag. */
export function rollEgg() {
  const isGolden = Math.random() < 0.05;
  if (isGolden) return { itemId: EASTER_EGG_ID, hue: GOLDEN_EGG_HUE, name: 'golden Easter egg', golden: true };
  const hue = EGG_HUES[Math.floor(Math.random() * EGG_HUES.length)];
  return { itemId: EASTER_EGG_ID, hue, name: 'Easter egg', golden: false };
}

/**
 * Drop one Easter egg into `mob`'s pack. Returns the item or null if
 * the event isn't active. Idempotent — there is no per-player limit
 * here (the rate-limit lives on the [hunt-egg command path so a
 * scripted spammer can't macro 30 eggs/second).
 */
export function deliverEgg(api, mob, now = new Date()) {
  if (!isActive(now)) return null;
  if (!mob) return null;
  const def = rollEgg();
  try {
    const egg = api.items.createItem(api.world, {
      itemId: def.itemId, hue: def.hue, parent: mob.serial, name: def.name,
    });
    if (def.golden) {
      // Golden egg also drops a small gold pile to mirror the ServUO
      // "lucky find" Easter reward.
      try {
        api.items.createItem(api.world, {
          itemId: 0x0EED, hue: 0, amount: 250, parent: mob.serial, name: 'gold',
        });
        mob.client?.sendSystemMessage?.('A GOLDEN Easter egg! Lucky find — 250 gp bonus.');
      } catch { /* ignore */ }
    } else {
      mob.client?.sendSystemMessage?.('You find a colorful Easter egg.');
    }
    return egg;
  } catch {
    return null;
  }
}
