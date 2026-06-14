// Talismans — ML+ jewelry slot 28 (Talisman). Each carries a
// passive bonus (slayer / protection / craft / killer-block).
// ServUO `BaseTalisman.cs` + 80+ subclasses; we register the canonical
// subset that appears as boss/loot drops. The bonus payload lives in
// `_magicProps` so the OPL renderer + combat hook pick them up.



// --- script loader pattern: queue at module-load, flush in default register() ---
const __PENDING__ = [];

function talisman(def) {
  __PENDING__.push({
    kind: 'jewelry',
    category: 'talisman',
    layer: 28,
    weight: 1,
    chargeable: true,
    ...def,
  });
}

// ---- Slayer talismans (combat damage bonus vs. tagged kind) ---------
talisman({ id: 0x2F58, name: 'Repond Slayer Talisman',     slayer: 'repond',     bonus: { damageMul: 2.0 } });
talisman({ id: 0x2F58, name: 'Reptile Slayer Talisman',    tagId: 'talisman-reptile-slayer',  slayer: 'reptile',    bonus: { damageMul: 2.0 } });
talisman({ id: 0x2F58, name: 'Undead Slayer Talisman',     tagId: 'talisman-undead-slayer',   slayer: 'undead',     bonus: { damageMul: 2.0 } });
talisman({ id: 0x2F58, name: 'Elemental Slayer Talisman',  tagId: 'talisman-elemental-slayer',slayer: 'elemental',  bonus: { damageMul: 2.0 } });
talisman({ id: 0x2F58, name: 'Demon Slayer Talisman',      tagId: 'talisman-demon-slayer',    slayer: 'demon',      bonus: { damageMul: 2.0 } });
talisman({ id: 0x2F58, name: 'Arachnid Slayer Talisman',   tagId: 'talisman-arachnid-slayer', slayer: 'arachnid',   bonus: { damageMul: 2.0 } });

// ---- Protection (damage mitigation vs. tagged kind) ----------------
talisman({ id: 0x2F58, name: 'Repond Protection Talisman', tagId: 'talisman-repond-protect',
  protectionVs: 'repond',  bonus: { damageReduce: 0.25 } });
talisman({ id: 0x2F58, name: 'Reptile Protection Talisman', tagId: 'talisman-reptile-protect',
  protectionVs: 'reptile', bonus: { damageReduce: 0.25 } });
talisman({ id: 0x2F58, name: 'Undead Protection Talisman',  tagId: 'talisman-undead-protect',
  protectionVs: 'undead',  bonus: { damageReduce: 0.25 } });
talisman({ id: 0x2F58, name: 'Demon Protection Talisman',   tagId: 'talisman-demon-protect',
  protectionVs: 'demon',   bonus: { damageReduce: 0.25 } });

// ---- Craft talismans (skill bonus / faster crafting) ---------------
talisman({ id: 0x2F58, name: 'Tinkering Talisman',  tagId: 'talisman-tinkering',
  craftSkill: 'tinkering', bonus: { skillMod: 10, exceptionalChance: 0.05 } });
talisman({ id: 0x2F58, name: 'Blacksmithy Talisman', tagId: 'talisman-blacksmith',
  craftSkill: 'blacksmithy', bonus: { skillMod: 10, exceptionalChance: 0.05 } });
talisman({ id: 0x2F58, name: 'Tailoring Talisman',  tagId: 'talisman-tailoring',
  craftSkill: 'tailoring', bonus: { skillMod: 10, exceptionalChance: 0.05 } });
talisman({ id: 0x2F58, name: 'Carpentry Talisman',  tagId: 'talisman-carpentry',
  craftSkill: 'carpentry', bonus: { skillMod: 10, exceptionalChance: 0.05 } });
talisman({ id: 0x2F58, name: 'Fletching Talisman',  tagId: 'talisman-fletching',
  craftSkill: 'fletching', bonus: { skillMod: 10, exceptionalChance: 0.05 } });
talisman({ id: 0x2F58, name: 'Mining Talisman',     tagId: 'talisman-mining',
  craftSkill: 'mining', bonus: { skillMod: 10, doubleResource: 0.05 } });
talisman({ id: 0x2F58, name: 'Lumberjack Talisman', tagId: 'talisman-lumberjack',
  craftSkill: 'lumberjacking', bonus: { skillMod: 10, doubleResource: 0.05 } });
talisman({ id: 0x2F58, name: 'Cartography Talisman',tagId: 'talisman-cartography',
  craftSkill: 'cartography', bonus: { skillMod: 10 } });

// ---- Summoner talismans (charges → summon) -------------------------
talisman({ id: 0x2F58, name: 'Bone Daemon Summoner', tagId: 'talisman-summon-bone-daemon',
  summon: 'BoneDaemon', defaultCharges: 5 });
talisman({ id: 0x2F58, name: 'Wisp Summoner', tagId: 'talisman-summon-wisp',
  summon: 'Wisp', defaultCharges: 10 });
talisman({ id: 0x2F58, name: 'Cu Sidhe Summoner', tagId: 'talisman-summon-cu-sidhe',
  summon: 'CuSidhe', defaultCharges: 5 });

// ---- Generic stat / skill talismans --------------------------------
talisman({ id: 0x2F58, name: 'Magical Talisman of Strength',  tagId: 'talisman-stat-str',
  bonus: { strBonus: 5 } });
talisman({ id: 0x2F58, name: 'Magical Talisman of Dexterity', tagId: 'talisman-stat-dex',
  bonus: { dexBonus: 5 } });
talisman({ id: 0x2F58, name: 'Magical Talisman of Wisdom',    tagId: 'talisman-stat-int',
  bonus: { intBonus: 5 } });
talisman({ id: 0x2F58, name: 'Magical Talisman of Defense',   tagId: 'talisman-defense',
  bonus: { armorBonus: 10 } });


// --- script entry point ----------------------------------------------
export default function register(api) {
  const reg = api.catalog?.items?.registerItem;
  if (!reg) { api.log?.('talismans: registerItem missing, skipping'); return () => {}; }
  let count = 0;
  for (const def of __PENDING__) { try { reg(def); count++; } catch (e) { api.log?.('talismans: ' + e.message); } }
  api.log?.('talismans: registered ' + count + ' items');
  return () => {};
}