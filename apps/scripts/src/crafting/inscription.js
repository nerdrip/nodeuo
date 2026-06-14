// Inscription — skill id 24. Crafts spell scrolls (one per spell). Each
// recipe needs 1 blank scroll (0x0E34) + the spell's reagents (consumed
// from the player's pack as part of the recipe inputs). Higher-circle
// scrolls require higher Inscription skill.
//
// We don't ship per-spell unique scroll item ids here — UO's spell-scroll
// gump uses a single sprite per circle. For an MVP we register a few
// representative spells; the full set can mirror SPELLS_BY_CIRCLE later.

// Inscription = 24 in skills.json. The earlier value 22 collided with
// Hiding.

// --- queue-and-flush loader pattern -------------------------------------
const __PENDING__ = [];

const SKILL = 24;
const BLANK_SCROLL = 0x0E34;

// Reagent template item IDs (from items catalog) — these match the
// reagents consumeReagents resolves to via api.templates.
const REAG_BLACK_PEARL  = 0x0F7A;
const REAG_GINSENG      = 0x0F85;
const REAG_GARLIC       = 0x0F84;
const REAG_NIGHTSHADE   = 0x0F88;
const REAG_BLOOD_MOSS   = 0x0F7B;
const REAG_SPIDERS_SILK = 0x0F8D;
const REAG_MANDRAKE     = 0x0F86;
const REAG_SULFUROUS_ASH = 0x0F8C;
const REAG_BAT_WING      = 0x0F78;
const REAG_GRAVE_DUST    = 0x0F8F;
const REAG_DAEMON_BLOOD  = 0x0F7D;
const REAG_NOX_CRYSTAL   = 0x0F8E;
const REAG_PIG_IRON      = 0x0F8A;

// Audit #35 P2 #6 — ServUO `DefInscription.cs` charges mana per craft
// (`SetManaReq(index, m_Mana)`) so a low-Int scribe can't trivially
// mass-produce 8th-circle scrolls. Mana cost per ServUO `Spell.GetMana`
// table is roughly 4×circle² for low circles; we approximate with the
// canonical per-circle ladder.
const CIRCLE_MANA = [0, 4, 6, 9, 11, 14, 20, 40, 50];

function scribe(id, name, circle, scrollItemId, reagents, opts = {}) {
  __PENDING__.push({
    id, name, category: `Circle ${circle}`, skillId: SKILL,
    minSkill: opts.minSkill ?? (circle - 1) * 100,
    maxSkill: opts.maxSkill ?? (circle - 1) * 100 + 350,
    outputItemId: scrollItemId, outputCount: 1,
    inputs: [{ itemId: BLANK_SCROLL, count: 1 }, ...reagents],
    exceptionalChance: opts.exceptionalChance ?? 0.0,
    // Audit #35 P2 #6 — mana cost stamped on the recipe; runCraft
    // refuses when caster lacks mana. ServUO also requires the
    // matching spell in the caster's spellbook, which we don't yet
    // model in the recipe — that gate is deferred until we add a
    // `requiresSpell` field per scribe call (full per-spell rewrite).
    manaCost: opts.manaCost ?? CIRCLE_MANA[circle] ?? 4,
  });
}

// Circle 1
scribe(22001, 'Heal Scroll',         1, 0x1F2D, [
  { itemId: REAG_GARLIC, count: 1 },
  { itemId: REAG_GINSENG, count: 1 },
  { itemId: REAG_SPIDERS_SILK, count: 1 },
]);
scribe(22002, 'Magic Arrow Scroll',  1, 0x1F2E, [
  { itemId: REAG_BLACK_PEARL, count: 1 },
  { itemId: REAG_SULFUROUS_ASH, count: 1 },
]);

// Circle 2
scribe(22011, 'Cure Scroll',         2, 0x1F35, [
  { itemId: REAG_GARLIC, count: 1 },
  { itemId: REAG_GINSENG, count: 1 },
]);
scribe(22012, 'Harm Scroll',         2, 0x1F36, [
  { itemId: REAG_NIGHTSHADE, count: 1 },
  { itemId: REAG_SPIDERS_SILK, count: 1 },
]);

// Circle 3
scribe(22021, 'Fireball Scroll',     3, 0x1F3D, [
  { itemId: REAG_BLACK_PEARL, count: 1 },
]);
scribe(22022, 'Bless Scroll',        3, 0x1F3C, [
  { itemId: REAG_GARLIC, count: 1 },
  { itemId: REAG_MANDRAKE, count: 1 },
  { itemId: REAG_GINSENG, count: 1 },
]);

// Circle 4
scribe(22031, 'Lightning Scroll',    4, 0x1F45, [
  { itemId: REAG_BLACK_PEARL, count: 1 },
  { itemId: REAG_MANDRAKE, count: 1 },
  { itemId: REAG_SULFUROUS_ASH, count: 1 },
]);
scribe(22032, 'Greater Heal Scroll', 4, 0x1F44, [
  { itemId: REAG_GARLIC, count: 1 },
  { itemId: REAG_GINSENG, count: 1 },
  { itemId: REAG_MANDRAKE, count: 1 },
  { itemId: REAG_SPIDERS_SILK, count: 1 },
]);

// Circle 5
scribe(22041, 'Mind Blast Scroll',   5, 0x1F4D, [
  { itemId: REAG_BLACK_PEARL, count: 1 },
  { itemId: REAG_MANDRAKE, count: 1 },
  { itemId: REAG_NIGHTSHADE, count: 1 },
  { itemId: REAG_SULFUROUS_ASH, count: 1 },
]);

// Circle 6
scribe(22051, 'Energy Bolt Scroll',  6, 0x1F55, [
  { itemId: REAG_BLACK_PEARL, count: 1 },
  { itemId: REAG_NIGHTSHADE, count: 1 },
]);
scribe(22052, 'Explosion Scroll',    6, 0x1F56, [
  { itemId: REAG_BLOOD_MOSS, count: 1 },
  { itemId: REAG_MANDRAKE, count: 1 },
]);

// Circle 7
scribe(22061, 'Flame Strike Scroll', 7, 0x1F5D, [
  { itemId: REAG_SPIDERS_SILK, count: 1 },
  { itemId: REAG_SULFUROUS_ASH, count: 1 },
]);
scribe(22062, 'Gate Travel Scroll', 7, 0x1F60, [
  { itemId: REAG_MANDRAKE, count: 1 },
  { itemId: REAG_SULFUROUS_ASH, count: 1 },
  { itemId: REAG_BLACK_PEARL, count: 1 },
]);
scribe(22063, 'Mass Dispel Scroll',  7, 0x1F61, [
  { itemId: REAG_GARLIC, count: 1 },
  { itemId: REAG_MANDRAKE, count: 1 },
  { itemId: REAG_BLACK_PEARL, count: 1 },
]);
scribe(22064, 'Meteor Swarm Scroll', 7, 0x1F62, [
  { itemId: REAG_BLOOD_MOSS, count: 1 },
  { itemId: REAG_SPIDERS_SILK, count: 1 },
  { itemId: REAG_SULFUROUS_ASH, count: 1 },
]);
scribe(22065, 'Polymorph Scroll',    7, 0x1F63, [
  { itemId: REAG_BLOOD_MOSS, count: 1 },
  { itemId: REAG_SPIDERS_SILK, count: 1 },
  { itemId: REAG_MANDRAKE, count: 1 },
]);
scribe(22066, 'Mana Vampire Scroll', 7, 0x1F64, [
  { itemId: REAG_BLACK_PEARL, count: 1 },
  { itemId: REAG_BLOOD_MOSS, count: 1 },
  { itemId: REAG_MANDRAKE, count: 1 },
  { itemId: REAG_SPIDERS_SILK, count: 1 },
]);
scribe(22067, 'Energy Field Scroll', 7, 0x1F65, [
  { itemId: REAG_BLACK_PEARL, count: 1 },
  { itemId: REAG_MANDRAKE, count: 1 },
  { itemId: REAG_SPIDERS_SILK, count: 1 },
  { itemId: REAG_SULFUROUS_ASH, count: 1 },
]);

// Circle 8
scribe(22071, 'Earthquake Scroll',   8, 0x1F66, [
  { itemId: REAG_BLOOD_MOSS, count: 1 },
  { itemId: REAG_GINSENG, count: 1 },
  { itemId: REAG_MANDRAKE, count: 1 },
  { itemId: REAG_SULFUROUS_ASH, count: 1 },
]);
scribe(22072, 'Energy Vortex Scroll',8, 0x1F67, [
  { itemId: REAG_BLACK_PEARL, count: 1 },
  { itemId: REAG_BLOOD_MOSS, count: 1 },
  { itemId: REAG_MANDRAKE, count: 1 },
  { itemId: REAG_NIGHTSHADE, count: 1 },
]);
scribe(22073, 'Resurrection Scroll', 8, 0x1F68, [
  { itemId: REAG_BLOOD_MOSS, count: 1 },
  { itemId: REAG_GINSENG, count: 1 },
  { itemId: REAG_GARLIC, count: 1 },
]);
scribe(22074, 'Air Elemental Scroll',8, 0x1F69, [
  { itemId: REAG_BLOOD_MOSS, count: 1 },
  { itemId: REAG_MANDRAKE, count: 1 },
  { itemId: REAG_SPIDERS_SILK, count: 1 },
]);
scribe(22075, 'Earth Elemental Scroll',8, 0x1F6A, [
  { itemId: REAG_BLOOD_MOSS, count: 1 },
  { itemId: REAG_MANDRAKE, count: 1 },
  { itemId: REAG_SULFUROUS_ASH, count: 1 },
]);
scribe(22076, 'Fire Elemental Scroll',8, 0x1F6B, [
  { itemId: REAG_MANDRAKE, count: 1 },
  { itemId: REAG_SPIDERS_SILK, count: 1 },
  { itemId: REAG_SULFUROUS_ASH, count: 1 },
]);
scribe(22077, 'Water Elemental Scroll',8, 0x1F6C, [
  { itemId: REAG_BLOOD_MOSS, count: 1 },
  { itemId: REAG_MANDRAKE, count: 1 },
  { itemId: REAG_SPIDERS_SILK, count: 1 },
]);
scribe(22078, 'Summon Daemon Scroll',8, 0x1F6D, [
  { itemId: REAG_BAT_WING ?? REAG_BLOOD_MOSS, count: 1 },
  { itemId: REAG_MANDRAKE, count: 1 },
  { itemId: REAG_SULFUROUS_ASH, count: 1 },
  { itemId: REAG_SPIDERS_SILK, count: 1 },
]);

// =====================================================================
//  Necromancy + Chivalry + Bushido + Ninjitsu + Spellweaving + Mysticism
//  scrolls — most schools allow inscription of their book pages from the
//  same blank-scroll stock.
// =====================================================================

// Necromancy scrolls (crafted with Inscription skill 24). Each scroll uses a representative item id +
// 2 reagents. Real ServUO ids vary per expansion — we use 0x227x range.
const necroScroll = (id, name, scrollId, reagents, minSkill = 200) =>
  __PENDING__.push({
    id, name, category: 'Necromancy', skillId: SKILL,
    minSkill, maxSkill: minSkill + 350,
    outputItemId: scrollId, outputCount: 1,
    inputs: [{ itemId: BLANK_SCROLL, count: 1 }, ...reagents],
  });
necroScroll(22101, 'Animate Dead Scroll',     0x2270, [{ itemId: REAG_BLOOD_MOSS, count: 1 }, { itemId: REAG_MANDRAKE, count: 1 }]);
necroScroll(22102, 'Blood Oath Scroll',       0x2271, [{ itemId: REAG_NIGHTSHADE, count: 1 }, { itemId: REAG_SPIDERS_SILK, count: 1 }]);
necroScroll(22103, 'Corpse Skin Scroll',      0x2272, [{ itemId: REAG_BAT_WING ?? REAG_BLOOD_MOSS, count: 1 }]);
necroScroll(22104, 'Curse Weapon Scroll',     0x2273, [{ itemId: REAG_NIGHTSHADE, count: 1 }, { itemId: REAG_SPIDERS_SILK, count: 1 }]);
necroScroll(22105, 'Evil Omen Scroll',        0x2274, [{ itemId: REAG_NIGHTSHADE, count: 1 }, { itemId: REAG_SPIDERS_SILK, count: 1 }]);
necroScroll(22106, 'Horrific Beast Scroll',   0x2275, [{ itemId: REAG_BLOOD_MOSS, count: 2 }, { itemId: REAG_NIGHTSHADE, count: 2 }], 400);
necroScroll(22107, 'Lich Form Scroll',        0x2276, [{ itemId: REAG_BAT_WING ?? REAG_BLOOD_MOSS, count: 2 }, { itemId: REAG_NIGHTSHADE, count: 2 }], 700);
necroScroll(22108, 'Mind Rot Scroll',         0x2277, [{ itemId: REAG_NIGHTSHADE, count: 1 }, { itemId: REAG_SPIDERS_SILK, count: 1 }]);
necroScroll(22109, 'Pain Spike Scroll',       0x2278, [{ itemId: REAG_NIGHTSHADE, count: 1 }, { itemId: REAG_SPIDERS_SILK, count: 1 }]);
necroScroll(22110, 'Poison Strike Scroll',    0x2279, [{ itemId: REAG_NIGHTSHADE, count: 2 }, { itemId: REAG_SPIDERS_SILK, count: 1 }]);
necroScroll(22111, 'Strangle Scroll',         0x227A, [{ itemId: REAG_BLOOD_MOSS, count: 1 }, { itemId: REAG_NIGHTSHADE, count: 1 }, { itemId: REAG_SPIDERS_SILK, count: 1 }]);
necroScroll(22112, 'Summon Familiar Scroll', 0x227B, [{ itemId: REAG_BLOOD_MOSS, count: 1 }, { itemId: REAG_BAT_WING ?? REAG_NIGHTSHADE, count: 1 }]);
necroScroll(22113, 'Vampiric Embrace Scroll', 0x227C, [{ itemId: REAG_BAT_WING ?? REAG_BLOOD_MOSS, count: 2 }, { itemId: REAG_NIGHTSHADE, count: 2 }], 750);
necroScroll(22114, 'Vengeful Spirit Scroll',  0x227D, [{ itemId: REAG_BAT_WING ?? REAG_BLOOD_MOSS, count: 2 }, { itemId: REAG_BLOOD_MOSS, count: 1 }, { itemId: REAG_NIGHTSHADE, count: 1 }], 600);
necroScroll(22115, 'Wither Scroll',           0x227E, [{ itemId: REAG_NIGHTSHADE, count: 2 }, { itemId: REAG_BLOOD_MOSS, count: 2 }, { itemId: REAG_SPIDERS_SILK, count: 1 }], 500);
necroScroll(22116, 'Wraith Form Scroll',      0x227F, [{ itemId: REAG_NIGHTSHADE, count: 1 }, { itemId: REAG_SPIDERS_SILK, count: 1 }, { itemId: REAG_BLOOD_MOSS, count: 1 }], 250);
necroScroll(22117, 'Exorcism Scroll',         0x2280, [{ itemId: REAG_GINSENG, count: 1 }, { itemId: REAG_NIGHTSHADE, count: 1 }, { itemId: REAG_BLOOD_MOSS, count: 1 }], 400);

void REAG_GRAVE_DUST; void REAG_DAEMON_BLOOD; void REAG_NOX_CRYSTAL; void REAG_PIG_IRON;


// --- script entry point ----------------------------------------------
export default function register(api) {
  const sys = api.systems?.crafting;
  if (!sys?.registerRecipe) { api.log?.('crafting/inscription: engine missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { sys.registerRecipe(def); count++; } catch (e) { api.log?.('crafting/inscription: ' + e.message); } }
  api.log?.('crafting/inscription: registered ' + count + ' recipes');
  return () => {};
}
