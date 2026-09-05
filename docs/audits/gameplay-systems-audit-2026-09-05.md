# Gameplay Systems Audit — 2026-09-05

## Outcome

This pass audited the executable gameplay surface rather than only counting
files. It covered the death/ghost lifecycle, Spirit Speak, skill routing,
spell and crafting catalogues, NPC AI, vendors, banking, training, persistence,
quests, player-facing reward economies, and cold script bootstrap. High-impact
defects found during the pass were fixed and protected by regression tests.

The audit does **not** claim frame-by-frame retail-era numerical parity for
every one of 155 spells or a manual playthrough of every recipe. The automated
coverage proves catalogue completeness, registration, important transactions,
and the cross-system paths listed below. Remaining manual and balance work is
recorded explicitly at the end.

## Audited surface

| Area | Audited catalogue/runtime surface |
| --- | ---: |
| Skills | 58 canonical, 1-based UO skill IDs |
| Spells | 155 executable definitions across 10 schools/groups |
| Crafting | 411 executable recipes across 11 registrars |
| Inscription | 97 scroll recipes and 98 item definitions including blank scrolls |
| Monsters | 803 templates, all mapped to a supported AI behavior |
| Base NPC catalogue | 57 templates |
| ServUO mobile catalogue extension | 335 monsters and 409 NPCs filled at boot |
| Extracted merchant data | 85 vendor catalogues, 2,024 buy/sell rows |
| Script bootstrap | 386 loaded, 32 intentionally skipped modules, 0 failures |

Spell counts are: Magery 64, Necromancy 17, Chivalry 10, Bushido 6,
Ninjitsu 8, Spellweaving 16, Mysticism 16, Gargoyle 1, Mastery 10, and
Bard Mastery 7.

Crafting counts are: Alchemy 20, Blacksmithing 77, Carpentry 32,
Cartography 11, Cooking 45, Fletching 6, Glassblowing 8, Inscription 97,
Masonry 12, Tailoring 38, and Tinkering 65.

## Correctness and performance fixes

### Death, ghosts, and Spirit Speak

- Death is idempotent. Concurrent or repeated lethal paths can no longer
  create duplicate corpses or repeat death-side state transitions.
- Ghost movement still uses authoritative collision and speed validation, but
  no longer drains stamina or becomes blocked by living-character fatigue and
  encumbrance rules.
- Ghost speech is now rendered per listener. Ghosts, staff, and listeners with
  active Spirit Speak receive the original text; ordinary living listeners
  receive canonical ghost speech. Whisper, normal speech, and yell use distinct
  ranges.
- The client no longer scrambles ghost speech globally. This prevents it from
  destroying text that a compatible external server intentionally made
  intelligible.
- Living vendors do not open trade for ghosts, and ordinary living NPCs do not
  react to unintelligible ghost speech or pet commands.
- Spirit Speak has a skill-scaled 15–180 second lifetime and clears its runtime
  listener state on removal and death.
- Healers use spatial queries rather than shard-wide scans and retain their
  resurrection restrictions for criminals and murderers.
- Corpse decay already uses a dedicated corpse index; the stale documentation
  implying a full item scan was identified for cleanup.

The behavior is aligned with the listener-specific ghost speech model in
[ServUO Mobile](https://raw.githubusercontent.com/ServUO/ServUO/pub57/Server/Mobile.cs)
and the timed listening model in
[ServUO Spirit Speak](https://raw.githubusercontent.com/ServUO/ServUO/pub57/Scripts/Skills/SpiritSpeak.cs).

### Skills and magic

- The complete 58-skill wire snapshot, locks, caps, active routing, and passive
  skill behavior are regression-tested.
- Cartography UseSkill now opens the Cartography crafting catalogue. Treasure
  map drawing and decoding remain explicit `drawmap`/`decodemap` actions.
- The 155-spell catalogue is checked for unique IDs and slugs, executable cast
  functions, mana values, target kinds, and school totals.
- Death Strike no longer owns an orphan raw timer. It uses the central status
  scheduler, applies after five seconds, doubles when the target moved, and
  reliably removes its marker.
- Periodic effects start their first tick after a complete interval rather than
  firing immediately on the next epoch-based sweep. Effected mobiles are added
  to and removed from the indexed scheduler set directly.
- NPC archers now use the shared combat hit formula, so skills, equipment,
  buffs, and debuffs affect them consistently with player combat.
- The scripted regeneration formulas now consume equipped `regenHits`,
  `regenMana`, and `regenStam`, plus Bard Invigorate, bedroll rest, Lich Form,
  Horrific Beast, Mystic Transformation, Stone Form, and Spirituality effects.
  Hot-unloading the script restores engine defaults instead of retaining stale
  function closures.
- Horrific Beast now uses body 746, the correct sound, its stronger unarmed
  range, +25% damage, +20 hit regeneration, and complete cleanup.
- Telekinesis invokes the normal item/template use dispatcher. Locked and raw
  trapped containers retain their safety checks instead of becoming a remote
  loot bypass.
- Spell Damage Increase now calls the real attributes API. Equipment,
  Reaper Form, and Mystic Transformation bonuses are no longer write-only
  fields.

### Crafting and Inscription

- Every recipe now declares a real tool kind. Previously, 314 non-Inscription
  recipes silently bypassed tool checks, sounds, delay, and charge consumption.
- Registry validation rejects malformed categories, skill IDs, skill ranges,
  output counts, mana values, exceptional chances, and missing tool kinds.
- Inscription now exposes all 64 Magery, 17 Necromancy, and 16 Mysticism
  scrolls with reagent, mana, skill, spellbook, and wire-art mappings.
- Mysticism's authored zero-based IDs are translated only at the classic UO
  spellbook boundary.
- Masonry uses Carpentry (skill 12), not Poisoning (skill 31). Masonry and
  Glassblowing are learned specialist branches and their craft views no longer
  mix unrelated recipes sharing the same base skill.
- Vendor-sold Masonry and Glassblowing manuals now carry executable item scripts
  and persistent unlock metadata. They must be inside the backpack and require
  Grandmaster Carpentry or Alchemy before they are consumed.
- The craft UI limit now accommodates the complete 97-entry Inscription branch.

Inscription inputs were cross-checked against
[ServUO DefInscription](https://raw.githubusercontent.com/ServUO/ServUO/pub57/Scripts/Services/Craft/DefInscription.cs).

### Vendors, bankers, trainers, and NPC AI

- Fixed the runtime merchant loader path. The extracted catalogue previously
  existed on disk but the live vendor script looked in a nonexistent directory,
  leaving roughly 60 merchant classes unavailable.
- Fixed the vendor extractor output path and its parser for the named/cliloc
  `GenericBuyInfo` overload. This restored specialist catalogues and goods such
  as `MasonryBook`, `MalletAndChisel`, `GlassblowingBook`, and `Blowpipe`.
- Authored shops retain their tuned presentation and prices while receiving
  non-duplicate canonical SBInfo goods. Extracted gameplay metadata is hydrated
  lazily so hot reload and test load order cannot strip it.
- Fresh and restored shop bindings now deliver identical `definitionId`, item
  script, category, weight, stackability, recipe unlock, and spellcraft fields.
- Vendor stock lookup is indexed by synthetic serial during transactions, and
  sell ownership is validated against one backpack snapshot instead of
  repeatedly walking the pack for every selected row.
- Banker windows show real contents. Withdrawals aggregate gold piles and are
  atomic when funds are insufficient. Speech throttling is per customer rather
  than global.
- Trainers aggregate multiple gold piles and debit atomically before teaching.
- Permanent regional guards were previously routed through a fallback vendor
  and then attached to a nonexistent `guard` behavior, leaving them inert. They
  now receive their NPC template body/stats/flags and executable guard AI, and
  reattach after restart.
- Town criers reattach their intended behavior after script load and walk
  through the authoritative movement/collision path.

`PresetMapEntry` is the only unresolved sell-side type. It is a ServUO pricing
descriptor rather than an item class; runtime intentionally skips it and uses
the concrete map entries instead.

### Bootstrap and persistence

- A stable `worldContentSeeds` map is created in engine systems.
- The CreateWorld completion marker is initialized only during real server
  bootstrap, avoiding constructor-level state that broke isolated spawner
  worlds and tests.
- Manual unlock fields, civic NPC identity, guard identity, and intended AI
  behavior survive persistence where required.
- A clean isolated cold start completed with zero mobiles, zero items, all 386
  script entry points loaded, and no script audit failures.
- ML quest logs, chain state, timed regeneration payloads, transformation
  modifiers, and Honesty item markers now survive a save/restart round trip.

### Executable wiring and dead-code follow-up

This follow-up traced mechanics from their script registration points through
their runtime consumers, persistence fields, hot-reload teardown, and combat or
world side effects. It specifically targeted definitions which looked complete
in the catalogue but previously had no effective gameplay consumer.

- Epoch timestamps are no longer truncated through signed 32-bit bitwise
  coercion in ping throttles, guard and shield windows, confidence, cannons,
  plants, houses, astronomy, the Magincia bazaar, seasonal events, vendors,
  pet training, and haggling. Long-running processes therefore retain correct
  expiry behavior.
- Movement now checks destination-region access before committing a step, so a
  denied transition cannot leak visibility updates, streaming changes, or
  region triggers. Paralyze and slow effects use the canonical movement fields.
- Ranged attacks enforce their attack cooldown before ammunition is consumed.
  Moving Shot uses Archery, Double Strike performs its second attack, Mortal
  Strike blocks bandage healing, and Dual Wield no longer forges equipment
  state while its timed effect is active.
- Previously write-only Bard, mastery, ethics, regeneration, stat-debuff,
  weapon-charge, poison, and on-hit fields now have central combat, status, AI,
  pet-training, or loot consumers. Targeted mastery actions validate their
  targets before charging mana.
- Rejuvenate, Stone Form, Conduit, Command Undead, Whispering, Warcry,
  Invigorate, Shield Bash, and Injected Strike now produce concrete gameplay
  effects with scheduled cleanup instead of only setting decorative flags.
- Party membership has stable party IDs and accepts both mobile objects and
  serials. PvP 2v2, Shadowguard, peerless encounters, and party-targeted
  abilities resolve persisted member serials back to live mobiles.
- Peerless altars validate offerings without consuming them, claim a real party
  instance, create and register the boss, and consume keys only after successful
  spawn. Failure releases the claim safely; completion and hot reload release
  arena ownership and preserve cooldown semantics.
- Craft and item registries now support identity-safe replacement and
  unregistration. Script-scoped item definitions and all craft registrars tear
  down their own registrations during hot reload, preventing stale aliases,
  recipes, art mappings, and race-driven removal of newer definitions.
- Identification wands now open a real target cursor, dispatch identification,
  and consume a charge. The previous item action returned before doing any work.
- Persisted spawner mobiles are adopted into their original groups on restart.
  The first group registration no longer creates a second population beside
  restored creatures.
- The active region-access and expansion-flag systems are exposed through the
  server service surface rather than remaining disconnected modules.
- Three obsolete, unreferenced implementations were removed: the duplicate
  daily-rares service, a fabricated mounted-combat bonus module, and an unused
  Shame boss rotation. The old standalone JSON spawner-persistence module was
  also removed after restart adoption was implemented in the authoritative
  spawner. A filename-level reachability scan now finds no unreferenced file
  among the 138 server system modules.

### Quests, virtues, and reward economies

- Mondain quest `chain`/`requires` metadata is preserved and enforced. Unique
  quests distinguish "already active" from "already completed", speech
  keywords are case-insensitive, and authored `points` skill rewards are
  applied rather than silently awarding zero.
- ML quest kills are attached to the canonical death hook, hook registration
  is hot-reload-safe, the quest journal receives hydrated active rows, and a
  classic text-command fallback can inspect, abandon, and transactionally
  claim rewards.
- Virtue invocation accepts both client lowercase keys and command-style
  capitalized keys. Cooldowns retain full JavaScript timestamps, Honor has a
  real one-strike combat consumer, Spirituality affects mana regeneration, and
  Honesty exposes item targeting.
- Ultima Store purchases resolve real item definitions, deliver first, and
  debit sovereigns only after successful delivery.
- Veteran eligibility reads the actual persisted account creation field.
  Failed reward delivery rolls redemption back, and all 68 configured reward
  kinds have delivery descriptors.
- Auctions use nested backpack gold, atomic debit/refund logic, complete item
  snapshots, persistent lots, idempotent delayed reclaim, and safe settlement
  flags for item delivery and seller payout.
- Autosave coordination was extracted from the entry point into a focused
  lifecycle module. Coalesced world saves and auxiliary sidecar writers retain
  their ordering while the entry point remains within its architecture budget.

## Compatibility boundaries

- No classic UO packet layout was changed.
- Classic clients can continue to connect to this server. They receive the
  standard gameplay fallbacks and simply do not negotiate NodeUO-only UI.
- The NodeUO client can continue to connect to external UO emulators. It no
  longer second-guesses server-side ghost speech.
- Vendor, crafting, AI, death, and speech improvements are authoritative server
  behavior and do not require a NodeUO extension channel unless the enhanced
  workbench UI itself is requested.

## Verification

- Full server suite: 225 files and 1,327 tests passed in 57.51 seconds.
- Focused gameplay catalogue, vendor, crafting, skill, ghost, death, status,
  healer, banker, trainer, AI, spawner, and script-boundary tests pass.
- Lint passes.
- Isolated cold start: 386 loaded, 32 no-default modules skipped, 0 failed;
  ready in 1.07 seconds with a clean temporary world on the audit machine.
- The bounded quality audit passed all 12 categories, including a 10,000-step
  movement soak, 71 protocol differential checks, 96 protocol tests, asset
  integrity, combat/death, inventory, gumps, 74 AI/spawner tests, persistence,
  performance, maps, and a CreateWorld audit covering 81,094 decorations,
  834 signs, 1,374 teleporters, 6,788 spawners, 889 vendors, and 24,917
  references. Its machine-readable output is in
  `artifacts/nodeuo-quality-audit.json`.
- The complete 50-area audit passed 50/50. It covered the client build,
  protocol differential and compatibility suites, asset importers, combat and
  death, inventory, AI/spawners, CreateWorld, maps, persistence, client/server
  E2E, multis across restart, network chaos, load, browser compatibility,
  gameplay, admin tooling, and architecture boundaries. Machine-readable
  output is in `artifacts/nodeuo-50-audit.json`.

## Remaining audit work

These are not known blockers for startup or catalogue registration. They are
the remaining confidence/balance work that cannot honestly be called complete
from structural and targeted automated tests alone.

1. Perform a manual end-to-end playthrough of all 155 spells on both the NodeUO
   client and a stock ClassicUO client, including interruption, reflection,
   resist, criminal, party, and death transitions.
2. Run representative manual crafts from every category using normal, colored,
   exceptional, failure, worn-tool, nested-container, and full-backpack paths.
3. Compare spell, skill, loot, vendor, and craft numbers against the selected
   shard era. Several content scripts intentionally model useful behavior but
   still describe approximations rather than exact era balance.
4. Exercise multi-user vendor contention and live economy balance. Atomicity is
   tested, but pricing and restock cadence require real shard telemetry.
5. Validate the dynamic non-item merchant families (`SBAnimalTrainer`,
   `SBCarpets`, and `SBRancher`) through their specialist UI/service paths; they
   are intentionally not fixed-item `GenericBuyInfo` catalogues.
6. Expand interaction transcripts for quest NPC dialogue, escortables, pets,
   hirelings, beggars, stable masters, and named ambient NPCs.
7. Run a long-duration soak only when wanted. This pass deliberately used
   bounded tests and cold starts rather than a 12-hour run.
8. Manually inspect client animation, sound, gump layout, spellbook art, corpse
   equipment, and ghost hue across supported client versions.
9. Run complete player journeys through both quest runtimes: authored
   `activeQuests`, Mondain `mlQuests`, and the 85 data-driven multi-stage
   chains. Kill tracking and ML reward claiming are covered automatically;
   collect/deliver/escort dialogue transcripts still need live content runs.
10. Audit all eight virtue powers as world interactions. Value spending,
    cooldowns, Honor, Spirituality, resurrection targeting, and Honesty marking
    are executable; Justice protection sharing, Valor altar placement,
    Humility presentation, and the full Honesty return loop need dedicated
    parity decisions and end-to-end scenarios.
11. Exercise guilds, parties, factions, VvV, duels, arenas, ethics, stealing,
    murder counts, insurance, and loot rights with three or more simultaneous
    clients. Unit coverage exists, but adversarial cross-system ordering is a
    separate audit surface.
12. Play through champion, peerless, Doom, Shadowguard, revamped dungeon,
    seasonal-event, community-collection, and Eodon state machines, including
    save/restart during every major phase and reward delivery with full packs.
13. Audit taming, pet commands, loyalty/hunger, training, stabling, mounts,
    hirelings, escortables, summons, and ownership transfer as one lifecycle.
14. Audit harvesting and resource economies across mining, lumberjacking,
    fishing, treasure maps, plants, BODs, imbuing, reforging, cleanup points,
    auctions, player vendors, bazaar, insurance, banking, and store purchases
    under contention and restart.
15. Perform an admin-panel authorization and destructive-operation pass over
    world wipe/create/recreate, script publication, item/NPC editing, asset
    editing, rollbacks, approvals, audit logs, and concurrent editors.
16. Run fault injection for SQLite WAL recovery, disk-full/permission errors,
    interrupted saves, corrupt sidecars, listener disconnect storms, malformed
    classic packets, and malformed NodeUO extension requests.

## Recommended next improvements

1. Add a CI scenario matrix that boots a clean world, a populated world, and a
   restored world, then runs the same scripted player journey on each.
2. Build deterministic combat fuzzing with recorded RNG seeds and invariants
   such as no negative damage, no duplicate death, and no orphan status effect.
3. Add an admin audit dashboard for unresolved item types, AI fallbacks, failed
   scripts, stale effects, missing recipe tools, and vendor metadata drift.
4. Generate more runtime schemas directly from extractor definitions so parser,
   admin editor, tests, and script registries share one validation contract.
5. Add NPC transcript tests: input speech, listener state, expected dialogue,
   quest transition, and side effects in a compact fixture format.
6. Capture per-system latency histograms and allocation counters for AI,
   crafting, speech fan-out, persistence, and vendor transactions.
7. Add a replayable two-client compatibility harness covering classic client ↔
   NodeUO server and NodeUO client ↔ external emulator paths.
8. Add snapshot/fuzz tests for nested inventories and concurrent bank, trade,
   vendor, corpse-loot, and crafting transactions.
