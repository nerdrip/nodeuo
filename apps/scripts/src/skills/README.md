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
| 13 | Cartography             | [crafting recipes](../crafting/cartography.js) from UseSkill; [drawmap/decodemap](cartography.js) for treasure maps |
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
  Spellweaving, Mysticism, and Bard Mastery) — implemented as authored
  definitions under [../spells/](../spells/) and dispatched by the server's
  spell system.
- **Bard skills** (Peacemaking, Provocation, Discordance) — authoritative
  effects live in `apps/server/src/systems/bards/bard-skills.js`; the player
  command adapters live in [../commands/economy/bard.js](../commands/economy/bard.js).
- **Crafting skills** (Alchemy, Blacksmithy, Bowcraft, Carpentry,
  Cooking-as-craft, Inscription, Tailoring, Tinkering, Glassblowing,
  Imbuing, Masonry) — implemented as recipe registries in
  [../crafting/](../crafting/) and triggered by `[craft` /
  `[imbue` / `[reforge` etc. commands.
- **Meditation** (47) has a direct action, while **Focus** (51),
  **Magic Resistance** (27), and the combat skills train or contribute
  passively. **Evaluating Intelligence** (17) is directly usable through
  `evalint`. Their formulas live in server regeneration, combat, and spell
  systems.
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

The paperdoll skill button (opcode 0x12 type 0x24) is routed through the
canonical `SKILL_TO_COMMAND` table in
`apps/server/src/net/skill-actions.js`. Adding an active skill requires an
implementation plus a 1-based skill-id entry there; passive skills must remain
absent so the client receives the correct passive-action message.
