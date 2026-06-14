# `scripts/src/skills/` — skill implementations

Each file here implements a single UO skill — exposes a player-triggerable
behavior via `[command` and/or the paperdoll skill button (opcode 0x12).

The skill table itself lives in [data/config/skills.json](../data/config/skills.json)
(id, name, primary stat, group). This folder holds the *executable
behavior* of those skills.

## Mapping

| ID | Skill | Implementation |
|---|---|---|
| 2  | Anatomy                 | [anatomy.js](anatomy.js) |
| 3  | Animal Lore             | [lore.js](lore.js) |
| 4  | Item Identification     | [identify.js](identify.js) |
| 5  | Arms Lore               | [wpn.js](wpn.js) |
| 7  | Begging                 | [beg.js](beg.js) |
| 11 | Camping                 | [camp.js](camp.js) |
| 13 | Cartography             | [cartography.js](cartography.js) |
| 14 | Cooking                 | [cook.js](cook.js) |
| 15 | Detect Hidden           | [detect-hidden.js](detect-hidden.js) |
| 18 | Healing                 | [bandage.js](bandage.js) |
| 19 | Fishing                 | [fish.js](fish.js) |
| 20 | Forensic Evaluation     | [forensic.js](forensic.js) |
| 21 | Herding                 | [herd.js](herd.js) |
| 22 | Hiding                  | [hide.js](hide.js) |
| 25 | Lockpicking             | [lockpick.js](lockpick.js) |
| 29 | Snooping                | [snoop.js](snoop.js) |
| 31 | Poisoning               | [poison.js](poison.js) |
| 33 | Spirit Speak            | [spiritspeak.js](spiritspeak.js) |
| 34 | Stealing                | [steal.js](steal.js) |
| 36 | Animal Taming           | [tame.js](tame.js) |
| 37 | Taste Identification    | [tasteid.js](tasteid.js) |
| 39 | Tracking                | [track.js](track.js) |
| 40 | Veterinary              | [vet.js](vet.js) |
| 45 | Lumberjacking           | [chop.js](chop.js) |
| 46 | Mining                  | [mine.js](mine.js) + [dig.js](dig.js) |
| 48 | Stealth                 | [stealth.js](stealth.js) |
| 49 | Remove Trap             | [remove-trap.js](remove-trap.js) |

## Skills NOT implemented here (intentionally split elsewhere)

- **Combat skills** (Swordsmanship, Mace Fighting, Fencing, Archery,
  Throwing, Wrestling, Tactics, Parrying) — these are passive; their
  formulas live in `server/src/combat-formulas.js` (engine).
- **Magic skills** (Magery, Necromancy, Chivalry, Bushido, Ninjitsu,
  Spellweaving, Mysticism, Bard Mastery) — implemented as spell
  schools in [../spells/schools/](../spells/schools/).
- **Bard skills** (Peacemaking, Provocation, Discordance) — engine
  side in `server/src/systems/bard-skills.js`, command wrappers in
  `../commands/{peace,provoke,discord}.js` (TODO: move here).
- **Crafting skills** (Alchemy, Blacksmithy, Bowcraft, Carpentry,
  Cooking-as-craft, Inscription, Tailoring, Tinkering, Glassblowing,
  Imbuing, Masonry) — implemented as recipe registries in
  [../crafting/](../crafting/) and triggered by `[craft` /
  `[imbue` / `[reforge` etc. commands.
- **Meditation** (47), **Focus** (51), **Evaluating Intelligence**
  (17), **Eval Mage Resistance** (27), **Item ID extension** etc. —
  these are passive modifiers that affect other skills' rolls; their
  formulas live in `server/src/regen.js` and spell dispatcher.
- **Musicianship** (30) — passive prerequisite for bard skills; no
  standalone command.

## Pattern

Each file follows the standard script pattern:

```js
export default function register(api) {
  if (!api.commands) return () => {};
  api.commands.register({
    name: 'beg',
    help: '[beg — attempt the Begging skill.',
    access: 'Player',
    run(ctx) { /* skill check + reward logic */ },
  });
  return () => api.commands.unregister('beg');
}
```

The paperdoll skill button (opcode 0x12 type 0x24) is routed via the
SKILL_TO_COMMAND map in `server/src/net/handlers.js`. Adding a new
skill = add a file here + add the (skill_id → command) entry to the map.
