// Ethereal Mounts — semi-transparent rideable mounts that don't appear
// in the stable / don't need feeding. ServUO `Items/Mounts/EthernalMount.cs`.
//
// Spec:
//   • 16 hue variants (white, black, brown, light-grey, etc.)
//   • Each ethereal mount is a *statue* item that, on double-click, spawns
//     the rider on a normal-mount mob with `ethereal:true` flag.
//   • When the rider dismounts, the statue rematerializes in their pack.
//   • Veteran-reward redemption gives one ethereal as the reward (tier 4+).
//   • Ethereals are unaffected by mount fatigue (stamina drain disabled).
//
// API:
//   ether.summonMount(world, mob, statue)     — create the rideable mount
//   ether.dismountStatue(world, mob, mount)   — return statue to pack
//   ether.createStatue(kind, hue)             — build new statue item

const ETHEREAL_MOUNT_KINDS = Object.freeze([
  'ethereal-horse', 'ethereal-llama', 'ethereal-ostard',
  'ethereal-kirin', 'ethereal-unicorn', 'ethereal-ridgeback',
  'ethereal-swamp-dragon', 'ethereal-beetle',
  'ethereal-reptalon', 'ethereal-cu-sidhe', 'ethereal-hiryu',
  'ethereal-dragon', 'ethereal-bake-kitsune', 'ethereal-fire-steed',
  'ethereal-skeletal-steed', 'ethereal-charger',
]);

const ETHEREAL_HUES = Object.freeze([
  0,        // base
  0x055A,   // black
  0x047E,   // ice white
  0x0455,   // pink
  0x0537,   // crimson
  0x047F,   // gold
  0x0480,   // silver
  0x0481,   // copper
  0x0482,   // bronze
  0x0483,   // shadow
  0x0484,   // platinum
  0x0489,   // jade
  0x048D,   // ruby
  0x0492,   // sapphire
  0x0497,   // emerald
  0x04A8,   // valorite
]);

const ETHEREAL_GLOW_HUE = 0x4001;       // half-transparent white tint

/** Build a new ethereal-statue item (un-summoned form). */
export function createStatue(kind, hue = 0) {
  if (!ETHEREAL_MOUNT_KINDS.includes(kind)) {
    throw new Error(`unknown ethereal kind: ${kind}`);
  }
  return {
    itemId: 0x20DD,                     // OSI ethereal-statue graphic
    name: `${kind.replace(/-/g, ' ')} statuette`,
    weight: 5,
    hue,
    ethereal: { kind, hue, summoned: false },
  };
}

/**
 * Summon the rideable mount from a statue. Returns the mount mobile.
 * The statue stays in pack but flagged `summoned: true` so double-clicking
 * again dismounts. Caller is responsible for actually placing the mob in
 * the world via `world.createMobileFromKind(kind, …)`.
 */
export function summonMount(world, mob, statue) {
  if (!world || !mob || !statue?.ethereal) return null;
  if (statue.ethereal.summoned) return null;
  const { kind, hue } = statue.ethereal;
  const mount = world.createMobileFromKind?.(kind, {
    x: mob.x, y: mob.y, z: mob.z, map: mob.map,
    hue: hue || ETHEREAL_GLOW_HUE,
  });
  if (!mount) return null;
  mount.ethereal = true;
  mount.controlMaster = mob.serial;
  mount.body = MOUNT_BODY[kind] ?? mount.body;
  // Translucency hint for the client renderer (alpha 0.65).
  mount.translucent = true;
  // Auto-mount.
  mob._mountSerial = mount.serial;
  mob.body = MOUNT_RIDER_BODY[kind] ?? mob.body;
  statue.ethereal.summoned = true;
  return mount;
}

/** Return the statue to inventory + remove the mount. */
export function dismountStatue(world, mob, mount) {
  if (!world || !mob || !mount) return false;
  if (mob._mountSerial !== mount.serial) return false;
  mob._mountSerial = 0;
  // BH #14 A1 — was `world.mobiles.delete` direct, bypassing
  // destroyMobile → sector cleanup + onMobileDestroyed hooks missed +
  // _mobsWithEffects index leaked. Use canonical destroyer.
  world.destroyMobile?.(mount.serial);
  // BH #14 B5 — reverse parent index instead of full items walk.
  const idx = world._childrenByParent?.get?.(mob.serial);
  const iter = idx
    ? Array.from(idx, (s) => world.items.get(s)).filter(Boolean)
    : Array.from(world.items?.values?.() ?? []).filter((it) => it.parent === mob.serial);
  for (const it of iter) {
    if (it.ethereal?.summoned) {
      it.ethereal.summoned = false;
      return true;
    }
  }
  return false;
}

const MOUNT_BODY = Object.freeze({
  'ethereal-horse':       0xE2,
  'ethereal-llama':       0xDC,
  'ethereal-ostard':      0xDB,
  'ethereal-kirin':       0x84,
  'ethereal-unicorn':     0x7A,
  'ethereal-ridgeback':   0x18A,
  'ethereal-swamp-dragon': 0x31A,
  'ethereal-beetle':      0x317,
  'ethereal-reptalon':    0x114,
  'ethereal-cu-sidhe':    0x115,
  'ethereal-hiryu':       0x6A,
  'ethereal-dragon':      0x3D,
  'ethereal-bake-kitsune': 0xF6,
  'ethereal-fire-steed':  0x77,
  'ethereal-skeletal-steed': 0x319,
  'ethereal-charger':     0x18A,
});

const MOUNT_RIDER_BODY = Object.freeze({
  'ethereal-horse':       0x00C8,
  'ethereal-llama':       0x00DC,
  'ethereal-ostard':      0x00E2,
  'ethereal-kirin':       0x00DA,
});

export const ETHEREAL_CONST = Object.freeze({
  ETHEREAL_MOUNT_KINDS, ETHEREAL_HUES, ETHEREAL_GLOW_HUE,
  MOUNT_BODY, MOUNT_RIDER_BODY,
});
