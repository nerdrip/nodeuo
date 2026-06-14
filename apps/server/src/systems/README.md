# Systems — gameplay engines

Each subdirectory is a self-contained gameplay engine ported from ServUO.
Engines own the dispatch pipeline for their domain (cast pipeline, craft
pipeline, combat pipeline…); domain content (individual spells, recipes)
lives in sibling files that self-register at module-load time.

## Why not ServUO's OOP model?

ServUO gives every spell and every recipe its own C# class (200+ files
per school/trade). Each class inherits from a base (`MagerySpell`,
`CraftItem`, `Skill`) and overrides `OnCast()` / `OnCraft()`. That's a
lot of boilerplate for a data pattern — a spell is *99% data* (id, name,
mana cost, target type, effect closure). We collapsed that into plain-
object definitions that the dispatcher reads with `dispatch(def, ctx)`.

Net effect: **~10× less code per parity feature** with the same gameplay.

## Architecture

```
systems/
├── spells/
│   ├── registry.js    ← shared Map<id, SpellDef>, no deps
│   ├── index.js       ← castSpell(ctx) dispatcher, re-exports registry
│   ├── chivalry.js    ← 10 spells, `registerSpell({...})` each
│   └── magery.js      ← 64 spells
├── crafting/
│   ├── registry.js
│   ├── index.js       ← craft(ctx) dispatcher
│   ├── blacksmithing.js ← 30+ recipes
│   ├── tailoring.js     ← 40+ recipes
│   └── alchemy.js       ← 25 potions
└── (future: pet-training, factions, housing, …)
```

## Adding a new spell school

1. Create `systems/spells/<school>.js`.
2. At top: `import { registerSpell } from './registry.js';`
3. For each spell call `registerSpell({ id, name, school, skillId,
   minSkill, mana, delayMs, soundId, effect })`.
4. Add `import './<school>.js';` at the bottom of `systems/spells/index.js`.

Done. The dispatcher picks up the new spells automatically.

## Adding a new crafting profession

Identical pattern under `systems/crafting/`. Skill id is the ServUO skill
number (7 blacksmith, 8 tailor, 2 alchemy, 9 carpenter, 11 cartography,
23 cooking, 26 magery, …).

## Critical: no circular imports

The `registry.js` split exists because `index.js` imports domains at the
bottom (for side-effect registration) AND domains import the registry.
Without the split the ES-module graph forms a cycle that leaves exports
undefined at evaluation time.

Rule of thumb: **domain files import only `./registry.js`**. Never
`./index.js`.

## Content vs Systems

- `systems/*` — the engines. Change these to change *behaviour*.
- `content/*` — the data. Change these to change *what exists*.

Item catalogue (`content/items/`), mobile templates (`content/mobiles/`),
regions (`content/regions/`), and quests (`content/quests/`) follow the
same registry pattern: a `registry.js` with a Map, domain files that
call `registerItem/Mobile/Region/...`, and an `index.js` that re-exports
and loads the domains.

## Migration status

| System | Coverage | Notes |
|---|---|---|
| Spells / Magery   | 64/64 | Full book; circles 1-8 |
| Spells / Necromancy | 17/17 | Full book (FAZA K) |
| Spells / Chivalry | 10/10 | All effects implemented (FAZA AI, AS) |
| Spells / Bushido | 6/6 | Full book (FAZA Q part 2) |
| Spells / Ninjitsu | 8/8 | Full book (FAZA Q part 2) |
| Spells / Spellweaving | 16/16 | Full book (FAZA Q part 2) |
| Spells / Mysticism | 16/16 | Full book (FAZA Q part 2) |
| Crafting / Blacksmithing | 35/60 | Weapons, armor, shields |
| Crafting / Tailoring | 40/50 | Clothing, leather, bone, studded |
| Crafting / Alchemy | 25/25 | All standard potions |
| Crafting / Carpentry | 15/30 | Weapons, containers, furniture |
| Crafting / Fletching | 6/20 | Bows, crossbows, arrows, bolts |
| Crafting / Inscription | 12/64 | Circles 1-7 |
| Crafting / Cooking / Cartography / Mining (commands) | ✅ | Targeted activities (FAZA S, X) |
| Items / Weapons | 50+/80 | Melee + ranged + ammo |
| Items / Armor | 50+/60 | All materials represented |
| Items / Consumables | 50+/100 | Potions + food + reagents (necro+mystic) |
| Mobiles / Humanoids | 8/30 | Wanderer/Farmer/Guard/Milkmaid/Hermit/Beggar/etc |
| Mobiles / Animals | 14/40 | Cat/dog/horse/llama/bull/wolf/chicken/pig/sheep/deer/rabbit |
| Mobiles / Undead | 9/20 | Skeleton/zombie/lich/ghoul/mummy/wisp/skeletal-knight |
| Mobiles / Monsters | 16+/30 | Dragon/cyclops/titan/4 elementals/ettin/ogre/troll/balron/daemon |
| Banker NPC | ✅ | Speech-driven (FAZA Y) |
| Healer NPC | ✅ | AI behaviour |
| Vendor types | 5 | Provisioner/Blacksmith/Mage/Armorer/Innkeeper |
| Quest system | ✅ | 5 sample quests + journal commands (FAZA AA) |
| Champion altars | 3 | Shame/Destard/Despise + boss + power-scroll loot |
| Houses | scaffold | Place/walls/door spawns + ACL |
| Boats (rowboat) | MVP | Spawn/board/forward/turn |
| Mounted system | MVP | Body swap on adjacent owned pet |
| Stable | ✅ | 5-pet capacity |
| Region tracker (music) | ✅ | 0x6D PlayMusic on region cross |
| Notoriety | per-viewer | Party/guild/pet inheritance |
| Combat status consumers | 11 | Lightning-strike, evasion, blood-oath, vampiric etc. |
| Skill action bar | ✅ | 0x12 type 0x24 dispatched to commands (FAZA AS) |
