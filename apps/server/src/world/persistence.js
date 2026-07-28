// World save/load. JSON format for compatibility + a gzip-binary mode
// for large worlds (UO_BINARY_SAVE=1 turns it on). The binary format is
// just gzip-compressed JSON — keeps the schema unchanged but cuts disk
// size 5-10× and write time proportionally for 50k+ item worlds. ServUO
// uses raw binary records; the win there is fixed-width fields and
// no parser overhead, but in V8 the GC cost of allocating thousands of
// objects on load dominates and gzip-JSON is within 2× of what binary
// would buy us at one-tenth the maintenance burden.
//
// File layout (mirrors ServUO's `Mobiles.bin / Items.bin / Accounts.bin`
// per-bucket split — keeps individual files small and lets a hot-reload
// of one bucket skip the others):
//
//   - players.json — every mobile flagged `isPlayer === true` plus the
//                    items in their parent chain (worn equipment, backpack
//                    contents, nested containers). Tiny — one row per
//                    account. Survives `[createworld` and any dev wipe.
//   - mobs.json    — NPCs / monsters / pets + items they own (worn
//                    vendor outfits, monster loot bags, etc).
//   - items.json   — ground items + unparented loot. Decay sweeper's
//                    territory: movable items here age out per
//                    `world/decay.js`.
//
// Decorations are NEVER persisted — `[createworld` re-applies them from
// the JSON catalogues on every boot.
//
// Saver writes all three atomically; loader merges them before calling
// `restoreWorld`. Backward compat: a legacy `world.json` (pre-split) is
// also read and union'd in — operators upgrading don't need to do
// anything; the next save writes the split format and renames the legacy
// file to `world.json.legacy`.
//
// BINARY mode (UO_BINARY_SAVE=1) writes `.json.gz` siblings instead of
// raw JSON. Crash recovery falls through `.gz → .json → .gz.bak → .bak`
// for each basename independently.
//
// We deliberately do NOT persist `client` references or other runtime-only
// state. On load, mobiles that previously had a client come up with
// client=null; that slot is rebound when the owning account logs back in.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { isMobileSerial, isItemSerial } from './serial.js';
import { CURRENT_SNAPSHOT_VERSION, migrateSnapshot } from './persistence-migrations.js';

const PERSISTENT_ITEM_FIELDS = Symbol.for('uo.itemPersistentFields');

// Worker-thread JSON.stringify enabled for snapshots >= this many bytes.
// Cost of structured-cloning the snap to the worker is ~30-50 % of the
// stringify cost, so the win starts above ~3 MB. Set via env to tune
// per shard.
const WORKER_SAVE_THRESHOLD = Number(process.env.UO_WORKER_SAVE_THRESHOLD ?? 3_000_000);
// Skip the worker entirely when UO_NO_SAVE_WORKER=1 — useful for tests
// that mock fs and don't want a real child thread.
const WORKER_SAVE_DISABLED = process.env.UO_NO_SAVE_WORKER === '1';

let _persistenceWorker = null;
function getPersistenceWorker() {
  if (WORKER_SAVE_DISABLED) return null;
  if (_persistenceWorker) return _persistenceWorker;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    _persistenceWorker = new Worker(path.join(here, 'persistence-worker.js'));
    _persistenceWorker.on('error', (e) => {
      console.error('[persistence-worker] crashed:', e);
      _persistenceWorker = null;
    });
    _persistenceWorker.unref();   // don't keep the event loop alive
  } catch (e) {
    console.warn('[persistence] worker_threads unavailable, falling back to inline stringify:', e.message);
    _persistenceWorker = null;
  }
  return _persistenceWorker;
}

/** RPC wrapper — sends one job to the worker and returns a Promise of
 *  the response. Multiplexes via per-call message listener. */
function workerStringify(basename, snap, useGzip) {
  const w = getPersistenceWorker();
  if (!w) return null;
  return new Promise((resolve, reject) => {
    function onMessage(msg) {
      if (msg.basename !== basename) return;       // not ours
      w.off('message', onMessage);
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg);
    }
    w.on('message', onMessage);
    try { w.postMessage({ basename, snap, useGzip }); }
    catch (e) { w.off('message', onMessage); reject(e); }
  });
}

const BINARY_SAVE = process.env.UO_BINARY_SAVE === '1';

export const SAVE_VERSION = CURRENT_SNAPSHOT_VERSION;

/**
 * Serialize the world to a plain JS object suitable for JSON.stringify.
 * @param {import('./world.js').World} world
 */
// BUGFIX #24 (FAZA BH): the previous snapshot serialized ONLY canonical
// fields (stats, skills, position). Every runtime extension that
// scripts hung off mobiles/items — `vendorKind`, `teaches`, `tameable`,
// `controlMaster`, `door`, `solid`, `_speechKeywords`, `_listensToSpeech`,
// `kind`, `profileBody`, `tithingPoints`, `skillCaps`, `skillLocks`,
// `stabled`, `activeQuests` — was lost on save/load. Server restart
// then forgot which NPCs were vendors/trainers/pets, killed all door
// state, and broke every quest in flight. The whitelist below captures
// the runtime fields we know about; future additions go in
// MOBILE_EXT_KEYS / ITEM_EXT_KEYS.

const MOBILE_EXT_KEYS = [
  'kind', 'aiBehavior', 'tameable', 'tameMinSkill', 'tameMaxSkill',
  // Spawn anchor + home leash. Without these, a save round-trip
  // erases the AI's home tile and wandering monsters either drift
  // forever (no leash) or respawn at the world origin on the next
  // tick. The aggressive-AI reattach pass also reads `homeX/Y` so
  // the restored mob keeps its original spawn rect after restart.
  'homeX', 'homeY', 'homeZ', 'homeRange', 'spawnerId',
  // XmlSpawner attachments/properties stamped on spawned mobiles.
  '_xmlAttach', '_xmlData', '_xmlSpawnerEntry',
  'controlMaster', 'team', 'invulnerable',
  // Pet survival + obedience state — bug-hunt #6 P1 #5. Without these
  // on the whitelist a starving pet round-trips back to a satiated 18/100
  // every restart and a freshly-issued [stay reverts to follow.
  'hunger', 'loyalty', 'controlOrder', 'controlTarget',
  // Server parity #11 #3 — follower-slot accounting + per-mob slot cost.
  'followers', 'followersMax', 'controlSlots', '_followerCost',
  // Heartwood reward attribute pending-slot — server parity #9 follow-up.
  '_pendingHeartwoodAttr', '_pendingHeartwoodUntil',
  // Damage Eater rate-limit (#11 BH #2) + Talisman protection slot.
  '_nextEaterAt',
  // BH #13 B3 — PvP debuff fields stamped at runtime but missing
  // from whitelist → relog cured paralyze/bleed/burn/etc., used as
  // exploit in arena PvP. Includes Anatomy/SS-scaled DoT magnitudes.
  '_paralyzedUntil', '_bleedUntil', '_bleedDmg',
  '_burnUntil', '_burnDmg', '_sufferingUntil', '_sufferingDmg',
  '_mortalStrikeUntil', '_armorIgnoreUntil', '_doubleStrikeUntil',
  // Server audit #28 P1 #3 — poison status survived in `poisoned` /
  // `poisonLevel` but the tick handler was a closure (lost in JSON).
  // We persist the expiry timestamp + source serial so `reapplyPoison
  // AfterRestore` can recreate the ticker with the remaining window.
  'poisoned', 'poisonLevel', '_poisonExpiresAt', '_poisonSourceSerial',
  '_rampageStacks', '_arcaneFocusUntil', '_arcaneFocusLevel',
  '_charmedUntil', '_charmedBy', '_lightBurnUntil', '_arcaneFocusItem',
  // Parity #14 #2 — Resurrection sickness (2-min cast/swing penalty).
  '_resSicknessUntil',
  // Virtue invocation cooldowns + transient buff state — server parity
  // #10. Without this a Compassion-rezzed player loses the 1h cooldown
  // on relog (and re-invokes immediately).
  '_virtueCooldown', '_honorEmbraceUntil', '_protegeOf', '_protegeOwner',
  '_protegeUntil', '_spiritualityUntil', '_humilityUntil',
  // Bard skill timers + stat-debuff timers — bug-hunt #6 P1 #1 / P2 #2.
  // Without these the discord penalty, peacemaking calm, provocation
  // target swap, magery stat debuffs all silently disappear on restart.
  '_bardCooldownUntil', '_discordedUntil', '_discordPenaltyPct',
  '_provokedTarget', '_provokedUntil', '_peacefulUntil',
  'strDebuffUntil', 'dexDebuffUntil', 'intDebuffUntil',
  'strDebuff', 'dexDebuff', 'intDebuff', 'statDebuffUntil',
  // Disarm window — bug-hunt #6 P2 #3.
  '_disarmedUntil',
  // ServUO BaseWeapon.ResetEquipTimer — short anti-swap window after equipping.
  '_resetEquipUntil',
  // ServUO Fists.MoveDelayTimer — unarmed special-move cooldown.
  '_moveDelayUntil',
  // ServUO P1 mobile/NPC parity — boss timers and personal-attendant state.
  '_servuoPolymorphUntil', '_servuoOriginalBody', '_servuoOriginalHue', '_servuoPolymorphBy',
  '_medusaStoneUntil',
  '_attendantOwner', '_attendantStopped', '_heraldGreeting', '_heraldGreetingClass',
  '_heraldAnnouncement', '_heraldAnnouncementClass',
  // ServUO P1 services/skills timers and transient negotiated state.
  '_spiritSpeakUntil', '_trackingInfo', '_assistantHandshakeUntil', '_assistantFeatures',
  '_sphynxFortune',
  // ServUO P1 spell parity bridge — exact-class spell contexts adapted to
  // timestamped Node state. These are visible combat/form/flight/mastery
  // effects, so save/load should not silently strip them mid-buff.
  'flying', '_gargoyleFlying',
  '_servuoLastMastery', '_servuoLastMasteryAt',
  '_specialMoveContext', '_transformContext',
  '_whiteTigerUntil', '_formBackup',
  '_toughnessUntil', '_toleranceUntil', '_manaShieldUntil',
  '_rampageUntil', '_conduitUntil', '_conduitCharges',
  '_rejuvenatedAt', '_onslaughtUntil', '_staggerUntil',
  '_focusedEyeUntil', '_heightenedUntil', '_warcryUntil',
  '_bodyGuardUntil', '_combatTrainingUntil', '_whisperingUntil',
  // Summon expire — bug-hunt #6 P2 #7. Without this a player who
  // relogs mid-summon gets a permanent Daemon.
  'summoned', 'summonedUntil',
  'vendorKind', 'teaches',
  '_listensToSpeech', '_speechKeywords',
  'profileBody', 'tithingPoints',
  'skillCaps', 'skillLocks',
  // NodeUO specialization tree. Plain JSON only, so snapshots remain
  // portable and older saves simply start with an empty allocation map.
  'specializations',
  // BUGFIX #88 (FAZA DT): statCaps was missing from the whitelist —
  // stat scrolls (`[statscroll str 25`) mutated the field but every
  // server restart silently reset it to 100/100/100, so a player's
  // 250-stat-point grind round-trip-evaporated. Same bug class as #24.
  'statCaps',
  'stabled', 'activeQuests',
  'kills', 'karma', 'criminalUntil',
  // ServUO AnkhOfSacrificeComponent: players can lock karma gains and
  // ankh resurrection has a one-hour cooldown.
  'karmaLocked', 'KarmaLocked', 'ankhNextUseAt', 'ankhNextUse',
  'ghost', 'dead',
  'partyId', '_origBody',
  // FAZA BJ: mount round-trip — `mounted` flags a hidden pet, the
  // rider's `mountedFrom`/`mountedOriginalBody` let dismount reverse.
  'mounted', 'mountedFrom', 'mountedOriginalBody', '_mountItemSerial',
  'mountAbilityCooldowns', '_mountCargoSerial', 'mountCargoCapacity',
  '_mountSprintUntil', '_mountSurefootedUntil', '_mountChargeUntil',
  // FAZA BY: faction membership — string key into FACTIONS / kill score.
  'faction', 'factionKills',
  // BUGFIX #49 (FAZA CG): pet command state. Without this, every
  // server restart blindly resets every pet to 'follow' even if its
  // master had ordered it to 'stay' / 'guard' / 'attack'.
  'petCommand',
  // BUGFIX #53 (FAZA CK): NPC honorific title (`Mira, the healer`).
  // The paperdoll header now renders `${name}, ${title}`; without
  // round-trip persistence the title silently dropped on restart and
  // every NPC became a plain first name.
  'title',
  // FAZA CX: virtue progression (UO eight virtues). Without this every
  // restart would reset compassion / valor / honor accruals to zero.
  'virtues',
  // FAZA CY: paragon flag + saved originals so the buff round-trips
  // and admin commands can un-paragon cleanly.
  'paragon', '_origName', '_origHue', '_origHpMax', '_origStr',
  '_stealableLoot', '_stealablePool',
  // FAZA DF: pet training xp + level + saved baseline for level-up
  // resolution. BUGFIX #74: without these on the whitelist, every pet
  // would silently reset to level 0 on save→load and the player's
  // training grind would evaporate.
  'petXp', 'petLevel', '_origPetHpMax', '_origPetStr',
  'petTrainingAbilities', '_petBonusDamage', '_petCaster', '_petFireBreath', '_petPoisonAttack',
  '_petTrainingBaseline',
  // FAZA DK: pet bond — survives ressurection cost via vet.
  // BUGFIX (bug-hunt 2026-05-12 A4): `tameSince` is what gates the
  // 7-day bonding promotion; without it, every restart re-stamped
  // `now` and the bonding sweep would never elapse on a shard with
  // < 7 days uptime. Persist + restore both fields.
  'bonded', 'tameSince',
  'deleteOnRelease', '_summonedFromCrystal',
  // Notoriety / fame title tracking — `_oldestKillAt` drives the
  // murder decay sweep (8 h per kill); `_lastSeason` caches the last
  // region-driven season packet so we don't re-broadcast on every
  // tick. `_insureDeathLog` is the ring buffer for insurance escalation.
  '_oldestKillAt', '_latestKillAt', '_lastSeason', '_insureDeathLog',
  // Stat-loss timer + originals (8 min penalty after res when kills≥5).
  '_statLossUntil', '_statLossOriginals',
  // Mastery passive proc state — death-strike marks, daze, lost-DCI/HCI
  // timers, archery draw, cast recovery window. Without these on the
  // whitelist a player who relogs mid-combat loses the proc state and
  // can stack debuffs from scratch (or escape one).
  '_deathStrikeMarks', '_dazedUntil', '_lostDciUntil', '_lostHciUntil',
  '_archeryDrawUntil', '_castReadyAt', '_lastPvPAt', '_lastMoveAt',
  '_lastMoveSeq',
  // BH#10 #10 — `_packSerial` was on the whitelist but it's a pure
  // cache that `backpackOf` rebuilds in <10 worn-item lookups. Serial
  // recycling on long-lived shards can let a persisted value collide
  // with a different live item whose parent happens to equal the same
  // mob serial + layer 21. Drop it.
  // Power Hour skill-gain accelerator + Bushido / Ninjitsu buff
  // timers. Short-duration but visible to player and irritating to
  // lose mid-buff to a save round-trip.
  '_powerHourUntil', '_executionUntil', '_evasionUntil',
  '_counterAttackUntil', '_lightningStrikeUntil', '_momentumStrikeUntil',
  // Audit #31 P1 #1 — bushido SPELLS write the no-underscore names
  // (combat-formulas + handlers also read them un-prefixed). The
  // underscored entries above are written by `special-moves.js` weapon
  // abilities and were independently whitelisted. Keep both sides so a
  // save/restore of either path round-trips correctly. Previously the
  // bushido buffs silently vanished on relog because their no-underscore
  // form wasn't on the list.
  'counterAttackUntil', 'lightningStrikeUntil', 'momentumStrikeUntil',
  'honorableExecUntil', 'confidenceUntil', 'confidenceRegen',
  '_focusAttackUntil', '_feintUntil',
  // FAZA DM: young-player play time + opt-out flag.
  'youngPlayedMs', 'youngOptOut',
  // FAZA GG: AFK marker (no gameplay effect, just UX).
  'afk',
  // FAZA HK: shield-equipped flag (parry-skill gate).
  '_hasShield',
  // Audit #32 P1 #2 — Thieves Guild membership. Without persisting,
  // `[joinguild thieves` would re-prompt on every relog.
  'npcGuild',
  // Audit #32 P3 #16 — transformation / chivalry / necro buff timers.
  // Without these on the whitelist a relog cures all transformations
  // mid-buff. Cluster covers the highest-traffic items; ethics + bard
  // sub-buffs are still TBD (rarely-used systems).
  'wraithFormUntil', 'lichFormUntil', 'vampireFormUntil',
  'stoneFormUntil', 'reaperFormUntil', 'animalFormUntil',
  'transformUntil',
  // Chivalry weapon buffs
  'divineFuryUntil', 'enemyOfOneUntil', 'consecrateUntil',
  // Necromancy weapon / debuff. Audit #40 P1 #2 — the canonical
  // necromancy scripts write `_mindRotUntil` (underscore) and the
  // Corpse Skin spell uses `_corpseSkinOverlayApplied` / `_corpseSkinMalus`
  // instead of `corpseSkinUntil`. The no-underscore names were dead
  // (legacy module that's no longer wired). Save the names the live
  // spells actually stamp.
  'curseWeaponUntil', '_mindRotUntil', '_corpseSkinOverlayApplied', '_corpseSkinMalus',
  'bloodOathUntil', 'evilOmenUntil',
  // Audit #40 P2 #15 — Mana Drain refund must survive server restart.
  '_manaDrainUntil', '_manaDrainAmount',
  // Eodon consumable context and short-lived bonuses.
  '_eodonPotions', '_eodonPotionContexts', '_eodonHitBonusUntil', '_eodonHpRegenBonusUntil',
  '_eodonHpRegenBonus', '_eodonPotionMods', '_eodonStamBonusUntil', '_eodonAmbushBonusUntil',
  '_nextRandomEncounterAt',
  '_eodonAmbushBonus', '_eodonManaBonusUntil', '_eodonManaTickUntil',
  '_epiphanySurgeDamage',
  '_spellFocusingOffset', '_spellFocusingTargetSerial',
  // Audit #41 P2 #31 — transient PvP / spell timers that fell off the
  // whitelist. Without these a relog mid-buff dropped the rider.
  '_painSpikeUntil', '_eooKind', '_eooScalar', '_eooUntil',
  '_essenceWindUntil', '_essenceWindFCMalus', '_essenceWindSSIMalus',
  '_surpriseAttackMalus', 'backstabUntil', 'kiAttackUntil',
  'surpriseAttackUntil', '_dualWield', '_stoneFormDmgBonus',
  '_reaperSSI', '_vampImmunePoison', 'stealthSteps',
  '_mrPhysDelta', '_raPhysDelta',     // overlay delta trackers
  // Vampiric Embrace body/hue/resist rollback plus hide/stealth
  // rate-limit timestamps.
  '_origBody', '_origHue', '_vampFireDelta', '_lastPvPAt',
  '_lastStealthAt',
  // Audit #43 — Evasion parry scalar + Confidence stam-regen reader +
  // Attune Weapon absorb pool (canonical underscore fields, not the
  // dead legacy `attuneShield` names).
  '_evasionParryScalar', '_confidenceStamRegen',
  '_attuneAbsorb', '_attuneUntil',
  // Mysticism / Spellweaving weapon buffs
  'enchantWeaponUntil', 'immolatingWeaponUntil', 'mysticWeaponUntil',
  'attuneShieldUntil',
  // Defensive Magery buffs
  'manaShieldUntil', 'reactiveArmorUntil', 'protectionUntil',
  // Audit #40 P2 #11 — Protection is now indefinite + tracks the
  // applied resist delta so onCancel can roll back the exact amount.
  '_protectionUntil', '_protectionInscribe', '_protectionPhysDelta',
  // Audit #40 P1 #1 — the actual resist deltas live on `_resistOverlay`,
  // not the `*Until` timers. Without persisting the overlay every
  // transform/shield buff (Reactive Armor, Magic Reflection, Stone
  // Form, Reaper Form, Lich Form, Corpse Skin) silently dropped its
  // resist contribution on relog while the buff icon kept ticking.
  '_resistOverlay', '_resBagDirty', '_reactiveArmor', 'magicReflection',
  // Bard debuffs (Discordance leash from #31 + provoke window)
  '_discordedUntil', '_discordPenaltyPct', '_discordSourceSerial',
  '_discordGracedUntil',
  // FAZA DY: hireling role + wage timer. BUGFIX #93: without these on
  // the whitelist, a player's hired mercenary lost their pay state on
  // restart and immediately wandered off as if unpaid.
  'hireRole', 'paidUntil',
  'escortMasterSerial', 'escortQuestId', 'escortDestination', 'escortAcceptedAt', 'escortExpiresAt',
  // Wave 13: vendor session memory + haggle coupons. Maps stored here;
  // copyExtensions auto-converts Map → plain object on save and we
  // re-wrap on load below.
  '_customerHistory', '_haggledBy',
  // Wave 14: vendor prestige + transaction ring buffer.
  // Wave 15: `_originalHue` snapshot for tier-hue revert.
  // Wave 18: `_transactionCount` cumulative counter for auto-archive,
  // `_imbueUndoQueue` + `_lastImbueSession` for cross-restart undo.
  // Wave 23: shoplog presets per player (Map) + last-run query.
  '_lifetimeBuys', '_transactionLog', '_originalHue',
  '_transactionCount', '_imbueUndoQueue', '_lastImbueSession',
  '_shoplogPresets', '_lastShoplogQuery',
  // Wave 26: GM-set custom vendor title override.
  // Wave 28: independent custom title hue (split from tier hue).
  // Wave 30: GM's recently-used hue picks (4-cap FIFO).
  '_customTitle', '_customTitleHue', '_lastVendorHues',
  // Wave 31: per-vendor favorite hue ring (4-cap, separate from GM global).
  // Wave 32: GM-frozen baseline hue (Clear reverts here when set).
  // Wave 33: GM palette presets (Map<name, number[]>).
  // Wave 35: tour echo hue persisted as a per-player default so the
  // GM doesn't have to re-set it every fresh `[showcasewalkall`.
  '_favoriteHues', '_baselineHue', '_huePalettes', '_tourEchoHueDefault',
  '_toothAcheAcidity', '_toothAcheNextAt',
  // ServUO P1 item parity: Caddellite pet infusion / Kronus call timers.
  'caddelliteInfusedUntil', '_kronusCallingUntil',
  // Player vendor/rental state. `playerVendor.items` is a Map at runtime
  // and is re-wrapped on restore below.
  'playerVendor', 'servuoClass', 'servuoClasses',
  // Player-vs-NPC marker (set by handlers.js bringIntoWorld create-path).
  // Without these the only link between an account and its avatar is the
  // raw `account.mobileSerial` integer — a spawn allocating the same
  // serial after a save round-trip would silently take over the slot
  // and the account would log in as the spawned NPC. `resolvePlayerMobile`
  // validates BOTH fields before accepting a binding.
  'isPlayer', 'accountName',
];
const ITEM_EXT_KEYS = [
  // Stable definition identity is separate from the UO art graphic. artId is
  // persisted explicitly even though itemId remains its wire-compatible alias.
  'definitionId', 'artId',
  'door', 'solid', 'locked', 'lockedDown', 'lockDifficulty', 'lockpickDifficulty', 'lockLevel',
  'requiredSkill', 'treasureLevel', 'paragonChest',
  'powerScroll', 'statScroll', 'house', 'treasureMap', 'seed',
  // Personal Bless Deed binding + scroll consumed flag + soulstone bind.
  '_personalBlessed', '_consumed', 'soulstoneAccount', 'soulstone',
  '_engravedName',                         // spellbook / weapon engraving
  // Wand / talisman / runic charges + recipe-scroll unlock key.
  'magicCharges', 'recipeUnlock', 'spellChanneling', '_isPersonalBlessDeed',
  // SO bottle / MIB lat-long.
  'mib', 'sos',
  // Vendor stock restock cooldown — bug-hunt #5 A3. The runtime
  // field set by vendor.refillStock is `_nextRestockAt`; without it
  // on the whitelist a `[save` + restart resets cooldowns, letting
  // a player wipe rare stock by restarting the shard. `treasureBonus`
  // + `_reagentBag` flags also persist now.
  '_nextRestockAt', 'treasureBonus', '_reagentBag', 'engravingTool',
  'boatNamingDeed', 'powerHour', 'tokunoArtifact', 'saArtifact',
  // Data-driven content extensions. These used to exist only on catalogue
  // rows and were silently dropped by create/save, which made otherwise
  // valid scripted items lose their payload after spawning or restarting.
  '_refreshDays', 'accessory', 'ammoBonus', 'anatomy', 'begReward',
  'bonus', 'chargeable', 'craftSkill', 'data', 'dex', 'dyeHues',
  'explosive', 'farm', 'firstSpellId', 'fishBonus', 'gameType', 'hunger',
  'imbuingMagic', 'immobile', 'int', 'lit', 'lumberjackBonus', 'magery',
  'material', 'mineBonus', 'peerless', 'pickaxeBonus', 'protectionVs',
  'questItem', 'race', 'region', 'repairSkill', 'resists', 'school',
  'shipKind', 'slayerType', 'smithBonus', 'soundId', 'special', 'str',
  'subKind', 'summon', 'trap', 'uniqueArt', 'value', 'vvvCost',
  'weightReducePct',
  // Fishing trophy — big-fish mount preserves angler + weight as deco.
  '_trophyWeight', '_fishTrophy', '_trophyAngler',
  // City Stone — granite marker tying an item to a CityLoyalty city key.
  '_loyaltyCity',
  // Corpse forensic clue — last 5 looters' names. Server parity #9 #8.
  'lootedBy',
  // Magic Trap payload + caster serial.
  '_magicTrapDmg', '_magicTrapBy',
  // BankCheck amount.
  'bankCheckAmount',
  // Crafter signature — name + serial (parity #13 #5). Serial gates
  // runic-reforging "only original crafter" check + future engraving.
  'crafter', 'crafterSerial', 'quality', '_engravedName', '_engravedBy',
  // FAZA BL: boat data + plank back-link. Wave 4: boatKey for boat
  // ownership tokens (item carries a serial pointing to the parent
  // boat; without it on the whitelist a key on a server restart loses
  // its association and the owner can't pilot anymore).
  'boat', 'boatPlank', 'boatKey', 'boatDeed',
  'cannon', '_mountSerial', '_mountDx', '_mountDy',
  // ServUO multi/house placement metadata. Dynamic multis are authored as
  // item sets, so the brand/ACL/deed payload must survive saves.
  '_multi', '_multiInstance', '_multiAnchor', '_multiHouseId', 'multiId',
  '_multiAcl', '_multiOwner', '_multiName',
  '_customHouseId',
  '_deedMulti', '_deedOffset', '_contestHouse', '_previewHouse',
  'miniHouseType', 'isRewardItem', 'rewardItem',
  'isDecoration', 'decoType', 'decoFacing', 'decoSourceKey', 'height',
  // FAZA BN: lifecycle scripting fields. `script` names a registered
  // ItemScript; `equipLayer`/`slot`/`clothing` drive paperdoll routing;
  // payload data various scripts read.
  'script', 'equipLayer', 'clothing', 'slot', 'weight', 'stackable',
  'blessed', 'newbied',
  '_xmlAttach', '_xmlData', '_xmlSpawnerEntry',
  'spellSlug', 'linkSerial', 'owner', 'addonName', 'addonNames',
  'training', 'craftingStation', 'addonCraftSystem', 'addonToolTurnedOn',
  'toolUsesRemaining', 'toolMaxUses', '_spinningWheelBaseItemId',
  '_spinningWheelSpinningUntil', 'light', 'labelNumber',
  '_logs', '_nextResourceCount', 'waterSourceQuantity',
  // Readable book payloads generated from ServUO BaseBook/Note classes.
  'tagId', 'kind', 'category', 'resource', 'title', 'author', 'pages', 'writable',
  'readOnly', 'bookContentClilocs', 'bookPageDetails', 'noteString', 'servuoClass', 'servuoClasses', 'servuoPath',
  'bandageHealingBonus',
  'firstAidBelt', 'firstAidMaxBandages', 'firstAidHealingBonus', 'firstAidWeightReduction',
  // Potion/beverage payloads generated from ServUO consumables.
  'poison', 'poisonLevel', 'poisonKind', 'poisonCharges', 'minPoisoningSkill',
  'cureTier', 'cureLevelInfo',
  'damage', 'aoeDamage', 'aoeRadius', 'damageType', 'throwRange',
  'statusEffect', 'statusDurationMs',
  'eodonEffect', 'eodonDurationMs',
  'content', 'quantity', 'maxQuantity', 'linked', 'linkLocation', 'linkMap',
  'attributes', 'resist', '_magicProps', '_magicResists', '_artifact',
  'setId', 'setPieces', 'setAttributes', 'setResist', 'setSelfRepair',
  'spellFocusing', 'spellCastTargetSerial', 'spellCastCount', 'spellId',
  'container', 'capacity', 'maxWeight', 'lootTable', 'autoFillLoot', 'cleanupAddonType',
  'contentType', 'fillableType', 'fillableContentType', 'fillableMaxSpawnCount',
  'fillableSpawnThreshold', 'fillableNextRespawnAt', 'fillableNextCheckAt', 'fillableTotalTraps',
  'treasureMinSpawnMinutes', 'treasureMaxSpawnMinutes', 'treasureResetAt',
  'treasureDeleteAt', 'treasureChestMod',
  'wandSpell', 'wandIdentify', 'defaultCharges',
  'charges', 'maxCharges', 'usesRemaining', 'toolKind', 'craftSystem', 'tool',
  'runicMaterial', 'runicBudget', '_runicTool', 'replica', 'hitchingPostCost',
  'armorAttributes', 'mageArmor', 'epiphanyAlignment', 'epiphanyType',
  'crystalKind', 'crystalActive', 'crystalCharges', 'crystalReceivers', 'crystalSender', 'crystalRechargeInfo',
  'salvageMode', 'mahjong', 'deck',
  'flipId', 'flipIds', 'secureLevel', 'sendingNextRechargeAt',
  'boundBraceletSerial', 'recharges', 'maxRecharges', 'inscription', 'transportPendingUntil',
  'staffOrbOwnerSerial', 'staffOrbHome', 'staffOrbStaffLevel', 'staffOrbAutoRes',
  'moonstoneType', 'moonstoneSettling', 'moonstoneGate', 'gateOwnerSerial', 'gateExpiresAt',
  'rentalDurationId', 'rentalPrice', 'rentalLandlordRenew', 'rentalOffereeSerial',
  'rentalOfferExpiresAt', 'rentalLandlordSerial', 'rentalHouseSerial',
  'aquarium', 'aquariumFish', 'fishKind', 'breed', 'servuoBaseClass', 'aquariumDecoration',
  'ballot', 'playerBB', 'ownerSerial',
  'imprisonedSummon', 'imprisonedServuoClass', 'summonKind', 'monsterStatuetteType',
  'emptyAt',
  'givesToothAche', 'toothAcheAcidity', 'gingerBreadMessages', 'holidaySweet',
  'accessLevel', 'minorArtifact', 'artifactRarity', 'displayWeight',
  'visible', '_stewHiddenUntil', '_nextSolenSpawnAt',
  'fountainCharges', 'fountainMaxCharges', 'fountainNextRechargeAt',
  'graniteRewardCount', 'graniteNextUseAt', 'graniteSecureLevel',
  'flamingHeadType', '_flamingHeadBaseItemId', '_flamingHeadBreathingUntil',
  'pickpocketMinSkill', 'pickpocketMaxSkill', '_pickpocketBaseItemId', '_pickpocketSwingUntil',
  'dolphinRugType', 'dolphinRugState', 'dolphinResourceCount', 'dolphinNextResourceAt',
  'addonResourceKind', 'addonResourceState', 'addonResourceCount', 'addonResourceMax',
  'addonResourceRechargeAmount', 'addonNextResourceAt', 'addonResourceLabelNumber',
  'miningCartType', 'miningCartState', 'miningCartOre', 'miningCartGems', 'miningCartNextResourceAt',
  'sheepResourceCount', 'sheepNextResourceAt',
  'harpsichordSongs', 'harpsichordState', 'harpsichordDirection', 'harpsichordRollMusic',
  'archeryButteMinSkill', 'archeryButteMaxSkill', 'archeryButteArrows', 'archeryButteBolts',
  'archeryButteLastUseAt', 'archeryButteEntries', 'archeryButteFacing',
  'portraitFacing', '_portraitFacing', '_portraitNextUpdateAt',
  'bedOfNailsFacing', '_bedOfNailsFacing', '_bedOfNailsTrail',
  'musicId', 'musicTracks', 'musicDurationMs',
  '_musicTracks', '_musicActualSong', '_musicPlayingUntil', '_musicOriginalItemId', '_musicNextAnimAt',
  // FAZA BU — bulk order deed payload.
  'bod',
  // BUGFIX #38 (FAZA BV): corpse decay timestamp. Without this, every
  // corpse loaded from a save loses its spawnedAt and `sweepDecayedCorpses`
  // resets the timer to NOW, so a corpse 4m59s into its 5m decay window
  // survives the restart with a full 5 more minutes of lifetime. Players
  // exploited this by stop/starting the shard between dungeon runs.
  'spawnedAt',
  // BUGFIX #48 (FAZA CF): torch / lantern lit-state + captured original
  // unlit graphic. Without these the lifecycle script forgets which art
  // id to revert to on snuff after a restart.
  '_lit', '_unlitId', '_burnRemainingMs',
  // XmlSpawner simple switch / tile-trap target wiring.
  '_xmlLeverState', '_xmlLeverType', '_xmlStates', '_xmlTrapInside',
  'leverType', 'leverSound', 'switchSound',
  'targetProperty', 'target0Property', 'target1Property', 'target2Property',
  '_target0Property', '_target1Property', '_target2Property',
  '_xmlTarget0Property', '_xmlTarget1Property', '_xmlTarget2Property',
  'target0Serial', 'target1Serial', 'target2Serial',
  '_target0Serial', '_target1Serial', '_target2Serial',
  '_xmlTarget0Serial', '_xmlTarget1Serial', '_xmlTarget2Serial',
  // FAZA CZ: teleporter destination. Without this dungeon entrances /
  // moongates lose their wiring on restart and become inert tiles.
  'teleportTo', 'creatures', 'message',
  // FAZA DD: peerless altar's bound arena name.
  'arenaName',
  // FAZA DU: recall rune destination.
  'runeDest',
  // FAZA EA: per-item durability + max. BUGFIX #95: durability state
  // would round-trip-evaporate without these on the item whitelist.
  'durability', 'durabilityMax',
  // FAZA EC: tinker trap state. BUGFIX #97: a player who armed a trap
  // and stepped on it would have it un-spring on every server restart
  // (since `_sprung` was a runtime field), explode again, and respawn
  // damage on every restart cycle. Worse, `trapDamage` would zero out
  // and the trap would silently become a decoration. Whitelist both.
  'trapDamage', '_sprung',
  // FAZA EJ: insurance flag + paying-mob serial.
  'insured', 'insuredBy',
  // Wave 7 follow-up: random magic-item & artifact properties produced
  // by the loot generator. Without these on the whitelist, every
  // restart silently strips a player's +5 STR sword down to a plain
  // sword (the props were a runtime-only field).
  // Wave 12: `_unidentified` so an item bought-but-not-IDed survives a
  // restart still hidden — otherwise restart would silently reveal
  // every magic item in every player's pack.
  // Wave 20: `_imbueBudget` per-item override (loot tables can stamp
  // a custom budget on boss drops; absence falls back to default 500).
  '_magicProps', '_artifact', '_magicResists', '_unidentified', '_imbueBudget',
  // Wave 27: lock flag — survives restart so a GM-locked artifact
  // can't be reset by simply waiting out the server.
  // Wave 29: lock audit (who/when).
  '_imbueLocked', '_imbueLockedBy', '_imbueLockedAt',
  // Wave 14: showcase display state. `_displayed` flags the pinned
  // item; `display:{itemSerial}` lives on the case mob. Without these
  // a server restart frees pinned artifacts and the museum empties.
  '_displayed', 'display',
  // FAZA ES: newbied flag (LootType.Blessed parity).
  'newbied',
  // FAZA EV: soulstone {skillId, value}.
  'soulstone',
  // FAZA EW: slayer tag on weapons.
  'slayer',
  // FAZA FM: per-weapon combat descriptor {range, ammoId, swingMs}.
  'weapon',
  // FAZA HK: shield flag (true → equipped to layer 2 sets _hasShield).
  'shield',
  'ar', 'strReq', 'twoHanded', 'skill', 'minDamage', 'maxDamage', 'speed', 'range', 'ammoId',
  // FAZA HP: bard instrument quality (0=Low, 1=Regular, 2=Exceptional).
  'instrumentQuality',
  // SA armor refinement {resist, amount, paired} — survives restart so
  // a refined armor piece keeps its resist deltas without re-applying.
  '_refinement',
  // FAZA FX: enchanted tool yield bonus flags.
  'pickaxeBonus', 'lumberjackBonus',
  // FAZA EE+: AOE damage state, locked-container key serial.
  'lockKeySerial', 'magicCharges', 'maxCharges', 'magicSpell', 'magicEnchanted',
  'wandSpell', 'wandIdentify', 'defaultCharges',
  // FAZA EM: container trap payload {damage, level}.
  'trapped', 'trapPower',
  // FAZA FG: treasure-chest loot-once flag + level aliases used by
  // authored scripts and system-spawned treasure-map chests.
  'treasureLooted', 'treasureChestLevel',
  // FAZA EN: forensic clues on corpses.
  'killerName', 'lootedBy',
  // FAZA EX: dye tub colour memory.
  'dyeTubHue',
  // FAZA FA: vendor restock timer.
  'lastRestock',
  // Power scroll payload (skillId, amount). Already implicitly covered
  // by 'powerScroll' which we declared earlier — keep the comment so
  // future maintainers know FAZA DT relies on it.
  // Decay timer (epoch ms) for movable ground items. Set by `world/decay.js`
  // first time the sweeper sees an item; without persistence the timer
  // would reset on every restart, making expensive items effectively
  // immortal as long as the operator restarted the shard often enough.
  // `_noDecay` opts an item out entirely (used by quest items, GM marks,
  // anything that shouldn't disappear unattended).
  'decayAt', '_noDecay',
  'sourceKind', 'sourceBody', 'sourceWasPlayer', 'carveYields', 'carvedAt',
  // Spellbook marker — set by `handleUseReq` the first time a spellbook
  // graphic gets opened. The hand-mutex (`handleWearItem`) reads it to
  // allow staff (2H weapon) + spellbook (1H slot) to coexist, which is
  // the canonical mage layout. Without persistence the flag would reset
  // every restart and the next 2H weapon equip would silently pop the
  // book back into the backpack.
  'spellbook',
  // ServUO P1 item parity: sockets/timers/quest payloads ported from
  // Caddellite, SpikedEggNog, Obsidian, SecretWall, PetWhistle, etc.
  'nextUseTime', 'itemSockets', 'caddellite', 'caddelliteInfused', 'caddelliteTool',
  'canFortify', 'antique', 'negativeAttributes',
  'obsidianQuantity', 'obsidianStatueName',
  'secretWallLocked', 'secretWallActive', 'secretWallDest', 'secretWallSerial',
  'secretSwitchOn', 'secretSwitchBaseId', 'secretSwitchReturnId',
  'maabusFullItemId', 'maabusEmptyItemId', 'maabusSpawnLocation', 'maabusMobileSerial',
  'petWhistlePetSerial', 'petWhistlePetName', 'petWhistleAccount', 'petWhistleNextLinkAt',
  'secretKey', 'secretChestAccess', 'secretChestTrials', 'secretChestExpiresAt',
  'ethereal', 'etherealMountSerial', 'mountKind', 'mount', 'staffOnly',
  'freeAfterMs', 'forceShowProperties',
  // ServUO P1 service item payloads.
  'args', 'displayName', 'anniversaryChoice', '_timepiece', '_dailyRare', '_ancientWall',
  '_sphynxFortune',
];

function copyExtensions(source, keys) {
  const out = {};
  for (const k of keys) {
    const v = source[k];
    if (v === undefined) continue;
    // Door payload contains a setTimeout handle (`_closeTimer`); strip
    // non-serialisable fields. Sets / Maps get materialised to plain
    // arrays so JSON.stringify produces useful output.
    if (k === 'door' && v && typeof v === 'object') {
      // Keep every durable BaseDoor field, but deliberately omit the live
      // timeout handle. Previously an open door lost closedX/closedY during
      // save, so its first close after reboot treated the shifted open tile
      // as the origin. Locks, portcullis semantics and paired-door links were
      // lost for the same reason.
      out.door = {
        closedId: v.closedId,
        openId: v.openId,
        isOpen: !!v.isOpen,
        facing: v.facing ?? null,
        closedX: v.closedX,
        closedY: v.closedY,
        closedZ: v.closedZ,
        linkSerial: v.linkSerial,
        secret: !!v.secret,
        revealed: !!v.revealed,
        portcullis: !!v.portcullis,
        keyId: v.keyId | 0,
        locked: !!v.locked,
      };
    } else if (k === 'boat' && v && typeof v === 'object') {
      // Wave 4: boat.riders is a Set; JSON.stringify on a Set produces
      // {} (Set isn't enumerable as plain props), losing every passenger
      // on save. Materialise riders to an array. Restore-side
      // (restoreWorld) re-wraps in a Set to keep .add()/.has() callers
      // working unchanged.
      out.boat = {
        facing: v.facing, planks: Array.isArray(v.planks) ? [...v.planks] : [],
        riders: v.riders instanceof Set ? [...v.riders] : (Array.isArray(v.riders) ? v.riders : []),
        sailState: v.sailState ?? 'stop',
        anchored: !!v.anchored, wrecked: !!v.wrecked,
        ownerSerial: v.ownerSerial >>> 0 || undefined,
        keys: Array.isArray(v.keys) ? [...v.keys] : [],
        boatHp: v.boatHp, boatHpMax: v.boatHpMax,
        armor: v.armor,
        speedMultiplier: v.speedMultiplier,
        sailsDisabledUntil: v.sailsDisabledUntil,
        lastDamage: v.lastDamage,
        nextSailAt: v.nextSailAt,
        name: v.name,
        hullKind: v.hullKind ?? v.hull,
        cannons: Array.isArray(v.cannons) ? [...v.cannons] : [],
        tillermanSerial: v.tillermanSerial,
        course: v.course ? {
          waypoints: Array.isArray(v.course.waypoints)
            ? v.course.waypoints.map((p) => ({ x: p.x | 0, y: p.y | 0, map: p.map ?? undefined }))
            : [],
          index: v.course.index | 0,
          running: !!v.course.running,
          loop: !!v.course.loop,
          speed: v.course.speed ?? 'medium',
          lastX: v.course.lastX,
          lastY: v.course.lastY,
          lastProgressAt: v.course.lastProgressAt,
        } : undefined,
      };
    } else if (k === 'playerVendor' && v && typeof v === 'object') {
      out.playerVendor = {
        ...v,
        items: v.items instanceof Map
          ? Object.fromEntries(v.items)
          : (v.items && typeof v.items === 'object' ? v.items : {}),
        allowedBuyers: v.allowedBuyers instanceof Set
          ? [...v.allowedBuyers]
          : (Array.isArray(v.allowedBuyers) ? v.allowedBuyers : []),
      };
    } else if (v instanceof Set) {
      out[k] = [...v];
    } else if (v instanceof Map) {
      out[k] = Object.fromEntries(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function serializeMobile(m) {
  return {
    serial: m.serial, name: m.name, body: m.body, hue: m.hue,
    x: m.x, y: m.y, z: m.z, direction: m.direction, map: m.map,
    flags: m.flags, notoriety: m.notoriety,
    hp: m.hp, hpMax: m.hpMax,
    mana: m.mana, manaMax: m.manaMax,
    stam: m.stam, stamMax: m.stamMax,
    str: m.str, dex: m.dex, int: m.int,
    gold: m.gold, sex: m.sex,
    skills: m.skills,
    ...copyExtensions(m, MOBILE_EXT_KEYS),
  };
}

function serializeItem(it) {
  const dynamicFields = it[PERSISTENT_ITEM_FIELDS] instanceof Set
    ? [...it[PERSISTENT_ITEM_FIELDS]]
    : [];
  const extensions = copyExtensions(it, [...ITEM_EXT_KEYS, ...dynamicFields]);
  if (dynamicFields.length) extensions._persistentFields = dynamicFields;
  // Every component of a placed house shares the exact same ACL object at
  // runtime. Persisting that object on hundreds of collision proxies bloats
  // items.json and makes every save/restore do needless JSON work. Canonical
  // multis have a durable anchor, so store the ACL once there and reconnect
  // all parts to it after restore. Legacy multis without an instance id keep
  // their previous per-item representation for backward compatibility.
  if (it._multiInstance != null && it._multiAnchor !== true) {
    delete extensions._multiAcl;
  }
  return {
    serial: it.serial, itemId: it.itemId, hue: it.hue, amount: it.amount,
    x: it.x, y: it.y, z: it.z, map: it.map,
    name: it.name, movable: it.movable,
    parent: it.parent ?? null,
    gumpId: it.gumpId ?? 0,
    gridX: it.gridX ?? 0,
    gridY: it.gridY ?? 0,
    gridLocation: it.gridLocation ?? 0,
    layer: it.layer ?? 0,
    template: it.template,
    ...extensions,
  };
}

function serializeWorldMeta(world) {
  return {
    createWorldDone: !!world._createWorldDone,
    createWorldVersion: Math.max(0, world._createWorldVersion | 0),
    saveGeneration: Math.max(0, world._saveGeneration | 0),
    xmlSpawnersApplied: [...(world._xmlSpawnersApplied ?? [])],
    treasureChestsApplied: [...(world._treasureChestsApplied ?? [])],
  };
}

export function snapshotWorld(world) {
  /** @type {any[]} */
  const mobiles = [];
  for (const m of world.mobiles.values()) mobiles.push(serializeMobile(m));
  /** @type {any[]} */
  const items = [];
  for (const it of world.items.values()) {
    // Decorations placed by [createworld are deterministic and re-applied
    // on every server boot from the JSON catalog. Skipping them keeps the
    // save file small (~6.9 MB of decoration JSON would otherwise round-
    // trip through every save) and avoids stale duplicates after content
    // edits.
    if (it.isDecoration) continue;
    items.push(serializeItem(it));
  }
  return {
    version: SAVE_VERSION,
    mobiles,
    items,
    serials: {
      nextMobile: world.serial.nextMobile,
      nextItem:   world.serial.nextItem,
    },
    worldMeta: serializeWorldMeta(world),
  };
}

/**
 * Three-way partition for save splitting.
 *
 *   - `playerSerials`  every mobile flagged `isPlayer`.
 *   - `npcSerials`     every other mobile (NPCs, spawned monsters, pets).
 *   - `playerOwned`    items whose parent chain ends at a player mobile
 *                      (worn equipment, backpack contents, nested bags).
 *   - `npcOwned`       items whose parent chain ends at an NPC mobile
 *                      (worn vendor outfits, monster loot bags, etc).
 *
 * The remaining items (parent == null OR parent dangles) are "ground
 * items" — they go to `items.json` where the decay sweeper can age them
 * out.
 *
 * Fixed-point pass (≤ 8 iterations) handles deep ownership chains:
 * mobile → backpack → bag of holding → loose gold pile is 4 levels.
 */
function partitionWorld(world) {
  const playerSerials = new Set();
  const npcSerials = new Set();
  for (const m of world.mobiles.values()) {
    if (m.isPlayer) playerSerials.add(m.serial);
    else npcSerials.add(m.serial);
  }
  // Bug-hunt #7 B6: bonded pets (controlMaster ∈ playerSerials, no
  // isPlayer flag) belong with their master in players.json. Without
  // this fix-point, mobs.json carries the pet + equipment chain — if
  // mobs.json is lost / hot-reloaded the player loses all bonded pets
  // even though players.json restored them with a dangling
  // controlMaster pointer. Iterate to a fixed-point so a pet's pet (a
  // summon owned by a tamed pet) follows the same root.
  for (let round = 0; round < 4; round++) {
    let added = 0;
    for (const m of world.mobiles.values()) {
      if (m.isPlayer) continue;
      if (!m.controlMaster) continue;
      if (playerSerials.has(m.controlMaster) && !playerSerials.has(m.serial)) {
        playerSerials.add(m.serial);
        npcSerials.delete(m.serial);
        added++;
      }
    }
    if (added === 0) break;
  }
  // Build a parent → children reverse index in ONE pass, then BFS down
  // each ownership root. The previous implementation re-walked
  // world.items up to 8× per save (until convergence) which on a
  // 110k-item shard burned ~880k iterations every time `requestSave`
  // fired — long enough to block the event loop for 200-500 ms and
  // appear as a freeze on a TP that happened to coincide with an
  // auto-save.
  /** @type {Map<number, number[]>} parentSerial → child serials */
  const childrenByParent = new Map();
  for (const it of world.items.values()) {
    const p = it.parent;
    if (p == null) continue;
    let list = childrenByParent.get(p);
    if (!list) { list = []; childrenByParent.set(p, list); }
    list.push(it.serial);
  }
  const playerOwned = new Set();
  const npcOwned = new Set();
  // BFS rooted at each player / NPC mobile — every child item carries
  // the same ownership tag as its (transitive) root mobile.
  const collect = (roots, dest) => {
    const stack = [...roots];
    while (stack.length) {
      const cur = stack.pop();
      const kids = childrenByParent.get(cur);
      if (!kids) continue;
      for (const childSerial of kids) {
        if (dest.has(childSerial)) continue;
        dest.add(childSerial);
        stack.push(childSerial);  // descend into nested containers
      }
    }
  };
  collect(playerSerials, playerOwned);
  collect(npcSerials, npcOwned);
  return { playerSerials, npcSerials, playerOwned, npcOwned };
}

/**
 * Build THREE snapshots:
 *   - `players` — player avatars + their owned inventory chain.
 *   - `mobs`    — NPCs / monsters / pets + their worn / carried items.
 *   - `items`   — everything else (ground items, unparented loot).
 *
 * Each snapshot is a self-contained mobiles+items pair plus a copy of
 * the global `nextMobile / nextItem` counters so the loader can pin
 * `serial.observe` correctly from whichever file loaded last.
 *
 * Why three files? ServUO's reference engine ships separate
 * `Mobiles.bin` + `Items.bin` for the same reason — `world.json` was
 * becoming the single fat file that grows linearly with NPC + item
 * count. With the split:
 *   - players.json stays tiny (one row per account)
 *   - mobs.json scales with NPC count
 *   - items.json scales with ground-item count, the bucket the decay
 *     sweeper cares about. Loading just one file (e.g. for a hot-reload
 *     of NPC table) is cheap.
 */
export function splitSnapshot(world) {
  const { playerSerials, npcSerials, playerOwned, npcOwned } = partitionWorld(world);
  const players = { mobiles: [], items: [] };
  const mobs    = { mobiles: [], items: [] };
  const items   = { mobiles: [], items: [] };
  for (const m of world.mobiles.values()) {
    if (playerSerials.has(m.serial)) players.mobiles.push(serializeMobile(m));
    else if (npcSerials.has(m.serial)) mobs.mobiles.push(serializeMobile(m));
  }
  for (const it of world.items.values()) {
    // Decorations (doors / signs / teleporters / static lanterns spawned
    // by `[createworld`, `[decorate`, `[doorgen` etc.) USED to be skipped
    // here on the assumption that `[createworld` would be re-run after
    // every reboot. User report 2026-05-18: items vanished from the map
    // after every server restart and `[createworld` refused to re-run
    // (the guard saw the persisted `_createWorldDone` flag). Persist
    // them with the rest of `items.json`; the bytes are large (~45 MB
    // raw, ~10 MB gzipped on a fully-decorated shard) but predictable.
    if (playerOwned.has(it.serial)) players.items.push(serializeItem(it));
    else if (npcOwned.has(it.serial)) mobs.items.push(serializeItem(it));
    else items.items.push(serializeItem(it));
  }
  const serials = {
    nextMobile: world.serial.nextMobile,
    nextItem:   world.serial.nextItem,
  };
  // Round-trip a tiny world-meta block so admin guards (`[createworld`
  // refusal once-applied, etc.) survive a reboot. Lives on the
  // `items` slice since that's the one always present.
  const generation = Math.max(1, (world._saveGeneration | 0) + 1);
  world._saveGeneration = generation;
  const worldMeta = serializeWorldMeta(world);
  const wrap = (s, withMeta = false) => ({
    version: SAVE_VERSION, generation, mobiles: s.mobiles, items: s.items, serials,
    ...(withMeta ? { worldMeta } : {}),
  });
  return {
    players: wrap(players),
    mobs:    wrap(mobs),
    items:   wrap(items, /* withMeta */ true),
  };
}

/**
 * Restore world contents in place from a snapshot. Clears current state first.
 * @param {import('./world.js').World} world
 * @param {any} snap
 */
export function restoreWorld(world, snap) {
  if (!snap || typeof snap !== 'object') throw new Error('invalid snapshot');
  if (snap.version !== SAVE_VERSION) {
    const migrated = migrateSnapshot(snap);
    if (!migrated.plan.ok || migrated.snapshot?.version !== SAVE_VERSION) {
      throw new Error(`unsupported save version ${snap.version}, expected ${SAVE_VERSION}`);
    }
    snap = migrated.snapshot;
  }
  // Drop anyone mid-session; callers should only restore at startup.
  world.mobiles.clear();
  world.items.clear();
  // Bug-hunt #10 #7 — also clear the reverse parent index. Tests run
  // `restoreWorld` multiple times against the same world; without this
  // the second restore leaves stale parent → children Sets and every
  // subsequent `containerChildren`/`backpackOf` lookup returns phantoms.
  world._childrenByParent?.clear?.();
  // Same for the lazy index sets — they'll lazy-rebuild on first need.
  world._pets?.clear?.();
  world._combatMobiles?.clear?.();
  world._tickingMobiles?.clear?.();
  world._boats?.clear?.();
  world._boatIndexReady = false;
  world._tickingItems?.clear?.();
  world._bosses?.clear?.();
  world._peerlessBosses?.clear?.();
  world._mobsWithEffects?.clear?.();
  world._xmlAttachmentEntities?.clear?.();
  world._xmlAttachmentIndexReady = false;
  world._plants?.clear?.();
  world._onlineMobiles?.clear?.();
  world._corpses?.clear?.();
  world._summons?.clear?.();
  world._xmlSpawnersApplied?.clear?.();
  world._treasureChestsApplied?.clear?.();
  world._corpseIndexReady = false;
  world._summonIndexReady = false;

  let droppedMobiles = 0;
  let droppedItems = 0;
  const liveMobileSerials = new Set();
  const liveItemSerials = new Set();

  for (const m of snap.mobiles ?? []) {
    if (typeof m?.serial !== 'number' || !isMobileSerial(m.serial)) {
      droppedMobiles++;
      console.warn(`[persistence] dropping mobile with invalid serial: ${m?.serial}`);
      continue;
    }
    if (world.mobiles.has(m.serial)) {
      droppedMobiles++;
      console.warn(`[persistence] dropping duplicate mobile serial: 0x${m.serial.toString(16)}`);
      continue;
    }
    const restoredMob = { ...m, client: null };
    Object.defineProperty(restoredMob, '_world', {
      value: world, writable: true, configurable: true, enumerable: false,
    });
    // Wave 13: re-wrap vendor Maps that copyExtensions flattened to
    // plain objects on save. Without this, `_customerHistory.get` and
    // `_haggledBy.get` on a vendor that survived a save→load throw
    // "is not a function" the next time someone haggles.
    if (restoredMob._customerHistory && !(restoredMob._customerHistory instanceof Map)) {
      restoredMob._customerHistory = new Map(
        Object.entries(restoredMob._customerHistory).map(([k, v]) => [+k, v]),
      );
    }
    if (restoredMob._haggledBy && !(restoredMob._haggledBy instanceof Map)) {
      restoredMob._haggledBy = new Map(
        Object.entries(restoredMob._haggledBy).map(([k, v]) => [+k, v]),
      );
    }
    // Wave 23: shoplog presets re-wrap (Map<string name, string[] tokens>).
    if (restoredMob._shoplogPresets && !(restoredMob._shoplogPresets instanceof Map)) {
      restoredMob._shoplogPresets = new Map(Object.entries(restoredMob._shoplogPresets));
    }
    // Wave 33: GM hue palettes (Map<string name, number[]>).
    if (restoredMob._huePalettes && !(restoredMob._huePalettes instanceof Map)) {
      restoredMob._huePalettes = new Map(Object.entries(restoredMob._huePalettes));
    }
    if (restoredMob.playerVendor) {
      const pv = restoredMob.playerVendor;
      if (!(pv.items instanceof Map)) {
        pv.items = new Map(Object.entries(pv.items ?? {}).map(([k, v]) => [+k, v]));
      }
      if (!(pv.allowedBuyers instanceof Set)) pv.allowedBuyers = new Set(pv.allowedBuyers ?? []);
      pv.bankBalance = pv.bankBalance | 0;
      pv.rentalGold = pv.rentalGold | 0;
    }
    world.mobiles.set(m.serial, restoredMob);
    world.sectors?.addMobile(restoredMob);
    liveMobileSerials.add(m.serial);
    world.serial.observe(m.serial);
    // Re-populate the reverse `world._pets` index for any restored
    // tamed pet (NPC body with a controlMaster, no client, alive).
    // Without this the bonding sweep / hunger sweep / pet-guard AI
    // sectors fan-out walk an empty Set on the first hour after every
    // restart — bonded promotions skipped, starvation paused.
    if (restoredMob.controlMaster && !restoredMob.client && !restoredMob.ghost) {
      world._pets?.add?.(restoredMob.serial);
    }
    if ((restoredMob._combatUntil ?? 0) > Date.now()) {
      world._combatMobiles?.add?.(restoredMob.serial);
    }
    if (Array.isArray(restoredMob.effects) && restoredMob.effects.length > 0) {
      world._mobsWithEffects?.add?.(restoredMob.serial);
    }
  }
  for (const it of snap.items ?? []) {
    if (typeof it?.serial !== 'number' || !isItemSerial(it.serial)) {
      droppedItems++;
      console.warn(`[persistence] dropping item with invalid serial: ${it?.serial}`);
      continue;
    }
    if (typeof it.itemId !== 'number' || it.itemId < 0 || it.itemId > 0xFFFF) {
      droppedItems++;
      console.warn(`[persistence] dropping item 0x${it.serial.toString(16)} with bad itemId ${it.itemId}`);
      continue;
    }
    if (world.items.has(it.serial)) {
      droppedItems++;
      console.warn(`[persistence] dropping duplicate item serial: 0x${it.serial.toString(16)}`);
      continue;
    }
    const restored = { ...it };
    const persistentFields = Array.isArray(restored._persistentFields)
      ? restored._persistentFields.filter((key) => typeof key === 'string')
      : [];
    delete restored._persistentFields;
    Object.defineProperty(restored, '_world', {
      value: world, writable: true, configurable: true, enumerable: false,
    });
    if (persistentFields.length) {
      Object.defineProperty(restored, PERSISTENT_ITEM_FIELDS, {
        value: new Set(persistentFields), writable: true, configurable: true, enumerable: false,
      });
    }
    // Wave 4: re-wrap boat.riders array → Set so existing .add()/.has()
    // callers in scripts/commands/boat.js keep working unchanged.
    if (restored.boat && Array.isArray(restored.boat.riders)) {
      restored.boat = { ...restored.boat, riders: new Set(restored.boat.riders) };
    }
    world.items.set(it.serial, restored);
    world.sectors?.addItem(restored);
    // Populate the parent → children reverse index that createItem
    // normally maintains. restoreWorld bypasses createItem (which would
    // re-allocate serials) so we mirror the index update here. Without
    // this, post-restore hot-paths (insurance / bank cap / archery)
    // would silently fall back to the 110k full walk every time.
    if (restored.parent != null) {
      world._childrenByParent ||= new Map();
      let set = world._childrenByParent.get(restored.parent);
      if (!set) { set = new Set(); world._childrenByParent.set(restored.parent, set); }
      set.add(restored.serial);
    }
    liveItemSerials.add(it.serial);
    world.serial.observe(it.serial);
  }

  // Canonical multis persist their shared ACL once on the anchor. Restore the
  // in-memory invariant expected by housing commands: every part belonging to
  // an instance points at the same ACL object (not merely equal JSON copies).
  const multiAclByInstance = new Map();
  for (const it of world.items.values()) {
    if (it._multiInstance == null || it._multiAcl == null) continue;
    const instanceId = it._multiInstance >>> 0;
    if (it._multiAnchor === true || !multiAclByInstance.has(instanceId)) {
      multiAclByInstance.set(instanceId, it._multiAcl);
    }
  }
  for (const it of world.items.values()) {
    if (it._multiInstance == null) continue;
    const acl = multiAclByInstance.get(it._multiInstance >>> 0);
    if (acl != null) it._multiAcl = acl;
  }

  // Referential-integrity sweep: an item whose parent no longer exists is
  // orphaned. Rather than silently losing it (which used to cause items to
  // vanish on reload whenever a worn parent was purged), drop it to the
  // ground so the player at least has a chance of recovering it.
  let orphanedItems = 0;
  for (const it of world.items.values()) {
    if (it.parent == null) continue;
    const parentIsMobile = liveMobileSerials.has(it.parent);
    const parentIsItem = liveItemSerials.has(it.parent);
    if (!parentIsMobile && !parentIsItem) {
      orphanedItems++;
      console.warn(`[persistence] orphan item 0x${it.serial.toString(16)} parent=0x${(it.parent >>> 0).toString(16)} → ground`);
      it.parent = null;
      it.layer = 0;
      delete it.gridX; delete it.gridY; delete it.gridLocation;
    }
  }

  if (droppedMobiles || droppedItems || orphanedItems) {
    console.warn(`[persistence] load summary: droppedMobiles=${droppedMobiles} droppedItems=${droppedItems} orphanedItems=${orphanedItems}`);
  }

  // Prefer explicit counters when the save provides them; observe() above
  // keeps things consistent even for sparse saves.
  if (snap.serials) {
    if (snap.serials.nextMobile > world.serial.nextMobile) world.serial.nextMobile = snap.serials.nextMobile;
    if (snap.serials.nextItem   > world.serial.nextItem)   world.serial.nextItem   = snap.serials.nextItem;
  }
  // World-meta block — restores admin guard flags (`[createworld`
  // refusal once-applied, etc.). Only present on the `items.json`
  // slice; mobs.json and players.json carry the same wrap but with
  // `worldMeta: undefined` so this branch is a no-op for those.
  if (snap.worldMeta && typeof snap.worldMeta === 'object') {
    if (snap.worldMeta.createWorldDone) world._createWorldDone = true;
    if (Number.isFinite(snap.worldMeta.createWorldVersion)) {
      world._createWorldVersion = Math.max(0, snap.worldMeta.createWorldVersion | 0);
    }
    if (Number.isFinite(snap.worldMeta.saveGeneration)) {
      world._saveGeneration = Math.max(0, snap.worldMeta.saveGeneration | 0);
    }
    for (const id of snap.worldMeta.xmlSpawnersApplied ?? []) {
      if (typeof id === 'string' && id) world._xmlSpawnersApplied.add(id);
    }
    for (const id of snap.worldMeta.treasureChestsApplied ?? []) {
      if (typeof id === 'string' && id) world._treasureChestsApplied.add(id);
    }
  }
  // Re-attach poison tick closures lost in JSON. The actual rebind
  // happens in `main.js` after restoreWorld via
  // `reapplyPoisonAfterRestore(world)` (imported there to avoid an
  // import cycle: poison.js → status-effects → persistence.js).
}

/** Atomic write helper: tmp → rename, with a `.bak` of the previous file.
 *
 *  Bug-hunt #9 #6: under disk-full / I/O errors, `writeFileSync` could
 *  silently produce a short or zero-byte tmp that then renamed over the
 *  good file. Verify post-write size matches the intended payload before
 *  the rename — if it doesn't, throw so the caller's try/catch keeps the
 *  previous `.bak` reachable. Also fsync the tmp file descriptor so the
 *  bytes are on stable storage before the directory entry flip.
 */
function _atomicWrite(tmpPath, finalPath, payload) {
  const expected = Buffer.isBuffer(payload) ? payload.length : Buffer.byteLength(payload, 'utf8');
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, payload, 0, expected, 0);
    try { fs.fsyncSync(fd); } catch { /* fsync may fail on some FSes — non-fatal */ }
  } finally {
    fs.closeSync(fd);
  }
  const st = fs.statSync(tmpPath);
  if (st.size !== expected) {
    // Short write → leave .tmp on disk for diagnosis, don't clobber final.
    throw new Error(`[persistence] short write to ${tmpPath} (${st.size}/${expected} bytes)`);
  }
  if (fs.existsSync(finalPath)) {
    try { fs.copyFileSync(finalPath, finalPath + '.bak'); } catch { /* non-fatal */ }
  }
  fs.renameSync(tmpPath, finalPath);
}

/** Names of the basename files we write — matches the `splitSnapshot`
 *  return shape. The order matters only for backward compat (a legacy
 *  `world.json` is still recognised on load if these don't exist). */
const SAVE_BASENAMES = ['players', 'mobs', 'items'];
const SAVE_JOURNAL = 'save-journal.json';

function saveJournalPayload(generation, status) {
  return JSON.stringify({
    version: 1,
    generation: generation | 0,
    status,
    basenames: SAVE_BASENAMES,
    updatedAt: new Date().toISOString(),
  });
}

function writeSaveJournalSync(saveDir, generation, status) {
  const finalPath = path.join(saveDir, SAVE_JOURNAL);
  _atomicWrite(`${finalPath}.tmp`, finalPath, saveJournalPayload(generation, status));
}

// ===== Houses persistence ============================================
// HouseRegistry lives outside the mobile/item world but is just as
// load-bearing — without round-trip every shard restart wiped the
// owners + lockdowns + custom-house tile layouts of every player home.
// Mirrors ServUO `BaseHouse.Save/Load` (Engines/Housing/BaseHouse.cs)
// per-house records keyed by id.

function serializeHouse(h) {
  return {
    id: h.id,
    ownerSerial: h.ownerSerial >>> 0,
    ownerName: h.ownerName,
    map: h.map, x1: h.x1, y1: h.y1, x2: h.x2, y2: h.y2, z: h.z | 0,
    coowners: [...h.coowners],
    friends:  [...h.friends],
    bans:     [...h.bans],
    lockdowns: [...h.lockdowns],
    secures: h.secures instanceof Set ? [...h.secures] : (Array.isArray(h.secures) ? h.secures : []),
    vendors: h.vendors instanceof Set ? [...h.vendors] : (Array.isArray(h.vendors) ? h.vendors : []),
    createdAt: h.createdAt,
    lastTouchedAt: h.lastTouchedAt ?? h.createdAt,
    sign: h.sign ?? null,
    foundation: h.foundation ?? null,
    multiId: h.multiId ?? null,
    multiSerial: h.multiSerial ?? null,
    multiInstance: h.multiInstance ?? null,
    customizable: h.customizable === true,
    source: h.source ?? 'registry',
    // Custom-interior tiles + revision survive the round-trip; the
    // engine's `commitCustom` writes house.tiles[] from the editing
    // buffer, and the client renders the committed list on next chunk
    // stream.
    tiles: Array.isArray(h.tiles) ? h.tiles.slice() : [],
    revision: h.revision ?? 0,
    customTemplates: h.customTemplates ?? {},
    // Persist caps so a hot-loaded shard doesn't reset to the small-stone
    // defaults for foundations created post-SA scalar bump.
    lockdownCap: h.lockdownCap ?? null,
    secureCap:   h.secureCap   ?? null,
    spawnedItems: Array.isArray(h.spawnedItems) ? h.spawnedItems.slice() : [],
    customItemSerials: Array.isArray(h.customItemSerials) ? h.customItemSerials.slice() : [],
  };
}

function deserializeHouse(raw) {
  return {
    id: raw.id,
    ownerSerial: raw.ownerSerial >>> 0,
    ownerName: raw.ownerName ?? 'Unknown',
    map: raw.map | 0, x1: raw.x1 | 0, y1: raw.y1 | 0,
    x2: raw.x2 | 0, y2: raw.y2 | 0,
    z: raw.z | 0,
    coowners:  new Set(Array.isArray(raw.coowners)  ? raw.coowners  : []),
    friends:   new Set(Array.isArray(raw.friends)   ? raw.friends   : []),
    bans:      new Set(Array.isArray(raw.bans)      ? raw.bans      : []),
    lockdowns: new Set(Array.isArray(raw.lockdowns) ? raw.lockdowns : []),
    secures:   new Set(Array.isArray(raw.secures)   ? raw.secures   : []),
    vendors:   new Set(Array.isArray(raw.vendors)   ? raw.vendors   : []),
    createdAt: raw.createdAt ?? Date.now(),
    lastTouchedAt: raw.lastTouchedAt ?? raw.createdAt ?? Date.now(),
    sign: raw.sign ?? null,
    foundation: raw.foundation ?? null,
    multiId: raw.multiId == null ? null : (raw.multiId | 0),
    multiSerial: raw.multiSerial == null ? null : (raw.multiSerial >>> 0),
    multiInstance: raw.multiInstance == null ? null : (raw.multiInstance >>> 0),
    customizable: raw.customizable === true,
    source: raw.source ?? 'registry',
    tiles: Array.isArray(raw.tiles) ? raw.tiles : [],
    revision: raw.revision | 0,
    customTemplates: raw.customTemplates && typeof raw.customTemplates === 'object' ? raw.customTemplates : {},
    lockdownCap: raw.lockdownCap ?? null,
    secureCap:   raw.secureCap   ?? null,
    spawnedItems: Array.isArray(raw.spawnedItems) ? raw.spawnedItems : [],
    customItemSerials: Array.isArray(raw.customItemSerials) ? raw.customItemSerials : [],
    editing: null,
  };
}

/** Save the HouseRegistry to `houses.json` (same dir as the world saves). */
export function saveHousesSync(houses, saveDir) {
  if (!houses || !houses.houses) return;
  fs.mkdirSync(saveDir, { recursive: true });
  const finalJson = path.join(saveDir, 'houses.json');
  const finalGz   = path.join(saveDir, 'houses.json.gz');
  const tmp       = path.join(saveDir, 'houses.json.tmp');
  const payload = {
    version: SAVE_VERSION,
    nextHouseId: houses.nextHouseId ?? 1,
    houses: [...houses.houses.values()].map(serializeHouse),
  };
  const json = JSON.stringify(payload);
  if (BINARY_SAVE) {
    const gz = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 6 });
    _atomicWrite(tmp, finalGz, gz);
  } else {
    _atomicWrite(tmp, finalJson, json);
  }
}

export function saveHousesAsync(houses, saveDir) {
  if (!houses || !houses.houses) return Promise.resolve({ bytes: 0, format: 'json' });
  const finalJson = path.join(saveDir, 'houses.json');
  const finalGz   = path.join(saveDir, 'houses.json.gz');
  const tmp       = path.join(saveDir, 'houses.json.tmp');
  const payload = {
    version: SAVE_VERSION,
    nextHouseId: houses.nextHouseId ?? 1,
    houses: [...houses.houses.values()].map(serializeHouse),
  };
  let json;
  try { json = JSON.stringify(payload); } catch (e) { return Promise.reject(e); }
  if (BINARY_SAVE) {
    return fs.promises.mkdir(saveDir, { recursive: true })
      .then(() => new Promise((resolve, reject) => {
        zlib.gzip(Buffer.from(json, 'utf8'), { level: 6 },
          (err, buf) => err ? reject(err) : resolve(buf));
      }))
      .then((gz) => fs.promises.writeFile(tmp, gz).then(() => gz))
      .then((gz) => fs.promises.copyFile(finalGz, finalGz + '.bak')
        .catch(() => null).then(() => gz))
      .then(() => fs.promises.rename(tmp, finalGz))
      .then(async () => ({ bytes: (await fs.promises.stat(finalGz)).size, format: 'gzip' }));
  }
  return fs.promises.mkdir(saveDir, { recursive: true })
    .then(() => fs.promises.writeFile(tmp, json, 'utf8'))
    .then(() => fs.promises.copyFile(finalJson, finalJson + '.bak').catch(() => null))
    .then(() => fs.promises.rename(tmp, finalJson))
    .then(() => ({ bytes: json.length, format: 'json' }));
}

/**
 * Load houses from disk into the given HouseRegistry. Restores `nextHouseId`
 * counter so freshly-placed houses don't collide with old ids. Returns the
 * count of restored houses (0 if no save file present).
 */
export function loadHousesSync(houses, saveDir) {
  const candidates = [
    path.join(saveDir, 'houses.json.gz'),
    path.join(saveDir, 'houses.json'),
    path.join(saveDir, 'houses.json.gz.bak'),
    path.join(saveDir, 'houses.json.bak'),
  ];
  let raw = null;
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    try {
      raw = c.endsWith('.gz')
        ? zlib.gunzipSync(fs.readFileSync(c)).toString('utf8')
        : fs.readFileSync(c, 'utf8');
      break;
    } catch (e) {
      console.error(`[persistence] ${path.basename(c)} corrupt (${e.message}); trying next fallback`);
    }
  }
  if (!raw) return 0;
  let snap;
  try { snap = JSON.parse(raw); }
  catch (e) {
    console.error(`[persistence] houses save unreadable: ${e.message}`);
    return 0;
  }
  if (snap.version !== SAVE_VERSION) {
    console.warn(`[persistence] houses save version ${snap.version} != ${SAVE_VERSION}; loading anyway`);
  }
  houses.houses.clear();
  let maxId = 0;
  for (const raw of snap.houses ?? []) {
    if (typeof raw?.id !== 'number') continue;
    const h = deserializeHouse(raw);
    houses.houses.set(h.id, h);
    if (h.id > maxId) maxId = h.id;
  }
  // Restore the id counter — accept the explicit value if it's at least
  // one past the highest seen id, otherwise bump to maxId+1 so the next
  // place() call can never collide with a loaded house.
  const explicit = snap.nextHouseId | 0;
  houses.nextHouseId = Math.max(explicit, maxId + 1);
  return houses.houses.size;
}

// =====================================================================
//  Magincia Bazaar — `bazaar.json` (stall auctions). Bug-hunt #5 A5:
//  previously stall state lived only in module-level Map → wipe on
//  restart, all bids/owners/deposits gone.
// =====================================================================

export function saveBazaarSync(stalls, saveDir) {
  if (!Array.isArray(stalls)) return;
  fs.mkdirSync(saveDir, { recursive: true });
  const finalJson = path.join(saveDir, 'bazaar.json');
  const tmp       = path.join(saveDir, 'bazaar.json.tmp');
  const payload = { version: SAVE_VERSION, stalls };
  const json = JSON.stringify(payload);
  _atomicWrite(tmp, finalJson, json);
}

export function saveBazaarAsync(stalls, saveDir) {
  if (!Array.isArray(stalls)) return Promise.resolve({ bytes: 0 });
  const finalJson = path.join(saveDir, 'bazaar.json');
  const tmp       = path.join(saveDir, 'bazaar.json.tmp');
  const payload = { version: SAVE_VERSION, stalls };
  let json;
  try { json = JSON.stringify(payload); } catch (e) { return Promise.reject(e); }
  return fs.promises.mkdir(saveDir, { recursive: true })
    .then(() => fs.promises.writeFile(tmp, json, 'utf8'))
    .then(() => fs.promises.copyFile(finalJson, finalJson + '.bak').catch(() => null))
    .then(() => fs.promises.rename(tmp, finalJson))
    .then(() => ({ bytes: json.length }));
}

export function loadBazaarSync(saveDir) {
  const candidates = [
    path.join(saveDir, 'bazaar.json'),
    path.join(saveDir, 'bazaar.json.bak'),
  ];
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    try {
      const raw = fs.readFileSync(c, 'utf8');
      const snap = JSON.parse(raw);
      if (Array.isArray(snap?.stalls)) return snap.stalls;
    } catch (e) {
      console.error(`[persistence] ${path.basename(c)} corrupt (${e.message}); trying next fallback`);
    }
  }
  return [];
}

// =====================================================================
//  World-state — small kitchen-sink bucket for cross-restart timers:
//  day-night clock, weather rotation, season. Bug-hunt #8 #11.
// =====================================================================

export function saveWorldStateSync(state, saveDir) {
  if (!state) return;
  fs.mkdirSync(saveDir, { recursive: true });
  const finalJson = path.join(saveDir, 'world-state.json');
  const tmp       = path.join(saveDir, 'world-state.json.tmp');
  const payload = { version: SAVE_VERSION, ...state };
  _atomicWrite(tmp, finalJson, JSON.stringify(payload));
}

/** Non-blocking autosave variant. The synchronous function remains for the
 * final shutdown save, where durability is more important than latency. */
export async function saveWorldStateAsync(state, saveDir) {
  if (!state) return { bytes: 0 };
  const finalJson = path.join(saveDir, 'world-state.json');
  const tmp = path.join(saveDir, 'world-state.json.tmp');
  const json = JSON.stringify({ version: SAVE_VERSION, ...state });
  await fs.promises.mkdir(saveDir, { recursive: true });
  await fs.promises.writeFile(tmp, json, 'utf8');
  await fs.promises.copyFile(finalJson, `${finalJson}.bak`).catch(() => null);
  await fs.promises.rename(tmp, finalJson);
  return { bytes: json.length };
}

export function loadWorldStateSync(saveDir) {
  const candidates = [
    path.join(saveDir, 'world-state.json'),
    path.join(saveDir, 'world-state.json.bak'),
  ];
  for (const c of candidates) {
    if (!fs.existsSync(c)) continue;
    try {
      const raw = fs.readFileSync(c, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      console.error(`[persistence] ${path.basename(c)} corrupt (${e.message})`);
    }
  }
  return null;
}

/**
 * Write the snapshot atomically. Splits the live world into THREE files:
 *   - `players.json` — every mobile flagged `isPlayer === true`, plus
 *                      every item in their parent chain (worn, backpack,
 *                      nested containers).
 *   - `mobs.json`    — NPCs / monsters / pets + their worn equipment and
 *                      carried items.
 *   - `items.json`   — ground items + unparented loot (the decay
 *                      sweeper's territory).
 *
 * Decorations are NEVER persisted — `[createworld` re-applies them from
 * the JSON catalogues on every boot.
 *
 * Why split? `world.json` had become a single fat blob that grew with
 * every NPC and ground item; iterating on content meant re-loading
 * megabytes of unchanged player data. Splitting matches ServUO's
 * `Mobiles.bin` / `Items.bin` design — players.json stays tiny (one row
 * per account), mobs.json scales with population, items.json scales with
 * ground-item count + decays.
 */
export function saveWorldSync(world, saveDir) {
  fs.mkdirSync(saveDir, { recursive: true });
  const split = splitSnapshot(world);
  const generation = split.items.generation | 0;
  writeSaveJournalSync(saveDir, generation, 'writing');
  const writeOne = (basename, snap) => {
    const finalJson = path.join(saveDir, `${basename}.json`);
    const finalGz   = path.join(saveDir, `${basename}.json.gz`);
    const tmp       = path.join(saveDir, `${basename}.json.tmp`);
    const json = JSON.stringify(snap);
    if (BINARY_SAVE) {
      const gz = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 6 });
      _atomicWrite(tmp, finalGz, gz);
      if (fs.existsSync(finalJson)) {
        try { fs.renameSync(finalJson, finalJson + '.legacy'); } catch { /* non-fatal */ }
      }
    } else {
      _atomicWrite(tmp, finalJson, json);
    }
  };
  for (const basename of SAVE_BASENAMES) writeOne(basename, split[basename]);
  writeSaveJournalSync(saveDir, generation, 'committed');
  // Retire legacy `world.json` — its content has fully migrated into
  // mobs.json + items.json. Keep a `.legacy` rename so an operator can
  // diff against it before deleting.
  for (const ext of ['.json', '.json.gz']) {
    const p = path.join(saveDir, `world${ext}`);
    if (fs.existsSync(p)) {
      try { fs.renameSync(p, p + '.legacy'); } catch { /* non-fatal */ }
    }
  }
}

/**
 * Async save — snapshot is taken synchronously (so we get a consistent
 * world state) but the JSON serialization + disk write happen on the
 * next tick. ServUO's strategy is similar: it freezes the world for
 * the duration of `Save()`, then streams to disk while the heartbeat
 * resumes. We return a Promise for the disk write.
 *
 * @param {import('./world.js').World} world
 * @param {string} saveDir
 * @returns {Promise<{bytes:number, ms:number}>}
 */
export function saveWorldAsync(world, saveDir) {
  const t0 = Date.now();
  const split = splitSnapshot(world);
  const generation = split.items.generation | 0;

  // Async/yielding flavour — yields to the event loop BETWEEN each
  // basename so a 4-6 MB mobs.json doesn't park the AI tick + WS
  // handlers for 50-150 ms in one chunk. Each basename:
  //   1. setImmediate yield
  //   2. JSON.stringify (sync, but only that basename's slice)
  //   3. zlib.gzip ASYNC (uses libuv thread pool, off the main thread)
  //   4. fs.promises.writeFile + rename
  // Per-basename stringify on a populated shard is ~10-30 ms (vs ~80 ms
  // for the whole snapshot) — the worst-case stall drops by ~3×.
  const writeOne = async (basename, snap) => {
    await new Promise((r) => setImmediate(r));
    const finalJson = path.join(saveDir, `${basename}.json`);
    const finalGz   = path.join(saveDir, `${basename}.json.gz`);
    const tmp       = path.join(saveDir, `${basename}.json.tmp`);
    // Worker offload heuristic — estimate snap size cheaply via
    // serialized mob/item counts; if it's big, ship to worker. The
    // worker handles BOTH stringify and gzip in one round-trip so we
    // never pay both costs on the main thread for large saves.
    const sizeHint = ((snap?.mobiles?.length ?? 0) * 800)
                   + ((snap?.items?.length ?? 0) * 400);
    if (!WORKER_SAVE_DISABLED && sizeHint >= WORKER_SAVE_THRESHOLD) {
      try {
        const r = await workerStringify(basename, snap, BINARY_SAVE);
        if (r?.gz) {
          await fs.promises.writeFile(tmp, r.gz);
          try { await fs.promises.copyFile(finalGz, finalGz + '.bak'); }
          catch { /* non-fatal */ }
          await fs.promises.rename(tmp, finalGz);
          return { bytes: r.gz.length, jsonBytes: r.jsonBytes, format: 'gzip' };
        }
        if (r?.json) {
          await fs.promises.writeFile(tmp, r.json, 'utf8');
          try { await fs.promises.copyFile(finalJson, finalJson + '.bak'); }
          catch { /* non-fatal */ }
          await fs.promises.rename(tmp, finalJson);
          return { bytes: r.json.length, format: 'json' };
        }
        // Worker returned no data — fall through to inline path.
      } catch (e) {
        console.warn(`[persistence] worker save for ${basename} failed, falling back to inline:`, e.message);
      }
    }
    const json = JSON.stringify(snap);
    if (BINARY_SAVE) {
      const gz = await new Promise((resolve, reject) => {
        zlib.gzip(Buffer.from(json, 'utf8'), { level: 6 },
          (err, buf) => err ? reject(err) : resolve(buf));
      });
      await fs.promises.writeFile(tmp, gz);
      try { await fs.promises.copyFile(finalGz, finalGz + '.bak'); }
      catch { /* non-fatal */ }
      await fs.promises.rename(tmp, finalGz);
      return { bytes: gz.length, jsonBytes: json.length, format: 'gzip' };
    }
    await fs.promises.writeFile(tmp, json, 'utf8');
    try { await fs.promises.copyFile(finalJson, finalJson + '.bak'); }
    catch { /* non-fatal */ }
    await fs.promises.rename(tmp, finalJson);
    return { bytes: json.length, format: 'json' };
  };

  const begin = fs.promises.mkdir(saveDir, { recursive: true })
    .then(() => fs.promises.writeFile(
      path.join(saveDir, SAVE_JOURNAL),
      saveJournalPayload(generation, 'writing'),
      'utf8',
    ));
  return begin.then(() => Promise.all(SAVE_BASENAMES.map((b) => writeOne(b, split[b]))))
    .then(async (results) => {
      await fs.promises.writeFile(
        path.join(saveDir, SAVE_JOURNAL),
        saveJournalPayload(generation, 'committed'),
        'utf8',
      );
      // Best-effort retirement of legacy world.json (now fully covered
      // by mobs.json + items.json). Failure is non-fatal — the loader
      // still picks `mobs.json` over `world.json` at boot.
      for (const ext of ['.json', '.json.gz']) {
        const p = path.join(saveDir, `world${ext}`);
        try { await fs.promises.rename(p, p + '.legacy'); } catch { /* ignore */ }
      }
      return {
        bytes:     results.reduce((a, r) => a + (r.bytes ?? 0), 0),
        jsonBytes: results.reduce((a, r) => a + (r.jsonBytes ?? r.bytes ?? 0), 0),
        ms: Date.now() - t0,
        format: results[0]?.format ?? 'json',
      };
    });
}

/**
 * Load with crash recovery. Reads `players.json`, `mobs.json`,
 * `items.json` (each optional individually) and merges them into a
 * single snapshot for `restoreWorld`.
 *
 * Backward compat: if a legacy `world.json` exists (pre-split saves),
 * it's loaded too and union'd with the new files. Operators upgrading
 * from the single-file format don't need to do anything; the next save
 * writes the split format and renames `world.json → world.json.legacy`.
 *
 * Per-basename `.bak` / `.gz.bak` fallback covers crash-mid-write.
 */
export function loadWorldSync(world, saveDir) {
  const tryRead = (file) => {
    if (!fs.existsSync(file)) return null;
    if (file.endsWith('.gz')) {
      return zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
    }
    return fs.readFileSync(file, 'utf8');
  };
  let interruptedSave = false;
  try {
    const journal = JSON.parse(fs.readFileSync(path.join(saveDir, SAVE_JOURNAL), 'utf8'));
    interruptedSave = journal?.status === 'writing';
    if (interruptedSave) {
      console.warn(`[persistence] recovering interrupted generation ${journal.generation ?? '?'}`);
    }
  } catch { /* old shard or corrupt advisory journal */ }

  // For each basename, pick the first non-corrupt candidate (binary,
  // json, then their `.bak` siblings). Returns the parsed snap or null.
  const loadOne = (basename) => {
    const primary = [path.join(saveDir, `${basename}.json.gz`), path.join(saveDir, `${basename}.json`)];
    const backups = [path.join(saveDir, `${basename}.json.gz.bak`), path.join(saveDir, `${basename}.json.bak`)];
    const candidates = interruptedSave ? [...backups, ...primary] : [...primary, ...backups];
    for (const c of candidates) {
      const raw = tryRead(c);
      if (!raw) continue;
      try { return JSON.parse(raw); }
      catch (e) {
        console.error(`[persistence] ${path.basename(c)} corrupt (${e.message}); trying next fallback`);
      }
    }
    return null;
  };

  // All file basenames we know about — `world` is the legacy single-file
  // format and is read AS WELL AS the new triple, so an upgrade is
  // seamless. Once `saveWorldSync` has run the legacy file gets renamed
  // to `.legacy` and stops being picked up here.
  const snaps = [
    loadOne('players'),
    loadOne('mobs'),
    loadOne('items'),
    loadOne('world'),
  ].filter(Boolean);
  if (snaps.length === 0) return false;

  // Merge — union of mobiles/items across every loaded file, dedup'd by
  // serial via the duplicate-rejection path inside `restoreWorld`.
  // `nextMobile/nextItem` take the max across all files so a freshly-
  // allocated serial never collides with one that was already used in
  // some other partition's snap.
  const merged = {
    version: snaps[0].version,
    generation: Math.max(0, ...snaps.map((s) => s.generation ?? 0)) || undefined,
    mobiles: snaps.flatMap((s) => s.mobiles ?? []),
    items:   snaps.flatMap((s) => s.items   ?? []),
    serials: {
      nextMobile: Math.max(0, ...snaps.map((s) => s.serials?.nextMobile ?? 0)) || undefined,
      nextItem:   Math.max(0, ...snaps.map((s) => s.serials?.nextItem   ?? 0)) || undefined,
    },
    worldMeta: [...snaps].reverse().find((s) => s.worldMeta)?.worldMeta,
  };
  try {
    restoreWorld(world, merged);
    return true;
  } catch (e) {
    console.error(`[persistence] merged restore failed: ${e.message}`);
    return false;
  }
}

/**
 * Save queue — coalesces overlapping save requests. Call `requestSave(world, dir)`
 * to enqueue. If a save is already in flight, requests after it collapse
 * to a single trailing save (typical interval-saver pattern). Prevents
 * back-pressure on the event loop when something fires `[save` repeatedly.
 */
// Bug-hunt #9 #7 — keyed by saveDir so distinct worlds (staging /
// production / unit tests) don't collide on a shared `_inFlight`.
/** @type {Map<string, Promise<any>>} */
const _inFlight = new Map();
/** @type {Map<string, { world: any }>} */
const _trailing = new Map();
/** Per-save-directory operational counters. Kept out of snapshots and bounded
 * to one row per active shard directory. */
const _saveDiagnostics = new Map();

export function persistenceDiagnostics(saveDir) {
  const key = String(saveDir);
  const value = _saveDiagnostics.get(key) ?? { requests: 0, completed: 0, failed: 0, coalesced: 0,
    totalBytes: 0, totalMs: 0, lastBytes: 0, lastMs: 0, lastStartedAt: 0, lastCompletedAt: 0, lastError: null };
  return { ...value, averageMs: value.completed ? Number((value.totalMs / value.completed).toFixed(2)) : 0,
    inFlight: _inFlight.has(key), trailing: _trailing.has(key) };
}
/** Wait for any in-flight async save to settle. BH #12 B12: shutdown's
 *  `saveWorldSync` raced with a still-streaming `saveWorldAsync` over
 *  the same `<basename>.json.tmp` paths, corrupting the final save. */
export async function awaitInFlightSaves(timeoutMs = 5000) {
  const pending = [..._inFlight.values()];
  if (pending.length === 0) return;
  await Promise.race([
    Promise.allSettled(pending),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
}

export function requestSave(world, saveDir) {
  const key = String(saveDir);
  const stats = _saveDiagnostics.get(key) ?? { requests: 0, completed: 0, failed: 0, coalesced: 0,
    totalBytes: 0, totalMs: 0, lastBytes: 0, lastMs: 0, lastStartedAt: 0, lastCompletedAt: 0, lastError: null };
  stats.requests++;
  _saveDiagnostics.set(key, stats);
  if (_inFlight.has(key)) {
    stats.coalesced++;
    _trailing.set(key, { world });
    return _inFlight.get(key);
  }
  stats.lastStartedAt = Date.now();
  const p = saveWorldAsync(world, saveDir).then((result) => {
    stats.completed++;
    stats.lastBytes = Math.max(0, Number(result?.bytes) || 0);
    stats.lastMs = Math.max(0, Number(result?.ms) || 0);
    stats.totalBytes += stats.lastBytes;
    stats.totalMs += stats.lastMs;
    stats.lastCompletedAt = Date.now();
    stats.lastError = null;
    return result;
  }, (error) => {
    stats.failed++;
    stats.lastCompletedAt = Date.now();
    stats.lastError = String(error?.message ?? error).slice(0, 1000);
    throw error;
  }).finally(() => {
    _inFlight.delete(key);
    const t = _trailing.get(key);
    if (t) {
      _trailing.delete(key);
      requestSave(t.world, saveDir);
    }
  });
  _inFlight.set(key, p);
  return p;
}
