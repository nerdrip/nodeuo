// ProfileManager — persists user settings in localStorage. Mirrors
// ClassicUO's Configuration/ProfileManager.cs (without the per-character
// folder layout — browser storage is per-account).
//
// Settings exposed:
//   audio.master         0..1
//   audio.music           0..1
//   audio.sfx             0..1
//   gameplay.runOnHold    bool (mouse held = always run)
//   gameplay.alwaysRun    bool
//   ui.scale              0.5..2
//   ui.showFps            bool

import { bus } from '../core/event-bus.js';

const GLOBAL_KEY = 'uo.profile';

const DEFAULTS = Object.freeze({
  audio: {
    master: 0.6, music: 0.4, sfx: 0.7, ambient: 0.3,
    footsteps: 0.7,                       // volume scalar for footstep SFX
    combatMusic: true,                      // swap to combat track during fight
    loginMusic: true,
    loginMusicLoop: true,
    footstepSfx: true,                      // play footstep SFX per step
    enableSfx3d: true,                      // positional pan + attenuation
    reproduceSoundsInBackground: false,     // keep audio on when tab blurred
    musicVolumeFollowsMaster: true,         // tie music slider to master
  },
  tts: {
    speech: false,                          // read overhead/world text aloud
  },
  // CUO `Profile.cs` chat / speech hues. Stored as raw UO hue indices so
  // MessageManager → JournalGump can apply per-channel coloring on display
  // without a hex→index conversion each render.
  chat: {
    speechHue:    0x03B2,                   // generic speech
    whisperHue:   0x0033,
    emoteHue:     0x0040,
    yellHue:      0x0026,
    partyHue:     0x0044,                   // lime green
    allianceHue:  0x0057,                   // magenta-ish
    guildHue:     0x0044,
    systemHue:    0x03B2,
    activateChatAfterEnter: false,          // Enter focuses chat input
    chatAdditionalButtons: false,           // show whisper/yell/party quick buttons
    chatBackgroundOpacity: 0.6,
    chatFont: 0,                            // UO font index
    scaleSpeechDelay: true,                 // longer messages display longer
    speechDelayMs: 5000,
    unicode: true,                          // Unicode (0xAD) vs ASCII (0x03) speech
    muteGlobal: false,
    autoScrollJournal: true,
  },
  tooltips: {
    enabled: true,
    items: true, mobs: true, corpses: true,
    delayMs: 220,                           // hover delay before show
    width: 280, fontSize: 12,
    textHue: 0xFFFF,
    backgroundOpacity: 0.78,
    colorResists: true,                     // tint resist lines by element
    colorArtifact: true,                    // gold for artifact properties
    compareEquipped: true,                  // numeric +/- against current slot item
    echoToChat: false,                      // copy tooltip to chat on hover
    holdAltToShow: false,                   // require Alt key before showing tooltips
  },
  containers: {
    scale: 1.0,
    doubleClickToLoot: false,               // dbl-click item inside container loots to backpack
    autoStack: true,
    gridLoot: 'none',                       // 'none' | 'grid' | 'both'
    pinBackpack: false,                     // backpack always on top
    showCounts: true,                       // overlay stack qty
    restorePos: true,                       // remember per-container position
    confirmGoldDrop: true,                  // confirm dialog if dropping gold>X
    confirmGoldThreshold: 5000,
    hideEmpty: false,                       // hide containers with 0 items
    dropRadius: 16,                         // pixels snap-distance for re-arrange
  },
  counters: {
    enabled: false,
    highlightAmount: 5,                     // pulse when count < N
    icon: true, count: true,
    opacity: 0.95,
    cellSize: 36,
    rows: 1,
    cols: 10,
    refreshMs: 600,
    autoCount: true,                        // auto-scan backpack for new stacks
    highlightOnUse: true,
    hideEmpty: false,
  },
  worldmap: {
    showOnLogin: false,
    showCoordinates: true,
    showParty: true,
    showGuild: false,
    fogOfWar: false,
    userMarkers: true,
    extMarkersUrl: '',                      // optional remote markers JSON
    autoPan: true,                          // pan to follow player
    zoom: 1.0,
    markerSize: 10,
    showGroupBar: true,
    showGridIfZoomed: true,
    showPartyNames: true,
  },
  voice: {
    ttsEnabled: false,
    ttsNpc: true, ttsSystem: false, ttsParty: false,
    ttsRate: 1.0,                           // 0.5..2.0
    ttsPitch: 1.0,                          // 0.5..2.0
    ttsVolume: 0.8,
    ttsVoice: '',                           // browser voice name
  },
  combat: {
    autoTarget: false,
    queueSpells: true,                      // hold cast req until reagents ready
    autoRetarget: true,                     // re-target after kill
    spellHue: 0xFFFF,                       // overhead spell text hue
    friendlyFire: false,                    // confirm before damaging guildies
    highlightTarget: true,                  // show halo on lastTarget
    buffIcons: true,                        // render BuffGump
    autoTargetRange: 10,
    spellHueCursor: true,
    partyAuraColor: 0x0044,
    spellFormat: 'name',                    // 'name' | 'powerwords' | 'both'
    invulnerableTag: true,
    buffBarTime: true,
    showDps: false,
    bandageSelfOld: false,
  },
  experimental: {
    disableDefaultHotkeys: false,           // disable F1..F4 default macros
    disableArrowBtn: false,                 // disable arrow-walk
    saveAspectRatio: true,                  // preserve 4:3 viewport
    enableBlackWhiteEffect: false,          // greyscale dead view
    enableShadows: true,
    shadowsStatics: false,                  // shadows for static art (heavier)
    highlightGameObjects: false,            // outline hovered ground items
    sallosEasyGrab: false,                  // single-click pickup
    holdDownKeyTab: true,                   // war-mode while Tab held
    holdShiftToSplitStack: true,            // shift+drag splits a stack
    useStandardSkillsGump: false,
    workerPathfinding: false,
    forceUnicodeJournal: false,
    ignoreAllianceMessages: false,
    ignoreGuildMessages: false,
  },
  debug: {
    networkStats: false,
    fps: false,
    renderLists: false,
    packetLog: false,
    huePickerClick: false,
    skipAnimData: false,
    skipLighting: false,
    liteAtlas: false,
    cotOverlay: false,
    roofOverlay: false,
  },
  // Audit #34 P3 #11 — CUO `Configuration/Profile.cs:169-171` "Day &
  // Night" panel. `custom` toggles client-side override of the server
  // light level. `type=0` absolute (replace), `type=1` minimum (clamp).
  light: { custom: false, level: 12, type: 0, dayNightCycle: false,
           shadows: true, useDarkNights: true },
  gameplay:{
    runOnHold: false, alwaysRun: false,
    queryCriminalAction: true,
    queryBeneficialCriminalAction: true,
    confirmCriminal: true,                  // UI alias for queryCriminalAction
    castSpellsByOneClick: false,            // CUO option — no double-click to cast
    fastSpellsAssign: false,                // hotbar drop without confirmation
    autoOpenCorpses: false,                 // open corpse window on double-click corpse
    showHealthOverhead: true,
    showDamageNumbers: true,
    autoLoot: false,
    clickToWalk: true,
    autoStack: true,
    partyOverhead: true,
    autoOpenDoors: false,                   // bump-open closed doors
    showHouseContent: true,                 // dim multi tiles when inside
    counterBarEnabled: false,
    smoothMovement: true,                   // client-side movement prediction
  },
  ui: {
    // Native UO artwork was authored for much smaller displays. A modest
    // default zoom keeps it readable on current 1080p/1440p monitors while
    // preserving the original logical layout and pixel proportions.
    scale: 1.25, scaleVersion: 2, showFps: false,
    gumpState: {},
    paperdollMode: 'window',                // 'window' | 'sidebar'
    containerScale: 1.0,
    // CUO `Profile.cs::GameWindowPosition/Size/Lock` — viewport persistence
    // so a re-login restores the user-resized world window. `lock` freezes
    // the rectangle so accidental drag-edge doesn't resize it.
    gameWindowX: -1,                        // -1 = auto-fit (no saved value)
    gameWindowY: -1,
    gameWindowW: -1,
    gameWindowH: -1,
    gameWindowLock: false,
    // CUO `Profile.cs::PartyAura*` — colour-tint the under-feet aura for
    // party members vs hostiles. CUO defaults: 0x44 (lime green) for
    // party aura, 0x21 (firered) for combat target halo. Stored as raw
    // UO hue indices so the renderer feeds them straight into the
    // hue-filter without extra conversion.
    partyAuraColor: 0x0044,
    partyMemberHealthbarShape: 'bar',       // 'bar' | 'line' | 'round'
    partyAura3D: false,                     // 3D-projected ring vs flat disc
    combatTargetHaloColor: 0x0021,
    // CUO `Profile.cs::TooltipBackgroundOpacity / TextHue` — already
    // exposed under `tooltips.*` via options-gump; mirror the defaults
    // here so legacy readers still resolve.
    treeToStumps: false,                    // CUO heavy-stump foliage swap
    smoothDoors: true,                      // door swing keyframe interp
    fastRotation: false,                    // 8-way rotation w/o smoothing
    // Container behaviour
    backpackStyle: 'classic',               // 'classic' | 'flat' | 'small'
    // Audit rev.4 P2 — CUO `Profile.cs::HueContainerGumps` per-gump
    // tint so the player can colour-code chests by purpose. Default
    // hue 0 = no tint (canonical art). Stored as raw UO hue index.
    hueContainerGumps: 0,
    overrideContainerLocation: false,       // remember per-container position
    overrideContainerLocationSetting: 'default', // 'default' | 'nearBackpack' | 'cascade' | 'remember'
    scaleItemsInsideContainers: true,
    hideZoomGump: false,
    restrictMaxContainerOpened: 8,
    gridLootType: 'none',                   // 'none' | 'grid' | 'list'
    useLargeContainerGumps: false,
    doubleClickToLootInsideContainers: false,
    relativeDragAndDropItems: true,         // drop preserves slot offset
    // World rendering toggles (CUO ProfileManager.cs)
    circleOfTransparencyType: 0,            // 0 off / 1 hard / 2 gradient
    circleOfTransparencyRadius: 5,
    enableCaveBorder: false,
    hideVegetation: false,
    terrainShadowsLevel: 1,                 // 0..3
    fieldsType: 'classic',                  // 'classic' | 'static' | 'animated'
    // Audit #41 client P2 #11 — aura-manager reads `ui.auraUnderFeet`.
    // Was: this nested key was `auraUnderFeetType` → reader fell
    // through to its own default 1 always. Renamed to match consumer.
    auraUnderFeet: 0,                       // 0 off / 1 hostile / 2 all / 3 party
    animatedWaterEffect: true,
    reduceFPSWhenInactive: true,            // throttle rAF when tab hidden
    // Mobile rendering
    mobileHPType: 'percent',                // 'none' | 'percent' | 'line' | 'both'
    mobileHPShowWhen: 'low',                // 'always' | 'low' | 'damaged'
    showMobilesHP: true,
    highlightPoisoned: true,
    highlightParalyzed: true,
    highlightInvulnerable: true,
    // Targeting
    useNewTargetSystem: true,
    targetMode: 'closest',                  // 'closest' | 'next' | 'previous'
    // Journal
    useAlternateJournal: false,
    journalTabs: ['all', 'system', 'combat', 'spells', 'party', 'guild'],
    // World map
    worldMapWidth: 600,
    worldMapHeight: 400,
    worldMapFont: 0,
    worldMapZoom: 1,
    worldMapShowParty: true,
    worldMapShowMobiles: true,
    worldMapAllowPositionalTarget: false,
    worldMapShowSextant: true,
    worldMapShowMouseCoordinates: true,
    worldMapShowMultis: true,
    worldMapShowHiddenMarkers: false,
    worldMapShowZones: true,
    // Status / health bars
    statusGumpBarMutuallyExclusive: false,
    showInfoBar: false,
    showCounterBar: false,
    showSkillsChangedMessage: true,
    // Login UI
    saveServerInfo: true,
    autoLogin: false,
    rememberPassword: false,
  },
  // Name-overhead per-state bitfield filters. CUO `Profile.cs::NameOverheadFilter`
  // stores OR'd bits selecting which mobiles render their name plate.
  // Bits map to NotorietyFlag (1 Innocent, 2 Ally, 3 Gray, 4 Criminal,
  // 5 Enemy, 6 Murderer, 7 Invul). Default = all on except corpses.
  nameOverhead: {
    bitfield: 0x7F,                          // all noto classes
    showOwn: false,
    showItems: false,                        // ground items label
    showCorpses: false,
    showInvulnerable: true,
    showAttackable: true,                    // only mobiles I can attack
  },
  // Corpse auto-open + grid-loot prefs (CUO Profile.cs AutoOpenCorpses).
  corpse: {
    autoOpen: false,
    autoOpenRange: 2,                        // tiles
    skipEmpty: true,
    skipInnocent: false,                     // don't auto-open if criminal-flag would apply
    gridLoot: false,                         // open as grid-loot gump instead of container
  },
  spellbook: {
    lastSpellHighlight: true,                // outline most-recent cast
    reagentCheck: true,                      // grey-out spells lacking regs
    fastCast: false,                         // cast on single-click in book
  },
  hotkeys: {},                              // per-character macro bindings
  // Audit rev.4 P2 — notoriety hue table per CUO `Profile.cs`
  // Innocent/Friend/Criminal/CanAttack/Enemy/Murderer/Invul hues + the
  // status flags Poisoned/Paralyzed and the Beneficial/Harmful target
  // overlay colours. Stored as raw UO hue indices (mob hue palette,
  // not RGB) so the name-overhead + healthbar pickers feed them
  // straight into the hue-filter LUT.
  notoriety: {
    innocentHue:     0x0059,         // cream
    friendHue:       0x003F,         // bright green
    grayHue:         0x03B2,         // neutral grey
    criminalHue:     0x03B2,         // criminal grey (same band)
    enemyHue:        0x0026,         // orange enemy
    murdererHue:     0x0021,         // fire red
    invulHue:        0x0035,         // yellow gold
    poisonHue:       0x0044,         // poison green
    paralyzedHue:    0x0142,         // pale ice blue
    beneficialHue:   0x0044,
    harmfulHue:      0x0021,
    neutralHue:      0x03B2,
    canAttackHue:    0x0033,         // tan
  },
  // Audit rev.4 P3 — log new mob / corpse spawns to journal when they
  // enter view range. CUO `Profile.cs::ShowNewMobileNameIncoming`. Off
  // by default — chatty on crowded shards.
  showNewMobileName: false,
  showNewCorpseName: false,
  // Audit rev.4 P2 — drag-select multi-mob. CUO `Profile.cs::EnableDrag*`
  // controls Ctrl+drag (or Shift+drag) box selection over visible
  // mobiles, with filters for humanoid-only / hostile-only and an
  // "anchor as health-bar dock" option.
  dragSelect: {
    enabled: false,
    modifierKey: 'ctrl',              // 'ctrl' | 'shift' | 'alt'
    humanoidsOnly: false,
    hostileOnly: false,
    asAnchor: false,                  // spawn a healthbar gump per selected mob
  },
  // Audit #46 P2 — graphics-specific toggles. Most renderers also read
  // some `ui.*` keys; the `graphics.*` block aggregates the strictly
  // visual feature flags that map 1:1 to CUO Profile.cs visual options.
  graphics: {
    blackWhiteOnDeath: true,          // CUO `EnableBlackWhiteEffect` (death desat)
    hideUnderRoof:     true,          // CUO `NoDrawRoofs` (cut roofs when player covered)
    shadowsEnabled:    true,
    shadowsStatics:    true,          // also cast for statics, not just mobiles
    terrainShadowsLevel: 1,           // 0=off, 1=normal, 2=heavy
    useColoredLights:  true,          // per-static warm/cold hue
    useAlternativeLights: false,      // CUO night-vision alt palette
    useDarkNights:     true,          // dim ambient at night
    lightMaxVisible:   96,            // cap dynamic light sprites per frame
    lightCullTiles:    14,            // tile radius for point-light candidates
    enableDeathScreen: true,          // show "YOU ARE DEAD" banner
    highlightGameObjects: false,      // gold outline on hover
    circleTrans:       false,         // Ctrl+Q transparent-walls legacy
    enableShadows:     true,          // alias of shadowsEnabled (CUO uses both names)
    lightOverlay:      0.5,
    defaultZoom:       1.0,
    nearestSampling:   true,
    foliageTrans:      true,
    animatedWater:     true,
    weatherFx:         true,
    noColorObjectsOutOfRange: false,
    hideScreenshotMessage: false,
  },
  // Audit #46 P2 — input + journal flags.
  input: {
    mouseWheelZoom: true,
    rightClickMoves: true,
    dragWithAlt: true,
    autoWalk: true,
    dragThreshold: 4,
    holdShiftForContext: false,       // hold Shift to surface RMB context menu
    holdDownKeyAltToCloseAnchored: false,
    keyRepeatDelayMs: 350,
    keyRepeatIntervalMs: 50,
    mouseSensitivity: 1.0,
  },
  journalPrefs: {
    saveToFile: false,                // dump per-session to localStorage as text
    darkMode: false,
    hideTimestamps: false,
  },
  // Audit #46 P2 — login / reconnect prefs.
  login: {
    autoLogin: false,                 // skip Main/ServerSelect/CharSelect when remembered
    autoReconnect: true,              // reconnect-on-disconnect loop
    reconnectIntervalMs: 5000,
    reconnectMaxTries: 12,            // ~1 min @ 5s
  },
});

class ProfileManager {
  constructor() {
    this.settings = structuredClone(DEFAULTS);
    this._pathCache = new Map();
    this._valueCache = new Map();
    /** Per-character key suffix. Set by `bindCharacter(server, charName)`
     *  once the user finishes login. localStorage key becomes
     *  `uo.profile:<server>:<char>` so each character keeps its own
     *  bindings, gump layout, and toggles. */
    this._charKey = null;
    this._load();
  }

  /** Get a dotted path setting. */
  get(path) {
    if (this._valueCache.has(path)) return this._valueCache.get(path);
    const parts = this._parts(path);
    let obj = this.settings;
    for (const key of parts) obj = obj?.[key];
    this._valueCache.set(path, obj);
    return obj;
  }

  /** Set + persist a dotted path setting. */
  set(path, value) {
    const parts = this._parts(path);
    const last = parts[parts.length - 1];
    let obj = this.settings;
    for (let i = 0; i < parts.length - 1; i++) {
      obj = (obj[parts[i]] ??= {});
    }
    obj[last] = value;
    this._valueCache.clear();
    this._save();
    bus.emit('profile:changed', { path, value });
  }

  reset() {
    this.settings = structuredClone(DEFAULTS);
    this._valueCache.clear();
    this._save();
    bus.emit('profile:reset');
  }

  /** Switch to a per-character profile. Loads the character's saved
   *  settings on top of the current defaults; subsequent set() calls
   *  persist under the per-character key. Pass `null` to fall back to
   *  the shared global profile. */
  bindCharacter(server, charName) {
    if (!server || !charName) { this._charKey = null; this._load(); return; }
    this._charKey = `uo.profile:${server}:${charName}`;
    this._load();
    bus.emit('profile:bound', { server, charName });
  }

  /** Persist a gump's window state under `gumpKey`. ContainerGump,
   *  HealthBarGump, etc. call this on drag-end / resize so the position
   *  survives reloads. */
  saveGumpState(gumpKey, state) {
    if (!gumpKey) return;
    const map = (this.settings.ui.gumpState ??= {});
    map[gumpKey] = { ...map[gumpKey], ...state };
    this._valueCache.clear();
    this._save();
  }
  loadGumpState(gumpKey) {
    return this.settings.ui.gumpState?.[gumpKey] ?? null;
  }

  _activeKey() { return this._charKey ?? GLOBAL_KEY; }

  _parts(path) {
    let parts = this._pathCache.get(path);
    if (!parts) {
      parts = String(path).split('.');
      this._pathCache.set(path, parts);
    }
    return parts;
  }

  _load() {
    this._valueCache.clear();
    try {
      const storage = globalThis.localStorage;
      if (!storage) {
        this.settings = structuredClone(DEFAULTS);
        return;
      }
      const raw = storage.getItem(this._activeKey());
      if (!raw) {
        // No per-character data yet — start from global defaults so a
        // freshly-bound character inherits sensible audio/UI settings.
        if (this._charKey) {
          const g = storage.getItem(GLOBAL_KEY);
          if (g) this.settings = deepMerge(structuredClone(DEFAULTS), migrateProfile(JSON.parse(g)));
          else   this.settings = structuredClone(DEFAULTS);
        } else {
          this.settings = structuredClone(DEFAULTS);
        }
        return;
      }
      const parsed = migrateProfile(JSON.parse(raw));
      this.settings = deepMerge(structuredClone(DEFAULTS), parsed);
    } catch (e) { console.warn('[profile] load failed', e); }
  }
  _save() {
    try { globalThis.localStorage?.setItem(this._activeKey(), JSON.stringify(this.settings)); }
    catch (e) { console.warn('[profile] save failed', e); }
  }
}

function deepMerge(target, source) {
  for (const k of Object.keys(source)) {
    if (source[k] && typeof source[k] === 'object' && !Array.isArray(source[k])) {
      target[k] = deepMerge(target[k] ?? {}, source[k]);
    } else {
      target[k] = source[k];
    }
  }
  return target;
}

function migrateProfile(source) {
  if (!source || typeof source !== 'object') return source;
  // Existing profiles all inherited scale=1 even though the value was never
  // consumed by the renderer. Migrate that legacy default once. Explicit
  // custom scales are preserved.
  if (source.ui && typeof source.ui === 'object' && source.ui.scaleVersion == null) {
    if (source.ui.scale == null || Number(source.ui.scale) === 1) source.ui.scale = 1.25;
    source.ui.scaleVersion = 2;
  }
  const wm = source.worldmap;
  if (wm && typeof wm === 'object') {
    if (wm.showParty === undefined && wm.partyBlips !== undefined) {
      wm.showParty = wm.partyBlips;
    }
    if (wm.showGuild === undefined && wm.guildBlips !== undefined) {
      wm.showGuild = wm.guildBlips;
    }
    if (wm.zoom === undefined) {
      if (wm.defaultZoom !== undefined) wm.zoom = wm.defaultZoom;
      else if (wm.lastZoom !== undefined) wm.zoom = wm.lastZoom;
    }
  }
  return source;
}

export const profile = new ProfileManager();
