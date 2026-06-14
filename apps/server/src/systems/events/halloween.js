// Halloween event — port of ServUO `Engines/Halloween/HalloweenSeason.cs`.
//
// During October every NPC offering speech keywords accepts "trick or
// treat" — vendors / townspeople respond with either a small gift
// (candy, jack-o-lantern, mask) or a prank (sound + small fright
// effect, no real damage). The trigger windows + reward pool match
// the canonical ServUO event so a returning player feels at home.
//
// Activation:
//   • Auto-on for the entire month of October (server clock UTC).
//   • Admin can force on/off via `[halloween on|off|status`.
//
// Hooks the speech handler indirectly: `isActive()` is checked from
// commands/trick-or-treat.js (a slash-trigger players can also use
// outside speech) and from npc speech keyword router (registered in
// scripts/src/npcs/townspeople.js at load time).

const TREAT_ITEM_POOL = [
  // Halloween-themed loot pool (gif → item id, hue).
  { itemId: 0x1EB1, hue: 0x021,  name: 'orange candy' },
  { itemId: 0x1EB1, hue: 0x047,  name: 'jelly bean (red)' },
  { itemId: 0x1EB1, hue: 0x046,  name: 'jelly bean (blue)' },
  { itemId: 0x1EB1, hue: 0x044E, name: 'jelly bean (white)' },
  { itemId: 0x0F8A, hue: 0,      name: 'apple' },
  { itemId: 0x0F8C, hue: 0,      name: 'pumpkin' },
  { itemId: 0x1EB3, hue: 0x021,  name: 'a piece of dark chocolate' },
  { itemId: 0x1EB4, hue: 0x046,  name: 'a piece of milk chocolate' },
  { itemId: 0x097D, hue: 0,      name: 'caramel apple' },
  { itemId: 0x097E, hue: 0,      name: 'a turnip cookie' },
  // Rare loot (~5% pool): jack-o-lanterns + collectible masks.
  { itemId: 0x0C6A, hue: 0x021,  name: 'jack-o-lantern', rare: true },
  { itemId: 0x1545, hue: 0x000,  name: 'evil clown mask', rare: true },
  { itemId: 0x1547, hue: 0x6B6,  name: 'tribal mask', rare: true },
  { itemId: 0x1549, hue: 0x000,  name: 'orc mask', rare: true },
  { itemId: 0x154B, hue: 0x000,  name: 'ogre mask', rare: true },
  { itemId: 0x4B0E, hue: 0x021,  name: 'pumpkin head mask', rare: true },
  { itemId: 0x46B5, hue: 0x47E,  name: 'spectre mask', rare: true },
  // Tournament-tier rare (0.5%): named candy bowl artifact.
  { itemId: 0x4BFA, hue: 0x21,   name: 'eerie candy bowl', rare: true, ultra: true },
];

const PRANK_SOUNDS = [
  0x055,  // ghostly howl
  0x375,  // banshee scream
  0x174,  // skeletal rattle
];

let _override = null; // 'on' | 'off' | null

/** True if the Halloween event window is currently active. */
export function isActive(now = new Date()) {
  if (_override === 'on') return true;
  if (_override === 'off') return false;
  // October — month index 9 (0-based). UTC to keep timezone-free.
  return now.getUTCMonth() === 9;
}

/** Admin override. Pass null to clear. */
export function setOverride(mode) {
  if (mode === 'on' || mode === 'off' || mode === null) _override = mode;
}

/**
 * Roll a single trick-or-treat outcome for `mob` from `npc`. Returns:
 *   { kind: 'treat', item }  — caller spawns the item in mob's pack
 *   { kind: 'prank', sound } — caller plays the sound near mob
 *
 * 75 % treat, 25 % prank; among treats 5 % rare (jack-o-lantern).
 */
export function roll(now = Date.now()) {
  const r = Math.random();
  if (r < 0.25) {
    return { kind: 'prank', sound: PRANK_SOUNDS[Math.floor(Math.random() * PRANK_SOUNDS.length)] };
  }
  // Tiered rare roll:
  //   • 0.5% ultra-rare (eerie candy bowl)
  //   • 4.5% rare (masks + jack-o-lantern)
  //   • 95%  common (candy / pumpkin / chocolate)
  const rareRoll = Math.random();
  let pool;
  if (rareRoll < 0.005) {
    pool = TREAT_ITEM_POOL.filter((p) => p.ultra);
  } else if (rareRoll < 0.05) {
    pool = TREAT_ITEM_POOL.filter((p) => p.rare && !p.ultra);
  } else {
    pool = TREAT_ITEM_POOL.filter((p) => !p.rare);
  }
  const pick = pool[Math.floor(Math.random() * pool.length)] ?? TREAT_ITEM_POOL[0];
  return { kind: 'treat', item: { ...pick }, ts: now };
}

/**
 * Apply a roll to a target mob via the script API. Spawns a candy /
 * jack-o-lantern in their pack OR plays a prank sound nearby.
 */
export function apply(api, npc, player, world) {
  const pack = player.serial;
  const r = roll();
  if (r.kind === 'treat') {
    try {
      api.items.createItem(world, {
        itemId: r.item.itemId, hue: r.item.hue, parent: pack, name: r.item.name,
      });
      // Visible note so the player knows what they got.
      player.client?.sendSystemMessage?.(
        `${npc.name ?? 'They'} hands you a ${r.item.name}.`);
    } catch { /* ignore */ }
  } else {
    try {
      const pkt = api.protocol.playSound?.({
        soundId: r.sound, volume: 0xFF, x: player.x, y: player.y, z: player.z,
      });
      if (pkt) {
        for (const m of world.mobiles.values()) {
          if (!m.client || m.map !== player.map) continue;
          if (Math.abs(m.x - player.x) > 12 || Math.abs(m.y - player.y) > 12) continue;
          m.client.send(pkt);
        }
      }
      player.client?.sendSystemMessage?.(`${npc.name ?? 'They'} cackles ominously.`);
    } catch { /* ignore */ }
  }
  return r;
}
