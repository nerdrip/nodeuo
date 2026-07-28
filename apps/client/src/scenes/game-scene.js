// GameScene — main in-world view. Wires:
//   1. an isometric land renderer (placeholder colours from world/map.js)
//   2. a mobile renderer (capsule sprites with notoriety colours + name)
//   3. a camera that follows the player
//   4. mouse-walk: hover edge of viewport drags the player (CUO style)
//   5. arrow-key fallback for the placeholder phase
//   6. a chat input that sends 0xAD UnicodeSpeech
//   7. a journal panel that captures incoming 0x1C / 0xAE
//
// FAZA 1 keeps DOM panels for HUD/chat/journal. FAZA 4 ports those to
// native UO gumps once the Gump asset pipeline is online.

import { Container } from 'pixi.js';
import { Scene } from '../core/scene.js';
import { clientPerfStats } from '../core/game-controller.js';
import { world } from '../world/world.js';
import { resolveLocalStandingZ, isLocallyBlocked } from '../world/walkability.js';
import { pathfindAsync, pathfindStats } from '../world/pathfinder.js';
import { net } from '../net/net-client.js';
import { bus } from '../core/event-bus.js';
import { camera } from '../renderer/camera.js';
import { commandManager } from '../managers/command-manager.js';
import { CommandPanel } from '../managers/command-panel.js';
import { installAdminPanelLink } from '../managers/admin-panel-link.js';
import { TileRenderer } from '../renderer/tile-renderer.js';
import { spritePool } from '../renderer/sprite-pool.js';
import { MobileRenderer } from '../renderer/mobile-renderer.js';
import { TILE_HALF_W } from '../renderer/iso.js';
import { GameWorldPicker } from './game-world-picker.js';
import { ensureGameDomUiStyles, sideRailOccupancy } from './game-dom-ui.js';
import { resolveMouseRunState } from '../shared/mouse-walk.js';
import {
  buildAttackReq,
  buildDropReq,
  buildGumpResponse,
  buildLiftReq,
  buildLookReq,
  buildMovementReq,
  buildOpenSpellBook,
  buildPartyMessage,
  buildPopupMenuChoice,
  buildPopupMenuRequest,
  buildToggleGargoyleFlying,
  buildUnicodeSpeech,
  buildUseReq,
  buildWarMode,
} from '../net/outgoing.js';
import { UIManager } from '../ui/ui-manager.js';
import { uiManagerInstance } from '../ui/ui-manager-singleton.js';
import { parseGumpLayout } from '../ui/gump-layout.js';
import { Checkbox } from '../ui/controls/checkbox.js';
import { TextInput } from '../ui/controls/text-input.js';
// Eager imports — frequently used (every session, often within first
// minute of play). Keep them in the main bundle to avoid an async hop on
// hotkey toggle.
import { PaperdollGump } from '../ui/gumps/paperdoll-gump.js';
import { StatusGump }    from '../ui/gumps/status-gump.js';
import { JournalGump }   from '../ui/gumps/journal-gump.js';
import { SkillsGump }    from '../ui/gumps/skills-gump.js';
import { SkillGumpAdvanced } from '../ui/gumps/skill-gump-advanced.js';
import { ContainerGump } from '../ui/gumps/container-gump.js';
import { BuyShopGump, SellShopGump } from '../ui/gumps/buy-gump.js';
import { SpellbookGump } from '../ui/gumps/spellbook-gump.js';
import { MinimapGump }   from '../ui/gumps/minimap-gump.js';
import { PartyGump }     from '../ui/gumps/party-gump.js';
import { PartyHealthSidebarGump } from '../ui/gumps/party-health-sidebar.js';
import { TextEntryDialogGump } from '../ui/gumps/text-entry-dialog-gump.js';
import { HealthBarGump }       from '../ui/gumps/health-bar-gump.js';
import { BuffGump }            from '../ui/gumps/buff-gump.js';
import { TradingGump }         from '../ui/gumps/trading-gump.js';
import { TopBarGump }          from '../ui/gumps/top-bar-gump.js';
import { ActionBarGump }       from '../ui/gumps/action-bar-gump.js';
import { PopupMenuGump }       from '../ui/gumps/popup-menu-gump.js';
import { restoreSavedHotbar }  from '../ui/gumps/use-spell-button-gump.js';
import { questArrow }          from '../ui/gumps/quest-arrow-gump.js';
// Lazy: rare-open gumps. Vite splits each `import('...')` into its own
// chunk; the gump is fetched + parsed only on first toggle. Keeps the
// main bundle ~80-120 KB lighter, shaving startup time on cold cache.
const lazyWorldmap         = () => import('../ui/gumps/worldmap-gump.js').then((m) => m.WorldmapGump);
const lazyOptions          = () => import('../ui/gumps/options-gump.js').then((m) => m.OptionsGump);
const lazyBulletinBoard    = () => import('../ui/gumps/bulletin-board-gump.js').then((m) => m.BulletinBoardGump);
const lazyMarkersManager   = () => import('../ui/gumps/markers-manager-gump.js').then((m) => m.MarkersManagerGump);
const lazyMahjong          = () => import('../ui/gumps/mahjong-gump.js').then((m) => m.MahjongGump);
const lazyHouseCustom      = () => import('../ui/gumps/house-customization-gump.js').then((m) => m.HouseCustomizationGump);
const lazyBook             = () => import('../ui/gumps/book-gump.js').then((m) => m.BookGump);
const lazyGridLoot         = () => import('../ui/gumps/grid-loot-gump.js').then((m) => m.GridLootGump);
const lazyProfile          = () => import('../ui/gumps/profile-gump.js').then((m) => m.ProfileGump);
const lazyNameOverHead     = () => import('../ui/gumps/name-overhead-handler-gump.js').then((m) => m.NameOverHeadHandlerGump);
const lazyNetworkStats     = () => import('../ui/gumps/network-stats-gump.js').then((m) => m.NetworkStatsGump);
const lazyInspector        = () => import('../ui/gumps/inspector-gump.js').then((m) => m.InspectorGump);
const lazyCredits          = () => import('../ui/gumps/credits-gump.js').then((m) => m.CreditsGump);
const lazyChat             = () => import('../ui/gumps/chat-gump.js').then((m) => m.ChatGump);
const lazyRaceChange       = () => import('../ui/gumps/race-change-gump.js').then((m) => m.RaceChangeGump);
const lazyRacialAbilities  = () => import('../ui/gumps/racial-abilities-book-gump.js').then((m) => m.RacialAbilitiesBookGump);
const lazyPetStable        = () => import('../ui/gumps/pet-stable-gump.js').then((m) => m.PetStableGump);
const lazyImbuing          = () => import('../ui/gumps/imbuing-gump.js').then((m) => m.ImbuingGump);
const lazyResurrectGump    = () => import('../ui/gumps/resurrect-gump.js').then((m) => m.ResurrectGump);
const lazyBankerGump       = () => import('../ui/gumps/banker-gump.js').then((m) => m.BankerGump);
const lazyCommunityGump    = () => import('../ui/gumps/community-collection-gump.js').then((m) => m.CommunityCollectionGump);
const lazyUltimaStoreGump  = () => import('../ui/gumps/ultima-store-gump.js');
const lazyCraftGump        = () => import('../ui/gumps/craft-gump.js');
const lazyHouseACLGump     = () => import('../ui/gumps/house-acl-gump.js');
// Faza H.2 — orphan gumps wired via sentinel.
const lazyHelpGump         = () => import('../ui/gumps/help-gump.js').then((m) => m.HelpGump);
const lazyGuildOverlay     = () => import('../ui/gumps/guild-gump.js').then((m) => m.GuildGump);
const lazyVendorSearchGump = () => import('../ui/gumps/vendor-search-gump.js').then((m) => m.VendorSearchGump);
const lazyVirtueGump       = () => import('../ui/gumps/virtue-gump.js').then((m) => m.VirtueGump);
const lazyKrampusGump      = () => import('../ui/gumps/krampus-ledger-gump.js').then((m) => m.KrampusLedgerGump);
const lazyTotGump          = () => import('../ui/gumps/trick-or-treat-gump.js').then((m) => m.TrickOrTreatGump);
const lazyCasinoGump       = () => import('../ui/gumps/fire-casino-gump.js').then((m) => m.FireCasinoGump);
const lazyVvVBattleGump    = () => import('../ui/gumps/vvv-battle-gump.js').then((m) => m.VvVBattleGump);
const lazyVvVExtraGumps    = () => import('../ui/gumps/vvv-extra-gumps.js');
const lazyPetTrainingGump  = () => import('../ui/gumps/pet-training-gump.js').then((m) => m.PetTrainingGump);
const lazyMLQuestsOverlay  = () => import('../ui/gumps/mlquests-gump.js').then((m) => m.MLQuestsGump);
const lazyAchievementGump  = () => import('../ui/gumps/achievement-progress-gump.js').then((m) => m.AchievementProgressGump);
const lazyLargeBodGump     = () => import('../ui/gumps/large-bod-gump.js').then((m) => m.LargeBodGump);
const lazyBodRewardsGump   = () => import('../ui/gumps/bod-rewards-gump.js').then((m) => m.BodRewardsGump);
const lazyRacialBookGump   = () => import('../ui/gumps/racial-abilities-book-gump.js').then((m) => m.RacialAbilitiesBookGump);
const lazyDeathGump        = () => import('../ui/gumps/death-gump.js').then((m) => m.DeathGump);
const lazyAdminGump        = () => import('../ui/gumps/admin-gump.js').then((m) => m.AdminGump);
const lazyPlayerVendorGump = () => import('../ui/gumps/player-vendor-gump.js').then((m) => m.PlayerVendorGump);
const lazyVendorRentalGump = () => import('../ui/gumps/vendor-rental-gump.js');
const lazyHuntmasterGump   = () => import('../ui/gumps/huntmaster-trophy-gump.js');
const lazyMapPinsGump      = () => import('../ui/gumps/map-pin-editor-gump.js');
const lazySpellComposer    = () => import('../ui/gumps/spell-composer-gump.js').then((m) => m.SpellComposerGump);
const lazySpecializations  = () => import('../ui/gumps/specialization-gump.js').then((m) => m.SpecializationGump);
import { profile }             from '../managers/profile-manager.js';
import { containerManager }    from '../managers/container-manager.js';
import { walker, movementStats, recordMovementTrace } from '../managers/walker.js';
import { assets }        from '../assets/asset-manager.js';
import { targetManager } from '../managers/target-manager.js';
import { dragDrop } from '../managers/drag-drop.js';
import { macroManager }  from '../managers/macro-manager.js';
import { useItemQueue }  from '../managers/use-item-queue.js';
import { audio }          from '../managers/audio-manager.js';
import { tooltips }       from '../managers/tooltip-manager.js';
import { EffectRenderer } from '../renderer/effect-renderer.js';
import { WorldTextRenderer } from '../renderer/world-text.js';
import { LightOverlay } from '../renderer/light-overlay.js';
import { lightPoints } from '../renderer/light-points.js';
import { MultiGhost } from '../renderer/multi-ghost.js';
import { SpellRangePreview } from '../renderer/spell-range-preview.js';
import { NavalRangePreview } from '../renderer/naval-range-preview.js';
import { HealthLinesManager } from '../managers/health-lines-manager.js';
import { nameOverheadManager } from '../managers/name-overhead-manager.js';
import { worldTextManager } from '../managers/world-text-manager.js';
import { Weather } from '../renderer/weather.js';
import { DeathScreen } from '../renderer/death-screen.js';
import { HouseCustomState, houseCustomization } from '../managers/house-customization-manager.js';
import { spellbookTypeFromKind } from '../shared/spellbook-types.js';
import {
  NodeUOSpellComposerMessage, NodeUOSpecializationMessage, NodeUONavalMessage,
} from '@uo/protocol';

export class GameScene extends Scene {
  constructor(gc) {
    super(gc);
    this._unsubs = [];
    /** @type {HTMLElement | null} */
    this._hud = null;
    /** @type {HTMLElement | null} */
    this._journal = null;
    /** @type {HTMLElement | null} */
    this._journalBody = null;
    /** @type {HTMLInputElement | null} */
    this._chatInput = null;
    this._journalLines = [];
    /** outstanding 0x02 sequences awaiting 0x22 ack */
    this._pendingMoves = new Map();
    this._worldPicker = new GameWorldPicker({
      world,
      camera,
      assets,
      isMobileLayerReady: () => !!this._mobiles,
    });
    /** Mouse steering vector relative to the player's feet. While RMB is
     * held it remains active outside the viewport and is clamped to the
     * nearest viewport edge, matching ClassicUO's continuous mouse walk. */
    this._mouseDx = 0;
    this._mouseDy = 0;
    this._mouseInside = false;
    this._mouseHeld = false;
    this._peekPanActive = false;
    this._peekPanLastX = 0;
    this._peekPanLastY = 0;
    /** mobile serials we've already auto-requested a name for (LookReq) */
    this._namesRequested = new Set();
    this._tiles = null;
    this._mobiles = null;
  }

  async load() {
    const Pixi = await import('pixi.js');
    this._Pixi = Pixi;
    // The character/map packet can arrive while LoginScene is still active.
    // Bind the streamed terrain to the authoritative world facet before any
    // ChunkVisual starts requesting blocks.
    await assets.setFacet(world.mapId | 0);
    // Establish the centered workspace before constructing persistent gumps.
    // GameController calls resize again after load, but waiting until then
    // made the top bar restore relative to the obsolete (8,8) viewport.
    camera.setSidePanelMode(profile.get('ui.compactSidePanels'));
    camera.setViewport(window.innerWidth, window.innerHeight);

    // Gameplay viewport rectangle — anything on `gc.world` gets masked
    // to this rectangle so the world never spills into the floating UI.
    // The rect resizes with the browser window via `_redrawViewportFrame`.
    this._backdrop = new Pixi.Graphics();
    this.gc.app.stage.addChildAt(this._backdrop, 0);
    this._mask = new Pixi.Graphics();
    this.gc.app.stage.addChild(this._mask);
    this.gc.world.mask = this._mask;
    this._frame = new Pixi.Graphics();
    // Insert the viewport frame BELOW the UI container so gumps render
    // on top of the chrome — `addChild` would put it above UI, which
    // caused gumps extending past the viewport edge to be clipped by
    // the frame chrome (user report 2026-05-18: moongate destination
    // gump's right edge cut off by viewport frame).
    const uiIdx = this.gc.app.stage.getChildIndex(this.gc.ui);
    this.gc.app.stage.addChildAt(this._frame, uiIdx);

    // Drag-resize handle in the bottom-right corner of the viewport.
    // Mirrors the corner-grip ClassicUO uses on its game window.
    this._resizeHandle = new Pixi.Graphics();
    this._resizeHandle.eventMode = 'static';
    this._resizeHandle.cursor = 'nwse-resize';
    this._resizeHandle.on('pointerdown', (e) => {
      e.stopPropagation();
      this._dragResize = { startX: e.global.x, startY: e.global.y, w0: camera.viewW, h0: camera.viewH };
    });
    // Same below-UI placement so a gump can render over the resize grip
    // when it overlaps. Re-fetch the index because the prior addChildAt
    // shifted the UI container's position by one.
    const uiIdx2 = this.gc.app.stage.getChildIndex(this.gc.ui);
    this.gc.app.stage.addChildAt(this._resizeHandle, uiIdx2);

    // Zoom buttons (top-right of viewport). CUO uses keyboard +/- and
    // mouse wheel; we add visible buttons for discoverability.
    this._zoomInBtn = this._makeZoomButton('+', () => camera.zoomIn());
    this._zoomOutBtn = this._makeZoomButton('-', () => camera.zoomOut());
    const uiIdx3 = this.gc.app.stage.getChildIndex(this.gc.ui);
    this.gc.app.stage.addChildAt(this._zoomInBtn, uiIdx3);
    const uiIdx4 = this.gc.app.stage.getChildIndex(this.gc.ui);
    this.gc.app.stage.addChildAt(this._zoomOutBtn, uiIdx4);

    // Mouse wheel anywhere in the viewport zooms in/out. Bound to
    // `this` so unload() can remove it — without that, every
    // login → logout → login pass left an extra listener attached and
    // each subsequent wheel-tick zoomed multiple steps at once.
    this._onWheel = (e) => {
      // If the wheel is over a UI control (gump, scroll area), let the
      // UIManager dispatch handle it instead of zooming the camera.
      // Without this guard scrolling inside the [go destination list
      // (or any container) zoomed the world map. Mirror of the same
      // pickAtScreen short-circuit used in the click handler.
      if (this._ui?.pickAtScreen?.(e.clientX, e.clientY)) return;
      // Audit #39 client P2 #8 — CUO blocks wheel-zoom while a target
      // cursor is active. Without this, scrolling away from the cursor
      // mid-cast (e.g. casting Flamestrike then bumping the wheel)
      // shifted the world while the cursor hit-test stayed in screen
      // coords → cast landed on the wrong tile.
      if (targetManager?.active) { e.preventDefault(); return; }
      // Audit #33 P1.2 — CUO `GameSceneInputHandler.cs:1011` requires
      // Ctrl AND `EnableMousewheelScaleZoom` profile flag. Plain wheel
      // events fire on every laptop touchpad scroll and pinch gesture,
      // so the world was zooming randomly during normal gump scrolling.
      // Default the profile flag to on so users who don't tweak
      // settings still get the zoom — just gated behind Ctrl.
      if (!e.ctrlKey) return;
      if ((profile?.get?.('camera.wheelZoom') ?? true) === false) return;
      if (e.deltaY < 0) camera.zoomIn();
      else if (e.deltaY > 0) camera.zoomOut();
      e.preventDefault();
    };
    this.gc.app.canvas.addEventListener('wheel', this._onWheel, { passive: false });

    this._redrawViewportFrame();

    // World layer hierarchy: ONE flat z-sorted container for everything
    // (land, statics, items, mobiles, effects, world-text). zIndex is
    // computed by depthKey() with per-class layer offsets so a mobile at
    // (x,y,z) sorts naturally between the floor below and the wall above.
    this._worldLayer = new Container();
    this._worldLayer.sortableChildren = true;
    this.gc.world.addChild(this._worldLayer);
    // Aliases so legacy code still has stable refs.
    this._tilesLayer = this._worldLayer;
    this._mobilesLayer = this._worldLayer;

    this._tiles = new TileRenderer(this._worldLayer);
    // Audit #46 P3 — expose tile-renderer + profile globally so
    // `light-points.js` occlusion sampler can read `_dynamicTalls` /
    // `visuals._tallStatics` without a circular import.
    try {
      globalThis.__tileRenderer = this._tiles;
      globalThis.__profile = profile;
    } catch { /* SSR */ }
    this._mobiles = new MobileRenderer(this._worldLayer);
    this._effects = new EffectRenderer(this._worldLayer);
    this._worldText = new WorldTextRenderer(this._worldLayer);
    // Lighting overlay mounts on the screen-space `worldOverlay` layer
    // (above the iso world, below all gumps). This keeps the dim
    // covering only the game viewport — `ui` layer gumps render on
    // top so paperdoll / spellbook / journal stay full-bright at night.
    this._light = new LightOverlay(this.gc.worldOverlay);
    // Wave 6: per-source point lights as additive radial discs.
    // Mount on `worldOverlay` (the screen-space layer that ALSO holds
    // the night/dim rect). Rendering order in `gc.init`:
    //   world (camera-transformed)  →  worldOverlay  →  ui
    // So mounting on `worldOverlay` puts the additive discs ON TOP OF
    // the dim rect — the brightening composites AFTER the darkening
    // instead of getting attenuated by it. The disc coords must be
    // manually camera-transformed inside `lightPoints.tick()`
    // because `worldOverlay` itself is untransformed.
    lightPoints.install(this.gc.worldOverlay);
    this._multiGhost = new MultiGhost(this._worldLayer);
    this._spellRangePreview = new SpellRangePreview(this._worldLayer, {
      landAt: (x, y) => assets.landAt?.(x, y),
    });
    this._navalRangePreview = new NavalRangePreview(this._worldLayer);
    this._unsubs.push(bus.on('nodeuo:naval-preview', ({ kind, payload }) => {
      if (kind === NodeUONavalMessage.HideRange) this._navalRangePreview?.clear();
      else this._navalRangePreview?.setSpec(payload);
    }));
    this._unsubs.push(bus.on('spell-composer:range-preview', (spec) => {
      this._spellRangePreview?.setSpec(spec);
    }));
    this._healthLines = new HealthLinesManager(this._worldLayer);
    // Wave 2: float labels + damage numbers on the world layer so they
    // sort with mobile sprites. Both managers are singletons; install
    // is idempotent so re-entering the scene won't duplicate parents.
    nameOverheadManager.install(this._worldLayer);
    worldTextManager.install(this._worldLayer);
    // Damage feedback is centralized on `damage:apply` in WorldTextManager
    // and MobileRenderer. Both legacy 0x0B and AOS 0x22 feed that event;
    // keeping a second combat:damage listener here rendered two numbers.
    // Single-click LookReq → 0x98 AllNamesAck → `entity:name` bus event.
    // Pin a 5-second floating label so the player sees what they clicked.
    this._unsubs.push(
      bus.on('entity:name', ({ serial, name }) => {
        if (!serial || !name) return;
        const m = world.mobiles.get(serial);
        if (!m) return;
        nameOverheadManager.show(serial, name, m.notoriety ?? 1, 5000);
      }),
    );
    // 0x38 Pathfind from server — route the destination into the same
    // autowalk machinery as RMB-DC. Mirrors CUO's behaviour where the
    // server can request a client-side pathfind (travel NPCs, GM goto).
    this._unsubs.push(
      bus.on('pathfind:server-request', ({ x, y }) => {
        if (typeof x !== 'number' || typeof y !== 'number') return;
        this._beginAutowalk(x | 0, y | 0);
      }),
    );
    // Weather (rain/snow particles) — same world-overlay layer as
    // the dim rect so storms wash over the viewport but never drift
    // across an open gump.
    this._weather = new Weather(this.gc.worldOverlay);
    this._deathScreen = new DeathScreen({ stage: this.gc.ui });
    /** local toggle synced from 0x72. */
    this._warMode = false;

    // UI manager mounts under the scene's UI overlay container.
    this._ui = new UIManager(this.gc.ui);
    uiManagerInstance.set(this._ui);
    this._unsubs.push(bus.on('profile:changed', ({ path }) => {
      if (path !== 'ui.compactSidePanels' && path !== 'ui.autoHideEmptyPanels') return;
      camera.setSidePanelMode(profile.get('ui.compactSidePanels'));
      camera.setViewport(window.innerWidth, window.innerHeight);
      this._redrawViewportFrame();
    }));
    this._unsubs.push(bus.on('gump:opened', () => this._redrawViewportFrame()));
    this._unsubs.push(bus.on('gump:disposed', () => this._redrawViewportFrame()));
    this._ui.serverGumpResponder = ({ serverSerial, gumpSerial, buttonId, switches = [], textEntries = [] }) => {
      // Collect default text entries / switches from the gump that triggered
      // the response. The server-gump parser stores TextInput.entryId and
      // Checkbox.switchId; we walk the originating gump tree to build the
      // payload before sending 0xB1.
      const gump = this._ui.gumps.find((g) => g.gumpSerial === gumpSerial);
      let collectedSwitches = switches;
      let collectedEntries = textEntries;
      if (gump) {
        collectedSwitches = collectedSwitches.length > 0 ? collectedSwitches : collectSwitches(gump);
        collectedEntries  = collectedEntries.length  > 0 ? collectedEntries  : collectTextEntries(gump);
      }
      net.send(buildGumpResponse({
        serverSerial, gumpSerial, buttonId,
        switches: collectedSwitches, textEntries: collectedEntries,
      }));
      // Close the source gump locally — CUO `ServerGump.OnButtonClick`
      // does the same (Gump.cs:OnButtonClick → Dispose). Without this
      // every paginated [items / [mobs / quest dialog reply leaves the
      // previous page on screen, stacking gumps until the player has to
      // close 30 windows by hand.
      if (gump) this._ui.removeGump(gump);
    };

    // Player should already exist (set by 0x1B handler in net/handlers.js).
    if (world.player) {
      camera.follow(world.player.x, world.player.y, world.player.z);
    }

    this._buildHud();
    // NodeUO sends the catalogue during capability negotiation, commonly
    // before this scene exists. The cached snapshot covers that path while
    // the subscription handles access changes/reconnects during the scene.
    this._sub('shard:commands', (data) => this._applyAccountAccess(data?.accessLevel));
    this._sub('net:close', () => this._applyAccountAccess('Player'));
    this._applyAccountAccess(world.commandCatalogue?.accessLevel || 'Player');
    this._buildJournal();
    this._buildChat();
    // Right-edge command panel — minimisable, populated by 0xBF 0xA0
    // `shard:commands` push at LoginComplete. Lives in its own DOM
    // overlay so it sits outside the Pixi canvas (and survives camera
    // zoom / drag-resize).
    this._cmdPanel = new CommandPanel(this.gc);
    // Admin-only "Open Admin Panel" pill — shows top-right after the
    // shard:commands push lands and accessLevel is GM/Admin. Lets an
    // admin account jump from the in-game tab to the web admin panel
    // (co-started by the control panel on :2596) without leaving the
    // browser. Self-removes on net:close so a player relog drops it.
    this._adminPanelLink = installAdminPanelLink();
    // Wire `chat:insert` → focus + prefill chat input. The command
    // panel uses this when the user clicks a row.
    this._sub('chat:insert', ({ text }) => {
      if (!this._chatInput) return;
      try {
        this._chatInput.focus();
        const cur = this._chatInput.value || '';
        // If the user is mid-typing, append; otherwise replace.
        this._chatInput.value = cur ? cur + (cur.endsWith(' ') ? '' : ' ') + text : text;
        // Move caret to end.
        const end = this._chatInput.value.length;
        this._chatInput.setSelectionRange?.(end, end);
      } catch { /* DOM gone */ }
    });

    // Per-event _refreshHud() removed — used to fire ~80× in one tick
    // after a TP (50 mobile:incoming + 30 entity:removed in burst), each
    // doing innerHTML = "..." which forces full DOM parse + layout. The
    // per-frame update() already calls _refreshHud (throttled internally
    // to 4Hz), and that's plenty for a debug panel.
    this._sub('mobile:incoming', (m) => { this._requestName(m.serial); });
    this._sub('mobile:update',   (m) => { this._requestName(m.serial); });
    // Multi-facet (5 maps): server fires 0xBF 0x08 when the player crosses
    // into a different facet (moongate, dungeon teleporter, region edge).
    // Swap the asset-manager's active facet, drop chunk visuals, refresh
    // the camera. Bins for unloaded facets stream in on demand.
    this._sub('player:map', async ({ mapId }) => {
      if (mapId == null) return;
      if ((mapId | 0) === world.mapId && (mapId | 0) === assets.currentFacet) return;
      world.mapId = mapId | 0;
      if (world.player) world.player.map = mapId | 0;
      // Audit #35 F7 — CUO `World.MapIndex = -1; world.MapIndex = map;`
      // triggers `Map.UnloadMap` which empties `Mobiles` + `Items`. We
      // previously only swapped the static atlas — `world.mobiles`
      // and `world.items` kept every old-facet entry, so the next
      // render frame re-mounted ghost mobs at stale coordinates and
      // tooltip/select/pathfind saw mobs at coords that don't exist
      // on the new map. Clear everything except the player and any
      // worn/in-pack item the player owns.
      const playerSerial = world.player?.serial ?? 0;
      for (const [s, m] of world.mobiles) {
        if ((s >>> 0) !== (playerSerial >>> 0)) world.mobiles.delete(s);
        else m.map = mapId | 0;
      }
      for (const [s, it] of world.items) {
        // Keep items whose parent chain leads to the player (backpack /
        // worn equipment / contents). Drop everything on the ground.
        let cur = it;
        let ownedByPlayer = false;
        for (let hop = 0; hop < 8 && cur; hop++) {
          if ((cur.parent | 0) === (playerSerial >>> 0)) { ownedByPlayer = true; break; }
          if (!cur.parent) break;
          cur = world.items.get(cur.parent);
        }
        if (!ownedByPlayer) world.items.delete(s);
      }
      world.markSpatialDirty?.();
      try {
        const ok = await assets.setFacet(mapId | 0);
        if (ok) {
          bus.emit('facet:changed', { mapId: mapId | 0 });
          this._appendJournal(`[map] entered facet ${mapId}`);
          // Force-rebuild the visible chunks at the player's new pos.
          if (world.player) camera.follow(world.player.x, world.player.y, world.player.z);
        } else {
          console.warn('[scene] no facet bin loaded for map', mapId);
        }
      } catch (e) { console.error('[scene] facet swap failed', e); }
    });
    // 0x1B sets up world.player before this scene mounts; nothing has
    // asked the server for the player's own name yet, so the overhead
    // label hangs as `0x...serial` until something else (paperdoll, chat)
    // happens to populate it. Fire one LookReq for self at scene boot.
    // Hard-coded "spawn the top-bar exactly once" helper so we don't
    // keep duplicating the same find-or-create dance across event
    // listeners. CUO opens the bar at first login AND keeps it across
    // resyncs; we mirror that by also re-opening if we've TP'd
    // somewhere with no top-bar in the active gump set.
    const _ensureTopBar = () => {
      if (!this._ui) return;
      if (this._ui.findGump((g) => g._toggleKey === 'topbar')) return;
      const uiScale = this._ui.scale || 1;
      const g = new TopBarGump((camera.viewX + 4) / uiScale, (camera.viewY + 4) / uiScale);
      g._toggleKey = 'topbar';
      this._ui.addGump(g);
    };
    const _ensureActionBar = () => {
      if (!this._ui || this._ui.findGump((g) => g._toggleKey === 'actionbar')) return;
      this._ui.addGump(new ActionBarGump());
    };
    // Spawn now if the player is already in-world by the time the scene
    // mounts (login-complete fired before we subscribed).
    if (world.player) { _ensureTopBar(); _ensureActionBar(); }
    this._sub('world:login-complete', () => {
      if (world.player) this._requestName(world.player.serial);
      // Audit #39 client P1 #3 — CUO uses per-character profiles
      // (`ProfileManager.cs`); we had `bindCharacter` defined but never
      // called, so two chars on the same account stomped on each
      // other's gump positions / hotkeys / hotbar. Bind once the name
      // is known (server name comes from the last login attempt).
      try {
        const charName = world.player?.name;
        const serverName = window?.__lastServerName ?? 'default';
        if (charName) profile.bindCharacter(serverName, charName);
      } catch { /* profile binding best-effort */ }
      // Open the persistent TopBar toolbar on first login. Player can
      // close it; we don't reopen automatically.
      if (this._ui) {
        _ensureTopBar();
        _ensureActionBar();
        // Restore any extra check stays here for back-compat — kept
        // outside the helper because it's the spell-hotbar restore.
        const existing = this._ui.findGump((g) => g._toggleKey === 'topbar');
        void existing;
        // Restore saved spell-hotbar shortcuts from the previous session.
        try { restoreSavedHotbar(this._ui); }
        catch (e) { console.warn('[hotbar] restore failed', e); }
      }
    });
    if (world.player) this._requestName(world.player.serial);
    // entity:removed used to call _refreshHud per event — now folded
    // into the throttled per-frame call (see _refreshHud).
    this._sub('entity:removed',  () => {});
    // 0x20 self-update with a >1-tile jump means the server teleported
    // us (admin TP, [tele, [go, recall, moongate, resync). Drop the
    // predicted-move queue so in-flight 0x02 packets sent from the OLD
    // tile don't fight 0x21 reject + walker resyncRequested latch
    // against keyboard input from the NEW tile. Walker.reset() +
    // mob offset wipe happen in handlers.js 0x20 path before this fires.
    this._sub('player:teleported', () => {
      this._pendingMoves.clear();
    });
    this._sub('player:resynced', () => {
      this._pendingMoves.clear();
    });
    // "You see" is the header ServUO uses for 0x09 LookReq replies — the
    // overhead-name capture in net/handlers.js consumed those silently;
    // skip them in the journal too so we don't spam a "You see: admin"
    // line for every mobile that wanders into view.
    // `@@OPEN_*_GUMP@@` markers travel as server SystemMessage (unicodeMessage)
    // and ServUO-style system speak (asciiMessage). MessageManager already
    // strips them when re-emitting on `message:journal`, but the legacy
    // direct-append handlers below were the leak path (user report 2026-05-17).
    const _isGumpBridgeMarker = (t) =>
      typeof t === 'string' && t.startsWith('@@OPEN_') && t.includes('_GUMP@@');
    const _handleCraftProgress = (t) => {
      if (typeof t !== 'string' || !t.startsWith('@@CRAFT_PROGRESS@@')) return false;
      const [recipeId, done, total, status, encoded = ''] = t.slice('@@CRAFT_PROGRESS@@'.length).split('|');
      let message = '';
      try { message = decodeURIComponent(encoded); } catch { /* optional text */ }
      bus.emit('ui:craft:progress', {
        recipeId: Number(recipeId) | 0,
        done: Number(done) | 0,
        total: Number(total) | 0,
        status: String(status || ''),
        message,
      });
      return true;
    };
    this._sub('chat:ascii',      (m) => {
      if (m.name === 'You see') return;
      if (_handleCraftProgress(m.text)) return;
      if (_isGumpBridgeMarker(m.text)) return;
      this._appendJournal(`${m.name || '?'}: ${m.text}`);
    });
    this._sub('chat:unicode',    (m) => {
      if (m.name === 'You see') return;
      if (_handleCraftProgress(m.text)) return;
      if (_isGumpBridgeMarker(m.text)) return;
      this._appendJournal(`${m.name || '?'}: ${m.text}`);
    });
    // 0xB2 chat-conference broadcasts route to the journal too so
    // users see channel traffic without a dedicated ChatGump.
    this._sub('chat:conference', (m) => this._appendJournal(`[chat] ${m.text}`));
    this._sub('movement:rej',    (rej) => this._onMovementRej(rej));
    this._sub('movement:ack',    (ack) => this._onMovementAck(ack));
    this._sub('atmosphere:music', (info) => this._appendJournal(`[music] ${info.musicId}`));
    this._sub('gump:open',        (info) => this._onGumpOpen(info));
    this._sub('paperdoll:open',   (info) => {
      // Server's 0x88 carries `text` = "<name>, <title>" or just "<name>".
      // Stash it on the mobile so the gump (and any future hover label)
      // can display the proper character name instead of an `0x...` serial.
      const mob = world.mobiles.get(info.serial >>> 0);
      if (mob && info.text) mob.name = info.text.trim();
      this._toggleGump('paperdoll', () => new PaperdollGump(info.serial));
    });
    // Client audit #4 D1 — gate the standard ContainerGump on corpses
    // when the grid-loot toggle is on; the second `container:open` sub
    // below would otherwise spawn BOTH gumps at the same time.
    this._sub('container:open',   (info) => {
      const it = world.items.get(info.serial >>> 0);
      const isCorpse = it?.itemId === 0x2006;
      if (isCorpse && profile.get('ui.gridLoot') === true) return;
      this._onContainerOpen(info);
    });
    // Spellbook content (0xBF 0x1B). Server bypasses 0x24 OpenContainer
    // entirely for spellbooks — the bitmap of known spells arrives via
    // the extended command. Without this branch the spellbook never
    // had a chance to open and the player saw nothing on double-click.
    this._sub('spellbook:content', ({ serial, offset, hi, lo }) => {
      const key = `spellbook:${serial >>> 0}`;
      const existing = this._ui?.findGump((g) => g._toggleKey === key);
      if (existing) this._ui.removeGump(existing);
      // Spellbook circle → gump id mapping (CUO):
      //   1 Magery  = 0xFFB1     101 Necromancy = 0xFFB2
      //   201 Chivalry  = 0xFFB3 401 Bushido    = 0xFFB4
      //   501 Ninjitsu  = 0xFFB5 601 Spellweave = 0xFFB6
      //   678 Mysticism = 0xFFB7
      const gumpId = offset >= 678 ? 0xFFB7
        : offset >= 601 ? 0xFFB6
        : offset >= 501 ? 0xFFB5
        : offset >= 401 ? 0xFFB4
        : offset >= 201 ? 0xFFB3
        : offset >= 101 ? 0xFFB2
        : 0xFFB1;
      const g = new SpellbookGump(serial, gumpId, { offset, hi, lo });
      g._toggleKey = key;
      g._reopenFactory = () => new SpellbookGump(serial, gumpId, { offset, hi, lo });
      this._ui.addGump(g);
    });
    this._sub('shop:buy',         (info) => this._toggleGump(`buy:${info.vendor >>> 0}`, () => new BuyShopGump(info)));
    this._sub('shop:sell',        (info) => this._toggleGump(`sell:${info.vendor >>> 0}`, () => new SellShopGump(info)));
    // Auto-open the trade window on 0x6F action 0x00 (server starts trade).
    this._sub('trade:event',      (e) => {
      if (e.action !== 0x00) return;
      if (!this._ui) return;
      const key = `trade:${e.containerSerial >>> 0}`;
      const existing = this._ui.findGump((g) => g._toggleKey === key);
      if (existing) return;
      const g = new TradingGump(e);
      g._toggleKey = key;
      this._ui.addGump(g);
    });
    // Auto-open the buff bar on the first incoming buff icon. Once open
    // it stays open until the player closes it; new buffs slot in.
    this._sub('buff:add',         () => {
      if (!this._ui) return;
      const existing = this._ui.findGump((g) => g._toggleKey === 'buffs');
      if (existing) return;
      const g = new BuffGump();
      g._toggleKey = 'buffs';
      this._ui.addGump(g);
    });
    this._sub('chat:cliloc',      (m)    => {
      const text = assets.cl(m.cliloc, m.args);
      this._appendJournal(`${m.name || '?'}: ${text}`);
    });
    this._sub('target:cursor',    (info) => {
      targetManager.setFromServer(info);
      this._appendJournal('[system] Target prompt - click a target or press Esc to cancel.');
    });
    this._sub('target:multi',     (info) => {
      targetManager.setMultiPlacement(info);
      this._appendJournal(`[system] Place multi 0x${info.multiId.toString(16)} - click a ground tile.`);
    });
    // 0xBF 0x16 close-window — server-driven dismiss. CUO maps `kind`
    // to a gump family: 1=paperdoll, 2=healthbar, 8=profile,
    // 0x0C=container. Look up the matching open gump and close it.
    // Mirrors ClassicUO `Network/PacketHandlers.cs:4358-4388`.
    this._sub('gump:close', ({ kind, serial }) => {
      if (!this._ui) return;
      const s = serial >>> 0;
      let match = null;
      switch (kind | 0) {
        case 1: // paperdoll
          match = this._ui.findGump((g) => g.type === 'paperdoll' && g.mobileSerial === s);
          break;
        case 2: // healthbar
          match = this._ui.findGump((g) => g.type === `health-bar:${s}`);
          break;
        case 8: // profile
          match = this._ui.findGump((g) => g.type === 'profile' && g.mobileSerial === s);
          break;
        case 0x0C: // container
          match = this._ui.findGump((g) => g.type === 'container' && g.containerSerial === s);
          break;
        default:
          // Generic fallback — match by serial alone.
          match = this._ui.findGump((g) => g.mobileSerial === s || g.containerSerial === s || g.gumpSerial === s);
      }
      if (match) this._ui.removeGump(match);
    });
    this._sub('macro:gump',       ({ kind }) => {
      const spellbookType = spellbookTypeFromKind(kind);
      if (spellbookType != null) {
        net.send(buildOpenSpellBook(spellbookType));
        return;
      }
      switch (kind) {
        case 'paperdoll': this._toggleGump('paperdoll', () => new PaperdollGump(world.player?.serial ?? 0)); break;
        case 'journal':   this._toggleGump('journal',   () => new JournalGump());   break;
        case 'skills':    this._toggleGump('skills', () => profile.get('experimental.useStandardSkillsGump')
          ? new SkillsGump() : new SkillGumpAdvanced()); break;
        case 'skills-advanced':
          this._toggleGump('skills-advanced', () => new SkillGumpAdvanced());
          break;
        case 'corpse-filter': {
          // Re-open the most-recently-opened corpse using the filter gump.
          // Without a recent corpse there's nothing to bind to — emit a
          // hint so the user knows why nothing happened.
          const s = this._lastCorpseSerial >>> 0;
          if (!s) {
            bus.emit('chat:system', { text: 'No corpse open. Double-click one first.' });
            break;
          }
          this._toggleGump(`corpse-filter:${s}`, async () => {
            const { OpenedCorpseGump } = await import('../ui/gumps/opened-corpse-gump.js');
            return new OpenedCorpseGump(s);
          });
          break;
        }
        case 'text-container': {
          const s = this._lastCorpseSerial >>> 0
                 || this._lastContainerSerial >>> 0;
          if (!s) {
            bus.emit('chat:system', { text: 'No container open.' });
            break;
          }
          this._toggleGump(`text-container:${s}`, async () => {
            const { TextContainerGump } = await import('../ui/gumps/text-container-gump.js');
            return new TextContainerGump(s);
          });
          break;
        }
        case 'status':    this._toggleGump('status',    () => new StatusGump());    break;
        case 'options':   this._toggleGump('options',   async () => new (await lazyOptions())());   break;
        case 'minimap':   this._toggleGump('minimap',   () => new MinimapGump());   break;
        case 'party':     this._toggleGump('party',     () => new PartyGump());     break;
        case 'party-health-sidebar':
          this._toggleGump('party-health-sidebar', () => new PartyHealthSidebarGump()); break;
        case 'logout':    this._onDisconnected(null, /* userInitiated */ true);   break;
        // 'profile' is the paperdoll's chat-icon button (CUO
        // BUTTON_CHAT, gump 0x07E2/0x07E3). Marcin: "przycisk czat
        // jak klikniesz to robisz aktywny text edit do wpisywania" —
        // focus the chat input bar at the bottom of the scene so the
        // user can start typing immediately.
        case 'profile':
        case 'chat':
          if (this._chatInput) {
            try { this._chatInput.focus(); } catch { /* DOM gone */ }
          }
          break;
        case 'help':      this._appendJournal('[system] Help: hotkeys P/J/K/T/M/R/O.'); break;
        // Audit rev.4 P3 — additional top-bar destinations. Each
        // mirrors a CUO TopBarGump button.
        case 'worldmap':  this._toggleGump('worldmap',  async () => {
          const { WorldmapGump } = await import('../ui/gumps/worldmap-gump.js');
          return new WorldmapGump();
        }); break;
        case 'macros':    this._toggleGump('macros',    async () => {
          const { MacroGump } = await import('../ui/gumps/macro-gump.js');
          return new MacroGump();
        }); break;
        case 'netstats':  this._toggleGump('network-stats', async () => {
          const { NetworkStatsGump } = await import('../ui/gumps/network-stats-gump.js');
          return new NetworkStatsGump();
        }); break;
        case 'resources': this._toggleGump('resource-diagnostics', async () => {
          const { ResourceDiagnosticsGump } = await import('../ui/gumps/resource-diagnostics-gump.js');
          return new ResourceDiagnosticsGump();
        }); break;
        case 'debug':     this._toggleGump('inspector', async () => {
          const { InspectorGump } = await import('../ui/gumps/inspector-gump.js');
          return new InspectorGump();
        }); break;
        case 'info-bar-builder': this._toggleGump('info-bar-builder', async () => {
          const { InfoBarBuilderGump } = await import('../ui/gumps/info-bar-builder-gump.js');
          return new InfoBarBuilderGump();
        }); break;
        // Audit rev.9 — paperdoll heart-button (slot 9) opens the Virtues
        // gump. Each invoke button sends 0xB1 VirtueGumpResponse so the
        // server can apply the virtue effect.
        case 'virtues': this._toggleGump('virtues', async () => {
          const { VirtueGump } = await import('../ui/gumps/virtue-gump.js');
          return new VirtueGump();
        }); break;
        case 'racial-abilities': this._toggleGump('racial-abilities', async () => {
          const { RacialAbilitiesBookGump } = await import('../ui/gumps/racial-abilities-book-gump.js');
          const race = ({ 1: 'human', 2: 'elf', 3: 'gargoyle' })[world.player?.race ?? 1] ?? 'human';
          return new RacialAbilitiesBookGump(race);
        }); break;
      }
    });
    this._sub('quest:arrow', (info) => {
      if (!info?.active) questArrow.clear();
      else questArrow.setTarget(info);
    });
    // Double-click on a paperdoll equipment slot (e.g. backpack) sends
    // a 0x06 UseReq — server replies with 0x24 ContainerOpen for bags
    // or whatever the item's onUse hook does (food, scrolls, etc.).
    this._sub('item:use', ({ serial }) => net.send(buildUseReq(serial >>> 0)));
    // Server text-entry prompt (0xAB) → modal dialog. The gump owns
    // the response packet; on close we drop the subscription state.
    this._sub('prompt:text', (info) => {
      this._toggleGump(`text-entry:${info.serial >>> 0}:${info.parentId}:${info.buttonId}`,
                       () => new TextEntryDialogGump(info));
    });
    // Health-bar dragout: server sends 0x77 mobileMoving + we surface
    // a "drag-bar" gesture on overhead hp bars. For now a /healthbar
    // chat command is the easiest hook — but it's also wired below
    // to be openable by the macro system (`macro:gump kind=healthbar`).
    this._sub('macro:open-healthbar', ({ serial }) => {
      const s = (serial ?? world.player?.serial ?? 0) >>> 0;
      if (!s) return;
      this._toggleGump(`health-bar:${s}`, () => new HealthBarGump(s));
    });
    this._sub('macro:open-markers', () => {
      this._toggleGump('markers-manager', async () => new (await lazyMarkersManager())());
    });
    // PetStableGump open hook. Server `[stable gump` emits this sentinel
    // in the system-message channel; the gump's own constructor then
    // re-issues `[stable list` to fill in row data (STABLE-prefixed lines
    // are dispatched through the same chat:system bus).
    this._sub('ui:stable:open', () => {
      this._toggleGump('pet-stable', async () => new (await lazyPetStable())());
    });
    // Imbuing gump open hook — sister to ui:stable:open below.
    this._sub('ui:imbuing:open', () => {
      this._toggleGump('imbuing', async () => new (await lazyImbuing())());
    });
    // Sentinel-bridge: servers emit literal `@@OPEN_*_GUMP@@` strings
    // as system messages to request specific client gumps. Most system
    // messages funnel through `message:journal`; we sniff for sentinels
    // and re-emit the typed UI event. The empty-string text journals are
    // swallowed by the journal gump filter — no spam.
    this._sub('message:journal', (m) => {
      const t = m?.text;
      if (t === '@@OPEN_STABLE_GUMP@@')  bus.emit('ui:stable:open');
      if (t === '@@OPEN_IMBUING_GUMP@@') bus.emit('ui:imbuing:open');
      if (typeof t === 'string' && t.startsWith('@@OPEN_RESURRECT_GUMP@@')) {
        const caster = t.slice('@@OPEN_RESURRECT_GUMP@@'.length) || 'A stranger';
        bus.emit('ui:resurrect-offer:open', { caster });
      }
      if (typeof t === 'string' && t.startsWith('@@OPEN_BANKER_GUMP@@')) {
        const balance = parseInt(t.slice('@@OPEN_BANKER_GUMP@@'.length), 10) || 0;
        bus.emit('ui:banker:open', { balance });
      }
      if (typeof t === 'string' && t.startsWith('@@OPEN_COMMUNITY_GUMP@@')) {
        const rows = t.slice('@@OPEN_COMMUNITY_GUMP@@'.length);
        bus.emit('ui:community:open', { rows });
      }
      if (typeof t === 'string' && t.startsWith('@@OPEN_STORE_GUMP@@')) {
        const payload = t.slice('@@OPEN_STORE_GUMP@@'.length);
        bus.emit('ui:store:open', { payload });
      }
      if (typeof t === 'string' && t.startsWith('@@OPEN_CRAFT_GUMP@@')) {
        const payload = t.slice('@@OPEN_CRAFT_GUMP@@'.length);
        bus.emit('ui:craft:open', { payload });
      }
      if (typeof t === 'string' && t.startsWith('@@OPEN_HOUSE_GUMP@@')) {
        const payload = t.slice('@@OPEN_HOUSE_GUMP@@'.length);
        bus.emit('ui:house-acl:open', { payload });
      }
      if (typeof t === 'string' && t.startsWith('@@OPEN_HOUSE_CUSTOM@@')) {
        const serial = Number(t.slice('@@OPEN_HOUSE_CUSTOM@@'.length)) >>> 0;
        if (serial) bus.emit('house:custom', { serial });
      }
      // Faza H.2 — uniform sentinel sweep. Each `@@OPEN_<NAME>_GUMP@@<rest>`
      // emits `ui:<key>:open` with the trailing payload (or empty string).
      if (typeof t === 'string' && t.startsWith('@@OPEN_') && t.includes('_GUMP@@')) {
        const m = /^@@OPEN_([A-Z]+)_GUMP@@([\s\S]*)$/.exec(t);
        if (m) {
          const tag = m[1];
          const payload = m[2];
          const map = {
            HELP:           'ui:help:open',
            GUILD:          'ui:guild-overlay:open',
            VENDORSEARCH:   'ui:vendor-search:open',
            VIRTUE:         'ui:virtue:open',
            KRAMPUS:        'ui:krampus:open',
            TOT:            'ui:trick-or-treat:open',
            CASINO:         'ui:casino:open',
            VVV:            'ui:vvv:open',
            PETTRAINING:    'ui:pet-training:open',
            MLQUESTS:       'ui:mlquests-overlay:open',
            ACHIEVEMENTS:   'ui:achievements-panel:open',
            LARGEBOD:       'ui:large-bod:open',
            BODREWARDS:     'ui:bod-rewards:open',
            RACIAL:         'ui:racial-book:open',
            DEATH:          'ui:death:open',
            ADMIN:          'ui:admin:open',
            PLAYERVENDOR:   'ui:player-vendor:open',
            VENDORRENTAL:   'ui:vendor-rental:open',
            VENDORINV:      'ui:vendor-inventory:open',
            HUNTMASTER:     'ui:huntmaster:open',
            MAPPINS:        'ui:map-pins:open',
          };
          const ev = map[tag];
          if (ev) bus.emit(ev, { payload });
        }
      }
    });
    // Resurrect-offer gump (Magery 8 Resurrection cast on local ghost).
    this._sub('ui:resurrect-offer:open', ({ caster }) => {
      this._toggleGump('resurrect-offer',
        async () => new (await lazyResurrectGump())({ net: this._net, caster }));
    });
    // Banker overlay — balance + check writer (Faza H.1.4).
    this._sub('ui:banker:open', ({ balance }) => {
      this._toggleGump('banker',
        async () => new (await lazyBankerGump())({ net: this._net, balance }));
    });
    // Community Collections ledger (Faza H.1.5).
    this._sub('ui:community:open', ({ rows }) => {
      this._toggleGump('community-collection',
        async () => new (await lazyCommunityGump())({ net: this._net, rows }));
    });
    // Ultima Store browser (Faza H.1.6).
    this._sub('ui:store:open', ({ payload }) => {
      this._toggleGump('ultima-store', async () => {
        const mod = await lazyUltimaStoreGump();
        const { balance, items } = mod.parseStorePayload(payload);
        return new mod.UltimaStoreGump({ net: this._net, balance, items });
      });
    });
    // Craft gump (Faza H.1.1).
    this._sub('ui:craft:open', ({ payload }) => {
      this._toggleGump('craft', async () => {
        const mod = await lazyCraftGump();
        const { skill, skillVal, recipes } = mod.parseCraftPayload(payload);
        return new mod.CraftGump({ net: this._net, skill, skillVal, recipes });
      });
    });
    // House ACL/Lockdown gump (Faza H.1.2).
    this._sub('ui:house-acl:open', ({ payload }) => {
      this._toggleGump('house-acl', async () => {
        const mod = await lazyHouseACLGump();
        return new mod.HouseACLGump({ net: this._net, payload });
      });
    });
    // Faza H.2 — wired-but-was-orphan gumps.
    this._sub('ui:help:open', () => {
      this._toggleGump('help', async () => new (await lazyHelpGump())({ net: this._net }));
    });
    this._sub('ui:guild-overlay:open', ({ payload }) => {
      this._toggleGump('guild-overlay', async () => {
        const [name, abbr, type, membersCsv] = (payload ?? '').split('||');
        const members = (membersCsv ?? '').split(';').filter(Boolean).map((row) => {
          const [n, online, rank] = row.split('|');
          return { name: n, online: online === '1', rank };
        });
        return new (await lazyGuildOverlay())({ net: this._net, guild: { name, abbr, type, members } });
      });
    });
    this._sub('ui:vendor-search:open', () => {
      this._toggleGump('vendor-search',
        async () => new (await lazyVendorSearchGump())({ net: this._net }));
    });
    this._sub('ui:virtue:open', ({ payload }) => {
      this._toggleGump('virtue', async () => {
        // Re-shape sentinel rows (key|val|rank) → VirtueGump state map.
        const state = {};
        for (const row of (payload ?? '').split(';').filter(Boolean)) {
          const [key, val, rank] = row.split('|');
          state[key] = { charges: 0, level: rank ?? '', value: val | 0 };
        }
        return new (await lazyVirtueGump())(state);
      });
    });
    this._sub('ui:krampus:open', ({ payload }) => {
      this._toggleGump('krampus', async () => {
        const [nice, naughty] = (payload ?? '0|0').split('|');
        return new (await lazyKrampusGump())({ net: this._net, nice: nice | 0, naughty: naughty | 0 });
      });
    });
    this._sub('ui:trick-or-treat:open', () => {
      this._toggleGump('trick-or-treat',
        async () => new (await lazyTotGump())({ net: this._net }));
    });
    this._sub('ui:casino:open', () => {
      this._toggleGump('casino',
        async () => new (await lazyCasinoGump())({ net: this._net }));
    });
    this._sub('ui:vvv:open', ({ payload }) => {
      this._toggleGump('vvv', async () => {
        const [view, side, pts, cities] = (payload ?? '|none|0|').split('|');
        const opts = { net: this._net, side, points: pts | 0, cities: (cities ?? '').split(',').filter(Boolean) };
        if (view === 'members')   return new (await lazyVvVExtraGumps()).VvVMemberListGump(opts);
        if (view === 'stats')     return new (await lazyVvVExtraGumps()).VvVStatisticsGump(opts);
        if (view === 'rewards')   return new (await lazyVvVExtraGumps()).VvVRewardStoreGump(opts);
        if (view === 'missions')  return new (await lazyVvVExtraGumps()).VvVMissionBoardGump(opts);
        if (view === 'standard')  return new (await lazyVvVExtraGumps()).VvVBattleStandardGump(opts);
        return new (await lazyVvVBattleGump())(opts);
      });
    });
    this._sub('ui:pet-training:open', ({ payload }) => {
      this._toggleGump('pet-training', async () => {
        // PetTrainingGump expects { petSerial, availablePoints, tricks? }.
        // Sentinel payload: <serialHex>|<name>|<level>|<pct>|<intoLevel>.
        const [serial, , level, , , available, learned] = (payload ?? '0|?|0').split('|');
        return new (await lazyPetTrainingGump())({
          net: this._net,
          petSerial: parseInt(serial, 16) >>> 0,
          availablePoints: available == null ? (level | 0) : (available | 0),
          learned: (learned ?? '').split(',').filter(Boolean),
        });
      });
    });
    this._sub('ui:mlquests-overlay:open', () => {
      // MLQuestsGump is self-installing — listens to `MLQ ` lines emitted
      // by `[mlq` server commands. Payload from sentinel is informational
      // only; the gump's own _refresh() handles its data.
      this._toggleGump('mlquests-overlay',
        async () => new (await lazyMLQuestsOverlay())());
    });
    this._sub('ui:achievements-panel:open', () => {
      // AchievementProgressGump self-installs via chat:system + parses
      // "  <key>  <value>" lines from `[achievements progress`.
      this._toggleGump('achievements-panel',
        async () => new (await lazyAchievementGump())());
    });
    this._sub('ui:large-bod:open', ({ payload }) => {
      this._toggleGump('large-bod', async () => {
        // LargeBodGump expects { net, bod: { label, slots[], ... }, serial }.
        const [serialHex, label, slotsCsv] = (payload ?? '||').split('||');
        const slots = (slotsCsv ?? '').split(';').filter(Boolean).map((row) => {
          const [material, done, slotLabel] = row.split('|');
          return { itemId: 0, label: slotLabel ?? material ?? '', done: done === '1' };
        });
        return new (await lazyLargeBodGump())({
          net: this._net,
          serial: parseInt(serialHex, 16) >>> 0,
          bod: { label: label ?? 'Large Bulk Order', slots, material: '', skill: 0, exceptional: false },
        });
      });
    });
    this._sub('ui:bod-rewards:open', () => {
      // BodRewardsGump self-installs via chat:system + parses REWARD lines.
      this._toggleGump('bod-rewards',
        async () => new (await lazyBodRewardsGump())());
    });
    this._sub('ui:racial-book:open', ({ payload }) => {
      this._toggleGump('racial-book',
        async () => new (await lazyRacialBookGump())(payload || 'human'));
    });
    this._sub('ui:death:open', () => {
      // Death gump: stamp by corpse.js when local player becomes ghost.
      this._toggleGump('death',
        async () => new (await lazyDeathGump())({ net: this._net }));
    });
    this._sub('ui:admin:open', () => {
      // AdminGump self-installs via chat:system bus. Sentinel emit
      // from `[admin gump`.
      this._toggleGump('admin',
        async () => new (await lazyAdminGump())());
    });
    this._sub('ui:player-vendor:open', ({ payload }) => {
      this._toggleGump(`player-vendor:${payload}`, async () => {
        // PlayerVendorGump self-installs via chat:system bus + populates
        // its rows from the server-emitted `PV ` lines.
        return new (await lazyPlayerVendorGump())();
      });
    });
    this._sub('ui:vendor-rental:open', () => {
      this._toggleGump('vendor-rental', async () => {
        const mod = await lazyVendorRentalGump();
        return new mod.VendorRentalGump();
      });
    });
    this._sub('ui:vendor-inventory:open', () => {
      this._toggleGump('vendor-inventory', async () => {
        const mod = await lazyVendorRentalGump();
        return new mod.VendorInventoryGump();
      });
    });
    // Huntmaster trophy display (Faza H.4).
    this._sub('ui:huntmaster:open', ({ payload }) => {
      this._toggleGump('huntmaster-trophy', async () => {
        const mod = await lazyHuntmasterGump();
        const parsed = mod.parseHuntmasterPayload(payload);
        return new mod.HuntmasterTrophyGump({ net: this._net, ...parsed });
      });
    });
    // Map pin editor (Faza H.5).
    this._sub('ui:map-pins:open', ({ payload }) => {
      this._toggleGump('map-pins', async () => {
        const mod = await lazyMapPinsGump();
        const parsed = mod.parseMapPinsPayload(payload);
        return new mod.MapPinEditorGump({ net: this._net ?? net, ...parsed });
      });
    });
    this._sub('nodeuo:spell-composer', ({ kind, requestId, payload }) => {
      if (kind !== NodeUOSpellComposerMessage.Open) return;
      this._toggleGump('spell-composer', async () => {
        const SpellComposerGump = await lazySpellComposer();
        return new SpellComposerGump({ requestId, payload });
      });
    });
    this._sub('nodeuo:specializations', ({ kind, requestId, payload }) => {
      if (kind !== NodeUOSpecializationMessage.Open) return;
      this._toggleGump('specializations', async () => {
        const SpecializationGump = await lazySpecializations();
        return new SpecializationGump({ requestId, payload });
      });
    });
    // Cooldowns are rendered directly on their action-bar slots. Do not open
    // a second free-floating "Cooldowns" window for every cast; it duplicated
    // the same state and frequently appeared as an empty, inert panel after
    // short cooldowns expired.
    const openMapGump = (info) => {
      const serial = info?.serial >>> 0;
      const key = `map:${serial}`;
      const existing = this._ui?.findGump?.((g) => g._toggleKey === key);
      if (existing) {
        existing.updateMapInfo?.(info);
        return;
      }
      this._toggleGump(key, async () => {
        const mod = await lazyMapPinsGump();
        return new mod.MapPinEditorGump({
          net: this._net ?? net,
          itemSerial: serial,
          width: Math.max(128, Math.min(640, info?.width | 0 || 320)),
          height: Math.max(128, Math.min(640, info?.height | 0 || 320)),
          x1: info?.x1 | 0,
          y1: info?.y1 | 0,
          x2: info?.x2 | 0,
          y2: info?.y2 | 0,
          pins: [],
        });
      });
    };
    this._sub('mapgump:display', openMapGump);
    this._sub('map:pin-update', openMapGump);
    const toggleProfileBool = (path, label) => {
      const next = profile.get(path) !== true;
      profile.set(path, next);
      this._appendJournal(`[system] ${label}: ${next ? 'on' : 'off'}`);
    };
    const setProfileBool = (path, value, label) => {
      const next = value === 'toggle' ? profile.get(path) !== true : value === true;
      profile.set(path, next);
      this._appendJournal(`[system] ${label}: ${next ? 'on' : 'off'}`);
    };
    this._sub('macro:toggle-roofs', () => toggleProfileBool('graphics.hideUnderRoof', 'Hide roofs'));
    this._sub('macro:toggle-trees-stumps', () => toggleProfileBool('ui.treeToStumps', 'Trees to stumps'));
    this._sub('macro:toggle-vegetation', () => toggleProfileBool('ui.hideVegetation', 'Hide vegetation'));
    this._sub('macro:toggle-grass', () => toggleProfileBool('ui.hideVegetation', 'Hide vegetation'));
    this._sub('macro:toggle-cave-tiles', () => toggleProfileBool('ui.enableCaveBorder', 'Cave borders'));
    this._sub('macro:range-color', ({ enabled, toggle } = {}) => {
      setProfileBool('graphics.noColorObjectsOutOfRange', toggle ? 'toggle' : enabled === true, 'No color out-of-range');
    });
    // Drag-with-mouse-down drop landed outside any gump → world drop.
    // UIManager fires this only when the press was inside a gump but
    // the release wasn't on any control (i.e. dropped onto the world
    // viewport). Mirrors CUO's "drag-from-bag-to-ground" gesture.
    this._sub('drag:dropped-on-world', ({ x, y }) => {
      if (!dragDrop.isHolding()) return;
      // ClassicUO `World.Player.PickUpItem` only commits a drop-to-
      // ground when the cursor is inside the game viewport AND within
      // pickup range of the player. Anything else — dropped onto the
      // chrome border, the paperdoll background, an empty gump body —
      // returns the held item to its source via 0x27 bounce. User
      // report 2026-05-19 "jak nie trafię w paperdoll item znika z
      // plecaka". The fix: gate the drop on (a) cursor inside the
      // camera-managed viewport rect, AND (b) target tile within the
      // 2-tile pickup reach. Otherwise reject (which restores to
      // origin container or paperdoll slot, never spawning on the
      // ground).
      const vx = camera.viewX | 0, vy = camera.viewY | 0;
      const vw = camera.viewW | 0, vh = camera.viewH | 0;
      if (x < vx || y < vy || x >= vx + vw || y >= vy + vh) {
        dragDrop.reject();
        return;
      }
      const tile = this._pickWorldTile(x, y);
      if (!tile || !world.player) { dragDrop.reject(); return; }
      const dx = Math.abs(tile.x - world.player.x);
      const dy = Math.abs(tile.y - world.player.y);
      if (Math.max(dx, dy) > 2) {
        dragDrop.reject();
        return;
      }
      dragDrop.dropToGround(tile.x, tile.y, tile.z);
    });
    // Book opens via 0xD4 (decodeOpenBook) → 'book:open' bus event.
    this._sub('book:open', (info) => {
      this._toggleGump(`book:${info.serial}`, async () => new (await lazyBook())(info));
    });
    // Bulletin-board: server can push 'bbs:open' explicitly, but the
    // first 'bbs:posts' arriving for a board also auto-opens the gump
    // if none is currently shown for that serial.
    this._sub('bbs:posts', (info) => {
      const key = `bulletin:${info.boardSerial >>> 0}`;
      if (this._ui.gumps.find((g) => g.type === key)) return;
      this._toggleGump(key, async () => new (await lazyBulletinBoard())(info.boardSerial));
    });
    // Mahjong: open on any inbound mahjong:state if no gump exists yet.
    this._sub('mahjong:state', (info) => {
      const key = `mahjong:${info.gameSerial >>> 0}`;
      if (this._ui.gumps.find((g) => g.type === key)) return;
      this._toggleGump(key, async () => new (await lazyMahjong())(info.gameSerial));
    });
    // House customization: server may emit a 'house:custom' (0xD8)
    // payload announcing edit-mode entry; surface the editor gump.
    this._sub('house:custom', (info) => {
      if (!info?.serial) return;
      this._toggleGump(`house-cust:${info.serial}`, async () => new (await lazyHouseCustom())(info.serial));
    });
    // Profile: 0xB8 reply.
    this._sub('profile:open', (info) => {
      this._toggleGump(`profile:${info.serial}`, async () => new (await lazyProfile())({
        ...info, editable: info.serial === world.player?.serial,
      }));
    });
    // Grid-loot: when a corpse opens (0x24 displayContainer for itemId
    // 0x2006), prefer GridLootGump over generic ContainerGump if the
    // user has the toggle on.
    this._sub('container:open', (info) => {
      // Last-opened container (any kind) — consumed by the
      // `open-text-container` macro so the alt-mode list view can
      // re-render whatever the player most recently popped open.
      this._lastContainerSerial = info.serial >>> 0;
      const it = world.items.get(info.serial >>> 0);
      if (it?.itemId === 0x2006) {
        // Remember the last opened corpse so the macro `open-corpse-filter`
        // can re-spawn the filter gump on demand (without a fresh
        // double-click that would replay the LiftReq pacing window).
        this._lastCorpseSerial = info.serial >>> 0;
        if (profile.get('ui.corpseFilterGump') === true) {
          this._toggleGump(`corpse-filter:${info.serial}`, async () => {
            const { OpenedCorpseGump } = await import('../ui/gumps/opened-corpse-gump.js');
            return new OpenedCorpseGump(info.serial);
          });
          return;
        }
        if (profile.get('ui.gridLoot') === true) {
          this._toggleGump(`grid-loot:${info.serial}`, async () => new (await lazyGridLoot())(info.serial));
          return;
        }
      }
      // fall through — base handler in _onContainerOpen renders the
      // standard ContainerGump.
    });
    // Bus-driven gump openers — invoked by chat commands or remote
    // server pushes that don't have a dedicated wire opcode.
    this._sub('gump:credits', () => {
      this._toggleGump('credits', async () => new (await lazyCredits())());
    });
    this._sub('gump:race-change', () => {
      this._toggleGump('race-change', async () => new (await lazyRaceChange())());
    });
    // Audit #46 P2 — server-driven race-change prompt (0xBF 0x2A from
    // handlers.js:1395). Pops the canonical 3-button picker as a modal;
    // selection sends 0xBF 0x2B reply via buildChangeRaceResponse.
    this._sub('race:change-prompt', async (info = {}) => {
      const { showRaceChange } = await import('../ui/gumps/race-change-gump.js');
      try {
        await showRaceChange({ female: !!info.female, current: info.race });
      } catch { /* ignore */ }
    });
    // Audit #46 P2 — chat enter-username prompt (cmd 0x03EB). Server
    // asks for the player's chat handle before joining channels.
    this._sub('chat:enter-username', async () => {
      const { showChatChooseName } = await import('../ui/gumps/chat-choose-name-gump.js');
      try { showChatChooseName({}); } catch { /* ignore */ }
    });
    // Audit rev.9 P2 #7 — name-overhead label clicked → pop the
    // draggable quick-action popup (Atk/Use/Look/Menu). NameOverhead
    // manager handles the click → bus event so the gump module stays
    // a lazy import.
    this._sub('name-overhead:click', async ({ serial } = {}) => {
      if (!serial) return;
      const { NameOverheadPopupGump } = await import('../ui/gumps/name-overhead-popup-gump.js');
      // Each mob gets one popup; close-then-open is a sane toggle.
      const id = `name-popup:${(serial >>> 0).toString(16)}`;
      this._toggleGump(id, () => new NameOverheadPopupGump(serial));
    });
    this._sub('gump:inspector', () => {
      this._toggleGump('inspector', async () => new (await lazyInspector())());
    });
    this._sub('gump:chat', () => {
      this._toggleGump('chat', async () => new (await lazyChat())());
    });
    this._sub('gump:network-stats', () => {
      this._toggleGump('network-stats', async () => new (await lazyNetworkStats())());
    });
    this._sub('gump:user-marker', async ({ marker, onSave } = {}) => {
      const { UserMarkerGump } = await import('../ui/gumps/user-marker-gump.js');
      this._toggleGump(`user-marker:${marker?.id ?? 'new'}`,
        () => new UserMarkerGump(marker ?? {}, onSave));
    });
    this._sub('gump:macro-button', async ({ macro, x, y } = {}) => {
      const { MacroButtonGump } = await import('../ui/gumps/macro-button-gump.js');
      if (!this._ui) return;
      const g = new MacroButtonGump(macro, x ?? 240, y ?? 240);
      g._toggleKey = `macro-button:${macro?.id ?? macro?.name ?? Math.random()}`;
      this._ui.addGump(g);
    });
    // Macro extensions added in N+2.
    this._sub('macro:open-backpack', () => {
      const pack = world.player?.equipment?.get?.(21);
      if (pack) net.send(buildUseReq(pack.serial));
    });
    this._sub('macro:walk', ({ direction, dir, run } = {}) => {
      const d = Number.isFinite(direction) ? direction : dir;
      if (!Number.isFinite(d)) return;
      this._sendMove(d & 7, !!run);
    });
    // CUO `TargetSelectedObject` cycle. The macro runner emits with an
    // optional `kind`: 'friend' | 'enemy' | undefined (= any non-self).
    // Mirrors CUO's `TargetNextEnemy` / `TargetNextFriend` macros where
    // notoriety drives the ally/enemy split.
    const cycleTarget = ({ kind, dir }) => {
      if (!world.player) return;
      const me = world.player;
      const inRing = (m) => {
        if (m === me) return false;
        if ((m.hp ?? 0) <= 0) return false;
        if (m.map !== me.map) return false;
        if (Math.max(Math.abs(m.x - me.x), Math.abs(m.y - me.y)) > 18) return false;
        const noto = m.notoriety ?? 1;
        if (kind === 'friend') return noto === 1 || noto === 2;
        if (kind === 'enemy')  return noto >= 3;
        return true;
      };
      const last = (this._lastTargetNext ?? targetManager.lastTarget?.serial ?? 0) >>> 0;
      let first = null;
      let final = null;
      let nextHigher = null;
      let prevLower = null;
      const visit = (m) => {
        if (!inRing(m)) return undefined;
        const serial = m.serial >>> 0;
        if (!first || serial < (first.serial >>> 0)) first = m;
        if (!final || serial > (final.serial >>> 0)) final = m;
        if (serial > last && (!nextHigher || serial < (nextHigher.serial >>> 0))) nextHigher = m;
        if (serial < last && (!prevLower || serial > (prevLower.serial >>> 0))) prevLower = m;
        return undefined;
      };
      // Stable serial-ordered ring so prev/next are deterministic.
      if (world.forEachMobileNear) {
        world.forEachMobileNear(me.x, me.y, me.map ?? world.mapId ?? 1, 18, true, visit);
      } else {
        const nearby = world.mobilesNear
          ? world.mobilesNear(me.x, me.y, me.map ?? world.mapId ?? 1, 18, true)
          : world.mobiles.values();
        for (const m of nearby) visit(m);
      }
      const next = dir === -1 ? (prevLower ?? final) : (nextHigher ?? first);
      if (!next) return;
      this._lastTargetNext = next.serial >>> 0;
      // Audit #41 client P1 #6 — `setLastSerial` is undefined; the
      // canonical field is `lastTarget`. Stamp via the canonical setter so
      // attack-last / cast-last-on-last route to the freshly-picked mob.
      targetManager.lastTarget = { serial: next.serial >>> 0 };
      bus.emit('chat:system', {
        text: `Target: ${next.name ?? '0x' + next.serial.toString(16)}`,
      });
      bus.emit('target:cycle-changed', { serial: next.serial >>> 0, kind });
    };
    this._sub('macro:target-next', ({ kind } = {}) => cycleTarget({ kind, dir: +1 }));
    this._sub('macro:target-prev', ({ kind } = {}) => cycleTarget({ kind, dir: -1 }));

    // Screen shake — handlers emit `camera:shake` from explosion / earthquake
    // graphic-effect handlers; we forward to the singleton camera which
    // decays the offset in `apply()`. CUO mirror: `Camera.Shake`.
    this._unsubs.push(
      bus.on('camera:shake', ({ magnitude, durationMs }) => {
        camera.shake?.(magnitude ?? 6, durationMs ?? 220);
      }),
    );

    // Gargoyle flying toggle — Stygian Abyss racial. Sends 0xBF 0x32
    // ToggleGargoyleFlying upstream and optimistically flips the local
    // `isFlying` flag so the renderer picks up the new pose this frame.
    // The renderer's animation resolver routes `Action.Fly*` for flying
    // gargoyles; non-gargoyle bodies silently ignore the flag.
    this._sub('macro:toggle-fly', () => {
      if (!world.player) return;
      // Only Gargoyle bodies (0x029A male / 0x029B female) can fly. CUO
      // suppresses the request server-side anyway, but skipping it
      // client-side keeps non-gargoyles from desyncing their pose.
      const body = world.player.body | 0;
      if (body !== 0x029A && body !== 0x029B) {
        bus.emit('chat:system', { text: 'Only gargoyles can fly.' });
        return;
      }
      world.player.isFlying = !world.player.isFlying;
      try {
        net.send(buildToggleGargoyleFlying());
      } catch { /* socket transient */ }
    });
    // Right-click context menus (0xBF 0x14). Server replies to our
    // 0xBF 0x15 with a list of cliloc'd entries; show them in a small
    // DOM menu at the click coords. CUO renders this as a Pixi gump
    // (PopupMenuGump.cs) — DOM is much cheaper for the same UX.
    this._sub('popup:show', (info) => {
      // Native Pixi context menu — replaces the older DOM popup. Spawn at
      // the cursor position we stashed on the right-click. The DOM
      // fallback (`_showPopupMenu`) is still around for emergencies but
      // no longer wired by default.
      if (!info?.entries?.length || !this._ui) return;
      const rawX = this._lastRClickX ?? 200;
      const rawY = this._lastRClickY ?? 200;
      // PointerEvent coordinates are physical CSS pixels; Pixi gumps use the
      // UI manager's unscaled logical space. Mixing them displaced menus as
      // soon as UI scale differed from 1.
      const anchor = this._ui.screenToLogical?.(rawX, rawY) ?? { x: rawX, y: rawY };
      const sx = anchor.x;
      const sy = anchor.y;
      const existing = this._ui.findGump((g) => g._toggleKey === 'popup-menu');
      if (existing) this._ui.removeGump(existing);
      const g = new PopupMenuGump(info, sx, sy);
      g._toggleKey = 'popup-menu';
      const logicalW = (window.innerWidth || 1024) / (this._ui.scale || 1);
      const logicalH = (window.innerHeight || 768) / (this._ui.scale || 1);
      g.setPosition(
        Math.max(4, Math.min(sx, logicalW - g.width - 4)),
        Math.max(4, Math.min(sy, logicalH - g.height - 4)),
      );
      this._ui.addGump(g);
    });
    this._sub('popup:anchor', ({ x, y } = {}) => {
      if (Number.isFinite(x)) this._lastRClickX = x;
      if (Number.isFinite(y)) this._lastRClickY = y;
    });
    this._sub('macro:close-all-gumps', () => {
      // Don't dispose the manager — just remove every open gump.
      if (this._ui) {
        while (this._ui.gumps.length) {
          this._ui.removeGump(this._ui.gumps[this._ui.gumps.length - 1]);
        }
      }
    });
    // Client audit #6 #8 — wire dead-letter macro events. ServUO macro
    // intents that emitted bus events but had no consumer.
    this._sub('macro:arm-disarm', () => {
      // Toggle war mode — same path as Ctrl-W. Server reflects via 0x72.
      const wm = !world.player?.warMode;
      try {
        net.send(buildWarMode(wm));
      } catch { /* ignore */ }
    });
    this._sub('macro:equip-last', () => {
      // Re-lift + drop the last weapon from pack onto layer-1.
      const pack = world.player?.equipment?.get?.(21);
      const lastSerial = this._lastWeaponSerial;
      if (!pack || !lastSerial) return;
      const w = world.items.get(lastSerial);
      if (!w || w.parent !== pack.serial) return;
      try {
        net.send(buildLiftReq(w.serial, 1));
        // Drop onto self for layer auto-resolve.
        net.send(buildDropReq(w.serial, 0xFFFF, 0xFFFF, 0, 1, world.player.serial >>> 0));
      } catch { /* ignore */ }
    });
    // Audit #40 deferred (client P1 #5) — wire the highest-impact macro
    // events so the hotkeys actually do something. The rest of the
    // orphan emits (~30) stay deferred — most are CUO-specific UI
    // toggles that don't map to anything in this client yet.
    this._sub('macro:target-closest', ({ serial }) => {
      if (!serial) return;
      bus.emit('combat:target', { serial });
      if (targetManager) targetManager.lastTarget = { serial };
    });
    this._sub('macro:all-attack', () => {
      // CUO "All Attack" — send Attack on every non-innocent mobile the
      // client knows about within 12 tiles. Best-effort: server filters
      // any that aren't actually attackable.
      const me = world.player;
      if (!me) return;
      let n = 0;
      const visit = (m) => {
        if (!m || m === me || (m.hp ?? 0) <= 0) return undefined;
        if (m.map !== me.map) return undefined;
        const noto = m.notoriety ?? 1;
        if (noto === 1 || noto === 2) return undefined;     // skip innocent/ally
        if (Math.abs(m.x - me.x) > 12 || Math.abs(m.y - me.y) > 12) return undefined;
        try { net.send(buildAttackReq(m.serial)); n++; } catch { return false; }
        return n < 8;     // sanity cap — avoid 100-pkt burst
      };
      if (world.forEachMobileNear) {
        world.forEachMobileNear(me.x, me.y, me.map ?? world.mapId ?? 1, 12, true, visit);
      } else {
        const nearby = world.mobilesNear
          ? world.mobilesNear(me.x, me.y, me.map ?? world.mapId ?? 1, 12, true)
          : world.mobiles.values();
        for (const m of nearby) {
          if (visit(m) === false) break;
        }
      }
    });
    this._sub('macro:stop-movement', () => {
      // Drop held arrow keys + mouse-walk latch.
      this._heldDirs?.clear();
      this._heldDirsRun = false;
      this._mouseHeld = false;
    });
    this._sub('macro:cycle', ({ kind }) => {
      // Walk visible mobiles in serial order and pick the next one
      // matching the requested category. Wrap around.
      const me = world.player;
      if (!me) return;
      const isMatch = (m) => {
        const noto = m.notoriety ?? 1;
        if (kind === 'hostile')    return noto >= 3;
        if (kind === 'beneficial') return noto === 1 || noto === 2;
        return true;     // 'object' = any
      };
      const last = targetManager?.lastTarget?.serial >>> 0;
      let first = null;
      let nextHigher = null;
      const visit = (m) => {
        if (!m || m === me || (m.hp ?? 0) <= 0 || m.map !== me.map) return undefined;
        if (Math.abs(m.x - me.x) > 18 || Math.abs(m.y - me.y) > 18) return undefined;
        if (!isMatch(m)) return undefined;
        const serial = m.serial >>> 0;
        if (!first || serial < (first.serial >>> 0)) first = m;
        if (serial > last && (!nextHigher || serial < (nextHigher.serial >>> 0))) nextHigher = m;
        return undefined;
      };
      if (world.forEachMobileNear) {
        world.forEachMobileNear(me.x, me.y, me.map ?? world.mapId ?? 1, 18, true, visit);
      } else {
        const nearby = world.mobilesNear
          ? world.mobilesNear(me.x, me.y, me.map ?? world.mapId ?? 1, 18, true)
          : world.mobiles.values();
        for (const m of nearby) visit(m);
      }
      const next = nextHigher ?? first;
      if (next) {
        targetManager.lastTarget = { serial: next.serial };
        bus.emit('combat:target', { serial: next.serial });
      }
    });
    // Audit #41 deferred — additional orphan macro emits.
    this._sub('macro:target-mount', () => {
      // Pick the player's currently-equipped mount (layer 25).
      const me = world.player;
      if (!me) return;
      const mountSerial = me.equipment?.get?.(25)?.serial >>> 0;
      if (mountSerial) {
        targetManager.lastTarget = { serial: mountSerial };
        bus.emit('chat:system', { text: 'Target: your mount.' });
      } else {
        bus.emit('chat:system', { text: 'You have no mount.' });
      }
    });
    this._sub('macro:target-pet', () => {
      // Pick the first pet within 18 tiles owned by the player.
      const me = world.player;
      if (!me) return;
      let found = null;
      const visit = (m) => {
        if (m === me) return undefined;
        if (m.controlMaster !== me.serial) return undefined;
        if (m.map !== me.map) return undefined;
        if (Math.abs(m.x - me.x) > 18 || Math.abs(m.y - me.y) > 18) return undefined;
        found = m;
        return false;
      };
      if (world.forEachMobileNear) {
        world.forEachMobileNear(me.x, me.y, me.map ?? world.mapId ?? 1, 18, true, visit);
      } else {
        const nearby = world.mobilesNear
          ? world.mobilesNear(me.x, me.y, me.map ?? world.mapId ?? 1, 18, true)
          : world.mobiles.values();
        for (const m of nearby) {
          if (visit(m) === false) break;
        }
      }
      if (found) {
        targetManager.lastTarget = { serial: found.serial };
        bus.emit('chat:system', { text: `Target: ${found.name ?? 'pet'}.` });
        return;
      }
      bus.emit('chat:system', { text: 'No pets nearby.' });
    });
    this._sub('macro:release-pet', () => {
      // Speech-driven "all release" — most reliable cross-shard path.
      const me = world.player;
      if (!me) return;
      try { net.send(buildUnicodeSpeech?.('all release', { type: 0x00, hue: 0x33 })); }
      catch { /* speech builder optional */ }
    });
    this._sub('macro:loot-corpse', () => {
      // Find the nearest corpse (itemId 0x2006) on the ground within 2
      // tiles and open it. The server handles the actual reach check.
      const me = world.player;
      if (!me) return;
      let corpseSerial = 0;
      const visit = (it) => {
        if (it.itemId !== 0x2006) return undefined;
        if (it.parent) return undefined;
        if (Math.abs(it.x - me.x) > 2 || Math.abs(it.y - me.y) > 2) return undefined;
        corpseSerial = it.serial >>> 0;
        return false;
      };
      if (world.forEachItemNear) {
        world.forEachItemNear(me.x, me.y, me.map ?? world.mapId ?? 1, 2, visit);
      } else {
        const nearby = world.itemsNear
          ? world.itemsNear(me.x, me.y, me.map ?? world.mapId ?? 1, 2)
          : world.items.values();
        for (const it of nearby) {
          if (visit(it) === false) break;
        }
      }
      if (corpseSerial) {
        useItemQueue.enqueue(corpseSerial);
        return;
      }
      bus.emit('chat:system', { text: 'No corpse within reach.' });
    });
    this._sub('macro:smart-bandage', () => {
      // If self HP < 60%, bandage self; else target last attacker.
      const me = world.player;
      if (!me) return;
      const frac = (me.hp ?? 0) / Math.max(1, me.hpMax ?? 1);
      // Audit #40 client P1 #3 — `_lastSerial` never existed on
      // TargetManager. The canonical field is `lastTarget.serial`.
      const lastSerial = targetManager?.lastTarget?.serial >>> 0;
      const target = frac < 0.60 ? me : (lastSerial
        ? world.mobiles.get(lastSerial) : me);
      bus.emit('macro:bandage-target', { serial: (target ?? me).serial });
    });
    // Touching macroManager once ensures its constructor runs.
    void macroManager;
    this._sub('audio:sfx', ({ sound, x, y, map, ambient, volume = 1 }) => {
      // Forward positional info so distance attenuation + L/R pan kick
      // in. Earlier code dropped x/y/z and called the non-positional
      // path, which made every sound full-volume centred regardless of
      // source. Falls back to the flat play() when the packet didn't
      // carry coords (rare).
      if (ambient) {
        audio.play(sound, volume);
      } else if (Number.isFinite(x) && Number.isFinite(y)) {
        try { audio.playAt?.(sound, x, y, map ?? world.player?.map ?? world.mapId); }
        catch { audio.play(sound, volume); }
      } else {
        audio.play(sound, volume);
      }
    });
    this._sub('player:warmode', ({ warMode }) => { this._warMode = warMode; this._refreshHud(); });
    this._sub('chat:system', ({ text }) => {
      // Suppress server-driven gump-bridge markers — they're internal
      // protocol that scenes/game-scene.js parses elsewhere to spawn
      // the matching gump (craft / banker / stable / …). Letting them
      // through prints the raw recipe blob ("@@OPEN_CRAFT_GUMP@@…")
      // into the chat strip (user report 2026-05-17).
      if (typeof text === 'string'
          && text.startsWith('@@OPEN_') && text.includes('_GUMP@@')) return;
      this._appendJournal(`[system] ${text}`);
    });
    // Audit #41 client P2 #12 — party-manager emits `party:invite` but
    // no subscriber popped the gump → invites surfaced only as a
    // system message. Wire to the existing `showPartyInvite` helper.
    this._sub('party:invite', (info) => {
      import('../ui/gumps/party-invite-gump.js')
        .then((mod) => mod.showPartyInvite?.({
          leaderSerial: info.leader >>> 0,
          leaderName: world.mobiles?.get?.(info.leader)?.name,
        }))
        .catch(() => { /* gump module missing in build */ });
    });
    // Audit #43 client P1 #11 — 0xCB is `GlobalQueCount` (help-queue
    // position), NOT gold. The handler now emits `help:queue-position`
    // directly. The old `reward:gold` subscriber was based on a wrong
    // assumption about the opcode semantics.
    this._sub('help:queue-position', ({ position }) => {
      this._appendJournal(`[help] You are #${position} in line.`);
    });
    // On unexpected disconnect, swap back to the LoginScene so the user
    // can reconnect cleanly. Avoid recursion if we're already unloading.
    this._sub('net:close', () => this._onDisconnected());

    document.addEventListener('keydown', this._onKey);
    document.addEventListener('keyup',   this._onKeyUp);
    document.addEventListener('mousemove',  this._onMouseMove);
    document.addEventListener('mouseleave', this._onMouseLeave);
    document.addEventListener('mousedown',  this._onMouseDown);
    document.addEventListener('mouseup',    this._onMouseUp);
    document.addEventListener('contextmenu', this._onContextMenu);
    window.addEventListener('pointermove',  this._onResizeMove);
    window.addEventListener('pointerup',    this._onResizeEnd);
    // Touch — pinch-zoom (two-finger) + long-press as RMB equivalent.
    // We listen on the canvas (touch events bubble through to window)
    // with passive: false so preventDefault can suppress the system
    // scroll/zoom gesture in the gameplay rect.
    document.addEventListener('touchstart',  this._onTouchStart, { passive: false });
    document.addEventListener('touchmove',   this._onTouchMove,  { passive: false });
    document.addEventListener('touchend',    this._onTouchEnd,   { passive: false });
    document.addEventListener('touchcancel', this._onTouchEnd,   { passive: false });
    // Audit #39 client P3 #13 — Mac trackpad pinch fires
    // `gesturestart` / `gesturechange` / `gestureend` (Safari/WebKit
    // events), separate from `wheel`. Without this listener the
    // browser silently swallowed the gesture on a MBP, leaving
    // pinch-zoom non-functional. Step per ~5 % scale delta.
    this._gestureBaseScale = 1;
    this._onGestureStart  = (e) => { e.preventDefault(); this._gestureBaseScale = 1; };
    this._onGestureChange = (e) => {
      e.preventDefault();
      const ds = e.scale / this._gestureBaseScale;
      if (Math.abs(ds - 1) > 0.05) {
        if (ds > 1) camera.zoomIn(); else camera.zoomOut();
        this._gestureBaseScale = e.scale;
      }
    };
    const canvas = this.gc.app.canvas;
    canvas.addEventListener('gesturestart',  this._onGestureStart,  { passive: false });
    canvas.addEventListener('gesturechange', this._onGestureChange, { passive: false });
    // Client audit #3 #3 — Alt-Tab / window blur swallows the keyup,
    // leaving the avatar marching forever. Clear held dirs on blur or
    // when the tab visibility flips off.
    this._onBlur = () => {
      if (this._heldDirs) this._heldDirs.clear();
      this._heldDirsRun = false;
      // Client audit #7 #2 — also clear mouse-hold (RMB-walk). Synthetic
      // mouse-up never arrives on Alt-Tab so the avatar marched forever.
      this._mouseHeld = false;
      this._mouseShift = false;
      this._peekPanActive = false;
      camera.resetPan?.();
    };
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._onBlur();
    });

    this._refreshHud();
    this.gc.setStatus(`in world — serial 0x${(world.player?.serial ?? 0).toString(16)}`);
  }

  unload() {
    camera.resetPan?.();
    if (this._onBlur) window.removeEventListener('blur', this._onBlur);
    document.removeEventListener('keydown', this._onKey);
    document.removeEventListener('keyup',   this._onKeyUp);
    document.removeEventListener('mousemove',  this._onMouseMove);
    document.removeEventListener('mouseleave', this._onMouseLeave);
    document.removeEventListener('mousedown',  this._onMouseDown);
    document.removeEventListener('mouseup',    this._onMouseUp);
    document.removeEventListener('contextmenu', this._onContextMenu);
    document.removeEventListener('touchstart',  this._onTouchStart);
    document.removeEventListener('touchmove',   this._onTouchMove);
    document.removeEventListener('touchend',    this._onTouchEnd);
    document.removeEventListener('touchcancel', this._onTouchEnd);
    try {
      const canvas = this.gc.app.canvas;
      if (this._onGestureStart)  canvas.removeEventListener('gesturestart',  this._onGestureStart);
      if (this._onGestureChange) canvas.removeEventListener('gesturechange', this._onGestureChange);
    } catch { /* canvas may be gone */ }
    window.removeEventListener('pointermove',  this._onResizeMove);
    window.removeEventListener('pointerup',    this._onResizeEnd);
    if (this._onWheel) {
      this.gc.app.canvas.removeEventListener('wheel', this._onWheel);
      this._onWheel = null;
    }
    for (const u of this._unsubs) u();
    this._unsubs.length = 0;
    uiManagerInstance.set(null);
    this._ui?.destroy();
    this._tiles?.destroy();
    this._mobiles?.destroy();
    this._effects?.destroy();
    this._worldText?.destroy();
    this._light?.destroy();
    this._multiGhost?.destroy();
    this._spellRangePreview?.destroy();
    this._navalRangePreview?.destroy();
    this._healthLines?.destroy();
    this._cmdPanel?.destroy();
    this._adminPanelLink?.destroy?.();
    this._adminPanelLink = null;
    this._weather?.destroy();
    this._deathScreen?.destroy();
    questArrow.clear();
    this._backdrop?.destroy();
    this._mask?.destroy();
    this._frame?.destroy();
    if (this.gc.world) this.gc.world.mask = null;
    tooltips.hide();
    this._hud?.remove();
    this._hudBody = null;
    this._journal?.remove();
    this._journal = null;
    this._journalBody = null;
    this._chatInput?.parentElement?.remove();
    this.gc.world.removeChildren();
    this.gc.ui.removeChildren();
  }

  resize(w, h) {
    camera.setViewport(w, h);
    this._redrawViewportFrame();
  }

  /** Create a small square Pixi button with a single-character glyph.
   *  Used for the zoom +/- buttons. The button is positioned each frame
   *  by `_redrawViewportFrame` so it stays anchored to the viewport. */
  _makeZoomButton(glyph, onClick) {
    const Pixi = this._Pixi;
    const btn = new Pixi.Container();
    btn.eventMode = 'static';
    btn.cursor = 'pointer';
    const bg = new Pixi.Graphics();
    btn.addChild(bg);
    const label = new Pixi.Text({ text: glyph, style: { fontFamily: 'Arial', fontSize: 18, fill: 0xfff0c0, fontWeight: 'bold' } });
    label.anchor.set(0.5);
    label.position.set(13, 13);
    btn.addChild(label);
    btn._bg = bg;
    btn._label = label;
    btn.hitArea = new Pixi.Rectangle(0, 0, 26, 26);
    const repaint = (hover) => {
      bg.clear()
        .roundRect(0, 0, 26, 26, 4)
        .fill({ color: hover ? 0x8a6a30 : 0x3a2a10, alpha: 0.9 })
        .stroke({ width: 1, color: 0xfff0c0, alpha: 0.9 });
    };
    repaint(false);
    btn.on('pointerover', () => repaint(true));
    btn.on('pointerout',  () => repaint(false));
    btn.on('pointertap',  (e) => { e.stopPropagation(); onClick(); });
    return btn;
  }

  /** (Re)paint the gameplay rectangle backdrop + mask + frame + handle
   *  to match the camera's current viewport. */
  _redrawViewportFrame() {
    if (!this._backdrop || !this._Pixi) return;
    const x = camera.viewX, y = camera.viewY;
    const w = camera.viewW, h = camera.viewH;
    const screenW = this.gc.app.screen.width || window.innerWidth;
    const screenH = this.gc.app.screen.height || window.innerHeight;
    const leftW = Math.max(0, x - 12);
    const rightX = x + w + 12;
    const rightW = Math.max(0, screenW - rightX);
    const autoHide = !!profile.get('ui.autoHideEmptyPanels');
    const compact = !!profile.get('ui.compactSidePanels');
    const occupancy = autoHide ? this._sideRailOccupancy(x, x + w) : { left: true, right: true };
    const backdrop = this._backdrop.clear()
      .rect(0, 0, screenW, screenH).fill(0x070b10);
    // Quiet side rails give journals, paperdolls and diagnostics a visual
    // home without turning the full Pixi surface into a blue empty map.
    // Skip collapsed rails entirely: a negative/zero roundRect is undefined
    // in WebGL tessellation and was itself capable of producing long spikes.
    if (leftW > 12 && occupancy.left) {
      backdrop.roundRect(6, 6, leftW, Math.max(0, screenH - 72), 8)
        .fill({ color: 0x0c131b, alpha: compact ? 0.86 : 0.96 })
        .stroke({ width: 1, color: 0x263443, alpha: 0.72 });
    }
    if (rightW > 12 && occupancy.right) {
      backdrop.roundRect(rightX, 6, rightW - 6, Math.max(0, screenH - 72), 8)
        .fill({ color: 0x0c131b, alpha: compact ? 0.86 : 0.96 })
        .stroke({ width: 1, color: 0x263443, alpha: 0.72 });
    }
    backdrop.rect(x, y, w, h).fill(0x143a5a);
    this._mask.clear().rect(x, y, w, h).fill(0xffffff);
    this._frame.clear()
      .roundRect(x - 5, y - 5, w + 10, h + 10, 7)
      .stroke({ width: 3, color: 0x000000, alpha: 0.72 })
      .rect(x - 2, y - 2, w + 4, h + 4)
      .stroke({ width: 2, color: 0x9a7430, alpha: 0.92 })
      .rect(x, y, w, h)
      .stroke({ width: 1, color: 0xe1bd63, alpha: 0.28 });
    if (this._resizeHandle) {
      this._resizeHandle.clear()
        .poly([x + w - 16, y + h, x + w, y + h, x + w, y + h - 16], true)
        .fill({ color: 0x6e5520, alpha: 0.95 })
        .stroke({ width: 1, color: 0xfff0c0, alpha: 0.9 });
      this._resizeHandle.hitArea = new this._Pixi.Rectangle(x + w - 22, y + h - 22, 24, 24);
    }
    if (this._zoomInBtn) {
      this._zoomInBtn.position.set(x + w - 32, y + 6);
      this._zoomOutBtn.position.set(x + w - 64, y + 6);
    }
  }

  update(dt, now = performance.now()) {
    if (!world.player) return;
    const frameDt = dt ?? 1 / 60;
    // Camera tracks the PLAYER'S VISUAL position. While a walk step
    // is in progress, world.player.offsetX/Y are non-zero and the
    // camera (and the player sprite) lerp together — without this
    // the map would jump a full tile per ack.
    const p = world.player;
    camera.followWithOffset(p.x, p.y, p.z, p.offsetX, p.offsetY);
    // Client perf round 2 #14: per-frame `setViewport(innerW, innerH)`
    // was pointless work — `resize(w, h)` already covers it on every
    // window resize via game-controller's `resize` listener.
    camera.apply(this.gc.world);

    const r = camera.visibleTileRadius();
    // `_tiles` / `_mobiles` are constructed inside `load()`. The game
    // controller can tick the scene one extra frame between scene-swap
    // and load-resolved (e.g. after a relog), so the first frame sees
    // a freshly-constructed GameScene with the renderers still null —
    // skip rather than crash. Same null-window applies during destroy.
    if (!this._tiles || !this._mobiles) return;
    this._tiles.update(world.player.x, world.player.y, r, now, {
      viewW: camera.viewW,
      viewH: camera.viewH,
      zoom: camera.zoom,
      centerZ: world.player.z,
    });
    this._mobiles.update(frameDt, now);
    this._effects?.tick(frameDt, now);
    if (this._worldText?.hasActive?.()) this._worldText.tick(frameDt, now);
    // Dim rect tracks the gameplay viewport rect (managed by
    // camera.setViewport) rather than the full browser window — so the
    // night overlay never bleeds past the play area into the chrome
    // beside / below the canvas, and so it always sits inside the
    // visible game rect even when the user drag-resizes it.
    lightPoints.tick(now);
    this._light?.tick(
      camera.viewX | 0, camera.viewY | 0,
      camera.viewW | 0, camera.viewH | 0,
      lightPoints.visibleApertures?.(),
    );
    this._healthLines?.draw(now);
    if (nameOverheadManager.hasActive?.()) nameOverheadManager.tick(now);
    if (worldTextManager.hasActive?.()) worldTextManager.tick(now);
    if (questArrow.hasTarget?.()) questArrow.update(this.gc.ui);
    // Audit #40 client P1 #2 — pump the useItemQueue. CUO drives this
    // from `Engine.Update`; we never called it, so the queue manager
    // was completely dead and stacked 0x06 spam went out un-throttled
    // (potion chug → two 0x06 fly back-to-back, server drops one).
    useItemQueue.tick(now);
    // Multi placement ghost: snap to tile under cursor while target mode
    // is multi. Hide otherwise.
    if (this._multiGhost) {
      const playerScreenX = (camera.viewX | 0) + (camera.viewW | 0) / 2;
      const playerScreenY = (camera.viewY | 0) + (camera.viewH | 0) / 2;
      const multi = targetManager.multi;
      const tile = (targetManager.multi && this._mouseInside)
        ? this._pickWorldTile(playerScreenX + this._mouseDx,
                              playerScreenY + this._mouseDy)
        : null;
      const ghostKey = (multi && tile)
        ? `${multi.multiId}|${multi.hue ?? 0}|${tile.x}|${tile.y}|${tile.z}`
        : '';
      if (ghostKey !== this._multiGhostKey) {
        this._multiGhostKey = ghostKey;
        this._multiGhost.update(tile).catch(() => { /* ignore */ });
      }
    }
    if (this._spellRangePreview?.active) {
      const playerScreenX = (camera.viewX | 0) + (camera.viewW | 0) / 2;
      const playerScreenY = (camera.viewY | 0) + (camera.viewH | 0) / 2;
      const hovered = this._mouseInside
        ? this._pickWorldTile(playerScreenX + this._mouseDx, playerScreenY + this._mouseDy)
        : null;
      this._spellRangePreview.update(world.player, hovered);
    }
    if (this._navalRangePreview?.active) this._navalRangePreview.update(now);

    // Per-frame tick for any gump that opted in (minimap, worldmap).
    if (this._ui) {
      this._ui.tick?.(frameDt, now);
      const tickGumps = this._ui.tickGumps ?? this._ui.gumps;
      for (const g of tickGumps) g.tick?.(frameDt, now);
    }

    this._maybeMouseWalk(now);
    this._tickHeldKeyWalk(now);
    this._tickAutowalk(now);
    this._tickRegionDetect(now);
    this._refreshHud();
  }

  /** Cheap region-kind detection for procedural reverb. We probe the
   *  player's current land + statics every 750 ms; if the tile carries
   *  a flag we associate with caves / dungeons / shrines, emit a
   *  `region:enter` event the audio-manager listens for. The check is
   *  cheap because `assets.landAt` and `assets.staticsAt` are sector-
   *  cached. Skipped while audio context isn't initialised. */
  _tickRegionDetect(now = performance.now()) {
    if (this._nextRegionPollAt && now < this._nextRegionPollAt) return;
    this._nextRegionPollAt = now + 750;
    const p = world.player;
    if (!p) return;
    const land = assets.landAt?.(p.x, p.y);
    const stat = assets.staticsAt?.(p.x >> 3, p.y >> 3) ?? [];
    let kind = null;
    // Cave/dungeon land tiles (CUO `LandData.IsImpassable` + `IsCave`
    // ≈ tile id range 0x0244..0x024A is the canonical cave floor set).
    const lid = land?.id | 0;
    if ((lid >= 0x0244 && lid <= 0x024A) || (lid >= 0x053B && lid <= 0x0540)) kind = 'cave';
    // Cathedral / shrine — large carpet tiles 0x019A..0x019F.
    if (!kind && lid >= 0x019A && lid <= 0x019F) kind = 'cathedral';
    // Underwater hint — water tiles 0x00A8..0x00AB if player is "in"
    // a body of water (rare via boats but possible w/ swim).
    if (!kind && lid >= 0xA8 && lid <= 0xAB) kind = 'underwater';
    // Statics — dungeon walls / ceiling pieces flag the tile as
    // dungeon even when standing on grass (cave entrance tunnels).
    if (!kind) {
      const ix = p.x % 8, iy = p.y % 8;
      for (const s of stat) {
        if (s.x !== ix || s.y !== iy) continue;
        const sid = s.id | 0;
        if ((sid >= 0x0050 && sid <= 0x005F) || (sid >= 0x06D5 && sid <= 0x06D8)) {
          kind = 'dungeon'; break;
        }
      }
    }
    if (kind !== this._lastRegionKind) {
      this._lastRegionKind = kind;
      // Audit rev.4 P3 — expose on the world singleton so other
      // subsystems (light-overlay dungeon-dark, season tint) can read
      // it without subscribing to the bus.
      world.lastRegionKind = kind;
      bus.emit('region:enter', { kind });
      // Audit rev.4 P1 #1 — ambient music loop. The audio manager has
      // a subscriber on `atmosphere:ambient` since rev.3 but nothing
      // was emitting the event, so the cave/cathedral hum was dead
      // code. Reuse the same `kind` string we just computed for reverb
      // (cave / dungeon / cathedral / shrine / underwater) — audio
      // looks up `/assets/ambient/<kind>.mp3` and gracefully 404s on
      // shards that haven't shipped the audio yet.
      bus.emit('atmosphere:ambient', { name: kind || null });
    }
  }

  // -------------------------------------------------------------------------
  // DOM panels

  _ensureDomUiStyles() { ensureGameDomUiStyles(); }

  _sideRailOccupancy(viewLeft, viewRight) {
    return sideRailOccupancy(this._ui, viewLeft, viewRight);
  }
  _buildHud() {
    this._ensureDomUiStyles();
    const el = document.createElement('div');
    el.className = 'uo-panel uo-game-panel uo-hud-panel';
    el.style.position = 'fixed';
    el.style.top = 'calc(50vh + 4px)';
    el.style.right = '8px';
    el.style.bottom = '60px';
    // Player accounts never pay the DOM/layout cost of diagnostics. It is
    // revealed only after a non-Player access level is known.
    el.hidden = true;
    el.innerHTML = '<div class="uo-hud-title"><span>Debug</span></div><div id="uo-hud-body" class="uo-hud-grid"></div>';
    this.gc.domMount(el);
    this._hud = el;
    this._hudBody = el.querySelector('#uo-hud-body');
  }

  _applyAccountAccess(accessLevel = 'Player') {
    const access = String(accessLevel || 'Player').trim().toLowerCase();
    this._accountAccess = accessLevel || 'Player';
    const isStaff = access !== '' && access !== 'player';
    if (this._hud) {
      this._hud.hidden = !isStaff;
      this._hud.setAttribute('aria-hidden', isStaff ? 'false' : 'true');
      if (isStaff) {
        this._hudLastAt = 0;
        this._refreshHud();
      }
    }
  }

  _buildJournal() {
    this._ensureDomUiStyles();
    const el = document.createElement('div');
    el.className = 'uo-panel uo-game-panel uo-journal-panel';
    el.style.position = 'fixed';
    el.style.bottom = '60px';
    el.style.left = '8px';
    el.id = 'uo-journal';
    el.innerHTML = `
      <div class="uo-journal-head">
        <span>Dziennik</span>
        <button class="uo-journal-open" type="button" title="Otwórz pełny dziennik (J)">J</button>
      </div>
      <div class="uo-journal-lines is-empty" aria-live="polite">Brak wiadomości</div>`;
    const body = el.querySelector('.uo-journal-lines');
    el.querySelector('.uo-journal-open')?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this._toggleGump('journal', () => new JournalGump());
    });
    this.gc.domMount(el);
    this._journal = el;
    this._journalBody = body;
  }

  _buildChat() {
    this._ensureDomUiStyles();
    // Chat modes — mirrors CUO `SystemChatControl.ChatMode` enum.
    // Prefix-keyed: a leading character on the line picks the mode for
    // that one message. With a "sticky" mode (set via dropdown) the
    // user types plain text and we wrap it for them.
    //
    // CUO/UO speech `type` byte values (UnicodeSpeech 0xAD):
    //   0x00 Normal, 0x02 Emote, 0x08 Whisper, 0x09 Yell,
    //   0x0D Guild, 0x0E Alliance.
    // Party uses 0xBF subop 0x06 sub 0x03 instead of 0xAD.
    const MODES = [
      { id: 'normal',   prefix: '',  hue: 0x03B2, label: 'Normal',  type: 0x00 },
      { id: 'whisper',  prefix: ';', hue: 0x002D, label: 'Whisper', type: 0x08 },
      { id: 'emote',    prefix: ':', hue: 0x07B5, label: 'Emote',   type: 0x02 },
      { id: 'yell',     prefix: '!', hue: 0x002B, label: 'Yell',    type: 0x09 },
      { id: 'guild',    prefix: '\\', hue: 0x0044, label: 'Guild',  type: 0x0D },
      { id: 'alliance', prefix: '|', hue: 0x005A, label: 'Alliance', type: 0x0E },
      { id: 'party',    prefix: '/', hue: 0x0040, label: 'Party',   type: -1   },
    ];
    const stickyMode = MODES[0];
    this._stickyChatMode = stickyMode;

    const wrap = document.createElement('div');
    wrap.className = 'uo-panel uo-game-panel uo-chatbar';
    wrap.style.position = 'fixed';
    wrap.style.bottom = '8px';
    wrap.style.left = '8px';
    wrap.style.right = '8px';

    // Mode selector dropdown.
    const sel = document.createElement('select');
    sel.className = 'uo-panel uo-chat-mode';
    for (const m of MODES) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label + (m.prefix ? ` (${m.prefix})` : '');
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => {
      this._stickyChatMode = MODES.find((m) => m.id === sel.value) || MODES[0];
      input.placeholder = this._chatPlaceholder(this._stickyChatMode);
    });

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = this._chatPlaceholder(stickyMode);
    input.className = 'uo-panel uo-chat-input';
    input.autocomplete = 'off';
    input.spellcheck = false;

    // History — Up/Down arrows scroll back through prior lines.
    /** @type {string[]} */
    this._chatHistory = [];
    let histIdx = -1;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') {
        if (this._chatHistory.length === 0) return;
        e.preventDefault();
        histIdx = Math.min(this._chatHistory.length - 1, histIdx + 1);
        input.value = this._chatHistory[this._chatHistory.length - 1 - histIdx] ?? '';
        return;
      }
      if (e.key === 'ArrowDown') {
        if (histIdx <= 0) { histIdx = -1; input.value = ''; return; }
        e.preventDefault();
        histIdx--;
        input.value = this._chatHistory[this._chatHistory.length - 1 - histIdx] ?? '';
        return;
      }
      if (e.key === 'Escape') {
        // Esc returns focus to the game viewport without sending.
        e.preventDefault();
        input.value = '';
        try { input.blur(); } catch { /* detached */ }
        return;
      }
      if (e.key === 'Tab') {
        // Tab completion against the shard command catalogue (pushed
        // at LoginComplete via 0xBF 0xA0). Only fires when the input
        // starts with `[` so plain chat tab still bubbles to the
        // browser. Cycles through matches on repeated Tab.
        const v = input.value;
        if (!v.startsWith('[')) return;
        e.preventDefault();
        const cmds = this._cmdPanel?._commands ?? [];
        if (!cmds.length) return;
        const cursor = v.slice(1).split(' ')[0].toLowerCase();
        // Cycle through matches across consecutive Tab presses.
        this._tabIdx = (this._tabIdx ?? -1);
        if (this._lastTabSeed !== cursor) { this._tabIdx = -1; this._lastTabSeed = cursor; }
        let matchCount = 0;
        for (const c of cmds) {
          if (c.name.startsWith(cursor)) matchCount++;
        }
        if (matchCount === 0) return;
        this._tabIdx = (this._tabIdx + 1) % matchCount;
        let seen = 0;
        let matchName = '';
        for (const c of cmds) {
          if (!c.name.startsWith(cursor)) continue;
          if (seen++ === this._tabIdx) { matchName = c.name; break; }
        }
        input.value = `[${matchName} `;
        const end = input.value.length;
        input.setSelectionRange?.(end, end);
        return;
      }
      // Any non-Tab key resets the tab-cycle so the next Tab starts
      // fresh against the new prefix.
      this._tabIdx = -1;
      this._lastTabSeed = '';
      if (e.key !== 'Enter') return;
      const raw = input.value;
      if (net?.tracePackets) {
        console.log(`[trace chat] Enter raw=${JSON.stringify(raw)} wsState=${net?.ws?.readyState}`);
      }
      if (!raw.trim()) {
        // Empty enter just blurs back to game (lets the next Enter
        // re-activate via the viewport-level shortcut).
        try { input.blur(); } catch { /* detached */ }
        return;
      }
      this._dispatchChat(raw, MODES);
      this._chatHistory.push(raw);
      if (this._chatHistory.length > 64) {
        this._chatHistory.splice(0, this._chatHistory.length - 64);
      }
      histIdx = -1;
      input.value = '';
      // Blur back to viewport so walk keys / hotkeys work immediately
      // and the next Enter re-opens the chat (CUO chat cadence).
      try { input.blur(); } catch { /* detached */ }
    });

    wrap.appendChild(sel);
    wrap.appendChild(input);
    this.gc.domMount(wrap);
    this._chatInput = input;
  }

  _chatPlaceholder(mode) {
    return `[${mode.label}] Enter to send — prefixes: ; whisper · : emote · ! yell · / party · \\ guild · | alliance`;
  }

  /** Resolve the active mode for one input line and dispatch the right
   *  outgoing packet. */
  _dispatchChat(raw, modes) {
    // Local slash commands intercept before any speech routing. Bug-hunt
    // #6 audit B#8 — was using CommonJS `require()` which throws in the
    // Vite browser bundle every time, then falling through to an async
    // import whose handler ran AFTER this function returned (so the FIRST
    // /cmd silently became speech). Static import resolves it cleanly.
    if (raw.startsWith('/')) {
      if (commandManager?.handle(raw, { world })) return;
    }
    // Audit rev.4 P2 — `[ObjectName]` bracket resolver. Look for an
    // inline mob-name bracket BEFORE the `[` admin-command check (the
    // [Name] form requires a closing bracket so it won't collide with
    // a server `[set …` admin command). When matched, pre-select the
    // mob as target and continue with the cleaned-up speech.
    if (/\[[^\]]{2,40}\]/.test(raw)) {
      const cleaned = commandManager?.resolveBracket?.(raw, { world });
      if (typeof cleaned === 'string') raw = cleaned;
      if (!raw) return;
    }
    // `[` bracket commands — RunUO / ServUO admin command convention
    // (e.g. `[go`, `[set`, `[where`). The server processes them as a
    // special-prefixed speech, but we route them as 0xAD type=0
    // (regular speech, no notoriety tag) regardless of the user's
    // sticky chat mode so a guild-chat sticky doesn't accidentally
    // shout `[set` to the guild channel.
    //
    // Previously emitted a `chat:send` bus event that no manager ever
    // subscribed to → every `[command` was silently swallowed and the
    // user saw NO admin commands work at all. Send the speech packet
    // directly here, same as the regular path at the bottom of this
    // method — this is the canonical wire for ServUO bracket commands.
    if (raw.startsWith('[')) {
      try { net.send(buildUnicodeSpeech(raw, { type: 0x00, hue: 0x03B2 })); }
      catch { /* socket transient */ }
      return;
    }
    let mode = this._stickyChatMode || modes[0];
    let text = raw;
    // Single-message override prefix: starts with one of the mode chars.
    const first = raw.charAt(0);
    const found = modes.find((m) => m.prefix && m.prefix === first);
    if (found) {
      mode = found;
      text = raw.slice(1).trimStart();
      if (!text) return;
    }
    if (mode.id === 'party') {
      try { net.send(buildPartyMessage(text)); } catch { /* socket */ }
      return;
    }
    try { net.send(buildUnicodeSpeech(text, { type: mode.type, hue: mode.hue })); }
    catch { /* socket */ }
  }

  _refreshHud(now = performance.now()) {
    if (!this._hud || this._hud.hidden) return;
    // Throttle to 4Hz — debug panel doesn't need 60fps redraw, and
    // innerHTML = "..." reflows the whole panel each call. Together
    // with the dropped per-event handlers above this saves ~80
    // innerHTML reflows per TP burst.
    if (this._hudLastAt && now - this._hudLastAt < 250) return;
    this._hudLastAt = now;
    const body = this._hudBody;
    if (!body) return;
    const p = world.player;
    const row = (label, value, wide = false) =>
      `<div class="uo-hud-row${wide ? ' uo-hud-wide' : ''}"><span>${label}</span><b>${value}</b></div>`;
    const section = (label) => `<div class="uo-hud-row uo-hud-section">${label}</div>`;
    const fmt = (v, d = 1) => Number.isFinite(+v) ? (+v).toFixed(d) : '-';
    const fps = clientPerfStats.frameMs > 0
      ? 1000 / clientPerfStats.frameMs
      : (this.gc?.app?.ticker?.FPS ?? 0);
    const wsState = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][net?.ws?.readyState ?? -1]
      ?? net?.state ?? '-';
    const ns = net?.stats ?? {};
    const lf = lightPoints.lightFrameStats ?? {};
    const le = lightPoints.equipmentLightStats ?? {};
    const tileDiagnostics = this._tiles?.diagnosticsSnapshot?.() ?? {};
    const spriteStats = spritePool.stats();
    const textureStats = assets.diagnosticsSnapshot?.() ?? {};
    const longTasks = clientPerfStats.longTaskHistory ?? [];
    const latestLongTask = longTasks.length
      ? longTasks[(clientPerfStats.longTaskHead - 1 + longTasks.length) % longTasks.length] : null;
    const renderer = this.gc?.app?.renderer;
    const rendererType = renderer?.type === 1 ? 'WebGL' : (renderer?.type === 2 ? 'WebGPU' : 'unknown');
    const perfObj = typeof performance !== 'undefined' ? performance : null;
    const mem = perfObj?.memory
      ? `${fmt(perfObj.memory.usedJSHeapSize / 1048576, 0)} / ${fmt(perfObj.memory.jsHeapSizeLimit / 1048576, 0)} MB`
      : '-';
    const serial = `0x${(p?.serial ?? 0).toString(16).padStart(8, '0')}`;
    const bodyId = `0x${(p?.body ?? 0).toString(16).padStart(4, '0')}`;
    const pos = `${p?.x ?? '-'}, ${p?.y ?? '-'}, ${p?.z ?? '-'}`;
    const path = `${pathfindStats.lastResult} ${pathfindStats.lastMs.toFixed(2)}ms v=${pathfindStats.lastVisited} z=${pathfindStats.lastCacheHits}/${pathfindStats.lastCacheMisses} b=${pathfindStats.lastBlockCacheHits}/${pathfindStats.lastBlockCacheMisses}`;
    body.innerHTML = `
      ${section('Performance')}
      ${row('fps', `${fmt(fps, 0)} (${fmt(clientPerfStats.frameMs)}ms)`)}
      ${row('update/draw', `${fmt(clientPerfStats.updateMs)}/${fmt(clientPerfStats.drawMs)}ms`)}
      ${row('tick/lag', `${fmt(clientPerfStats.tickMs)}/${fmt(clientPerfStats.eventLoopLagMs)}ms`)}
      ${row('long tasks', `${clientPerfStats.longTaskCount} last=${fmt(clientPerfStats.lastLongTaskMs)} max=${fmt(clientPerfStats.maxLongTaskMs)}ms ${latestLongTask?.subsystem ?? ''}`)}
      ${row('renderer', `${rendererType} x${renderer?.resolution ?? 1}`)}
      ${row('memory', mem)}
      ${row('sprites/meshes', `${spriteStats.active}/${tileDiagnostics.landMeshes?.active ?? 0}`)}
      ${row('textures', Object.values(textureStats.caches ?? {}).reduce((sum, count) => sum + (Number(count) || 0), 0))}
      ${row('scene resources', `listeners=${this._unsubs.length} timers=${this._touchLongPressTimer ? 1 : 0}`)}
      ${section('World')}
      ${row('serial', serial)}
      ${row('body', bodyId)}
      ${row('pos', pos)}
      ${row('dir', p?.direction ?? '-')}
      ${row('map', `${world.mapId} (${world.mapWidth}x${world.mapHeight})`)}
      ${row('mobiles', world.mobiles.size)}
      ${row('items', world.items.size)}
      ${row('chunks', this._tiles?.visuals.size ?? 0)}
      ${row('chunk queue', `${tileDiagnostics.queuedChunks ?? 0} last=${tileDiagnostics.lastPopulateAt ? new Date(tileDiagnostics.lastPopulateAt).toLocaleTimeString() : '-'}`)}
      ${row('light level', world.lightLevel ?? '-')}
      ${section('Lighting')}
      ${row('lights', `src=${lightPoints.size?.() ?? '-'} cand=${lf.candidates ?? 0} vis=${lf.visible ?? 0}`)}
      ${row('apertures', `${lf.apertures ?? 0} blocked=${lf.blocked ?? 0}`)}
      ${row('light ms', `${fmt(lf.lastMs)} max=${fmt(lf.maxMs)}`)}
      ${row('occlusion', `${lf.occlusionCalls ?? 0} h=${lf.occlusionHits ?? 0} m=${lf.occlusionMisses ?? 0}`)}
      ${row('equip scan', `${le.scans ?? 0} hit=${le.cacheHits ?? 0} miss=${le.cacheMisses ?? 0}`)}
      ${section('Movement')}
      ${row('pending', `${movementStats.pending}/${movementStats.maxPending}`)}
      ${row('acks/reject', `${movementStats.acks}/${movementStats.rejects}`)}
      ${row('ack latency', `${fmt(movementStats.lastAckLatencyMs)} avg=${fmt(movementStats.avgAckLatencyMs)}ms`)}
      ${row('resyncs', `${movementStats.resyncRequests} stale=${movementStats.staleResyncs}`)}
      ${section('Network')}
      ${row('ws', `${wsState} buf=${net?.ws?.bufferedAmount ?? 0}`)}
      ${row('packets', `rx=${ns.packetsReceived ?? 0} tx=${ns.packetsSent ?? 0}`)}
      ${row('bytes', `rx=${ns.bytesReceived ?? 0} tx=${ns.bytesSent ?? 0}`)}
      ${row('decoded', ns.bytesDecoded ?? 0)}
      ${row('path', path, true)}
    `;
  }

  /** Render a context-menu next to the cursor using cliloc text. The
   *  menu auto-closes on outside click; choosing an entry sends 0xBF
   *  0x16 with the entry's responseId. Disabled entries (flag 0x01)
   *  are dimmed and ignore clicks. */
  _showPopupMenu({ serial, entries }) {
    entries = Array.isArray(entries) ? entries : [];
    this._closePopupMenu();
    const el = document.createElement('div');
    el.className = 'uo-panel uo-game-panel uo-popup-menu';
    el.style.cssText = `
      position:fixed; left:${this._lastRClickX}px; top:${this._lastRClickY}px;
      min-width:160px; padding:4px; z-index:9999;
      font:500 13px/1.35 "Segoe UI Variable Text", "Segoe UI", Inter, system-ui, sans-serif; cursor:pointer;
    `;
    const pinned = tooltips.pinnedSerials().includes(serial >>> 0);
    const pinItem = document.createElement('div');
    pinItem.textContent = pinned ? 'Unpin properties' : 'Pin properties';
    pinItem.style.cssText = 'padding:5px 8px;color:#9fdcff;border-bottom:1px solid rgba(216,175,98,.18)';
    pinItem.addEventListener('mouseenter', () => { pinItem.style.background = '#3a2a10'; });
    pinItem.addEventListener('mouseleave', () => { pinItem.style.background = ''; });
    pinItem.addEventListener('click', () => {
      if (pinned) tooltips.unpin(serial);
      else tooltips.pin(serial, this._lastRClickX, this._lastRClickY);
      this._closePopupMenu();
    });
    el.appendChild(pinItem);
    for (const e of entries) {
      const item = document.createElement('div');
      const disabled = (e.flags & 0x01) !== 0;
      item.textContent = assets.cl(e.cliloc) || `#${e.cliloc}`;
      item.style.cssText = `
        padding:3px 8px; color:${disabled ? '#666' : '#fff0c0'};
        ${disabled ? 'pointer-events:none' : ''}
      `;
      item.addEventListener('mouseenter', () => { item.style.background = '#3a2a10'; });
      item.addEventListener('mouseleave', () => { item.style.background = ''; });
      item.addEventListener('click', () => {
        net.send(buildPopupMenuChoice(serial, e.responseId));
        this._closePopupMenu();
      });
      el.appendChild(item);
    }
    this.gc.domMount(el);
    this._popupMenu = el;
    // Close on any outside click. Captured globally; we register the
    // listener on the next tick so the click that opened us doesn't
    // immediately close it.
    setTimeout(() => {
      this._popupClose = (ev) => { if (!el.contains(ev.target)) this._closePopupMenu(); };
      window.addEventListener('mousedown', this._popupClose, true);
    }, 0);
  }
  _closePopupMenu() {
    this._popupMenu?.remove();
    this._popupMenu = null;
    if (this._popupClose) {
      window.removeEventListener('mousedown', this._popupClose, true);
      this._popupClose = null;
    }
  }

  _appendJournal(line) {
    if (!this._journal || !this._journalBody) return;
    this._journalLines.push(line);
    if (this._journalLines.length > 40) {
      this._journalLines.splice(0, this._journalLines.length - 40);
    }
    this._journalBody.classList.remove('is-empty');
    this._journalBody.textContent = this._journalLines.join('\n');
    this._journalBody.scrollTop = this._journalBody.scrollHeight;
  }

  // -------------------------------------------------------------------------
  // Mouse-walk: ClassicUO drives movement from cursor angle relative to
  // the player. The player walks while RMB is held;
  // releasing stops sending packets. Run mode (shift held) doubles speed.

  _onMouseMove = (e) => {
    // Audit #46 P1 — DragSelect marquee growth. While the user drags
    // with the modifier-key+LMB held, paint a yellow dashed rectangle.
    if (this._dragSelectActive && this._dragSelectStart) {
      const r = {
        x: this._dragSelectStart.x,
        y: this._dragSelectStart.y,
        w: e.clientX - this._dragSelectStart.x,
        h: e.clientY - this._dragSelectStart.y,
      };
      this._dragSelectRect = r;
      this._renderDragSelectOverlay(r);
      return;
    }
    // MMB-hold = temporary camera peek/pan. ClassicUO exposes this as
    // the "LookAtMouse" extra-mouse macro; it must not interfere with
    // RMB mouse-walk.
    if (this._peekPanActive) {
      const dx = e.clientX - this._peekPanLastX;
      const dy = e.clientY - this._peekPanLastY;
      this._peekPanLastX = e.clientX;
      this._peekPanLastY = e.clientY;
      if (dx || dy) camera.panBy?.(dx, dy);
      e.preventDefault?.();
      return;
    }
    // RMB-hold = mouse-walk. CUO retail does not pan-on-drag with RMB;
    // the old 12 px threshold made normal cursor drift self-cancel walk
    // and produced stop-start movement. Keep panning on MMB so walking
    // and camera peek stay separate.
    // Pivot around the PLAYER'S screen position, not the browser
    // viewport centre. CUO's mouse-walk treats the avatar's foot as
    // origin so dragging away from him in any direction starts the
    // walk in that direction. With the gameplay rect potentially
    // sub-window-size (chat strip, side panels), using
    // `window.innerWidth/2` made the avatar drift toward the bottom
    // of the screen on every mouse-walk because the browser centre
    // sat below the player.
    const viewLeft = camera.viewX;
    const viewTop = camera.viewY;
    const viewRight = viewLeft + camera.viewW;
    const viewBottom = viewTop + camera.viewH;
    const insideViewport = e.clientX >= viewLeft && e.clientX <= viewRight
      && e.clientY >= viewTop && e.clientY <= viewBottom;
    // Once RMB walking starts in the world, the surrounding UI/chrome is an
    // extension of the steering surface. Clamp the vector at the gameplay
    // edge so a cursor on a side rail keeps a stable direction/run distance
    // without producing an enormous off-screen vector.
    const steerX = this._mouseHeld
      ? Math.max(viewLeft, Math.min(viewRight, e.clientX))
      : e.clientX;
    const steerY = this._mouseHeld
      ? Math.max(viewTop, Math.min(viewBottom, e.clientY))
      : e.clientY;
    const playerPoint = this._playerScreenPoint();
    const playerScreenX = playerPoint.x;
    const playerScreenY = playerPoint.y;
    this._mouseDx = steerX - playerScreenX;
    this._mouseDy = steerY - playerScreenY;
    const overUi = !!this._ui?.pickAtScreen(e.clientX, e.clientY);
    this._mouseInside = this._mouseHeld || (insideViewport && !overUi);
    if (houseCustomization.state === HouseCustomState.Editing) {
      const tile = this._pickWorldTile(e.clientX, e.clientY);
      if (tile) houseCustomization.setPreviewTile(tile.x, tile.y, tile.z);
      else houseCustomization.clearPreviewTile();
    } else if (houseCustomization.state === HouseCustomState.Idle) {
      houseCustomization.clearPreviewTile();
    }
    // CUO drag-from-mobile gesture — when the user mouse-pressed on a
    // mob in `_onLeftDown`, holding the button and moving >5 px spawns
    // a HealthBarGump anchored at the drop point. Shift+drag spawns
    // the mini-StatusGump variant (CUO Game/UI/Gumps/HealthBarGump.cs
    // line ~190). Threshold matches CUO MIN_PICKUP_DRAG_DISTANCE.
    if (this._dragMobSerial && this._dragMobStart) {
      const dx = e.clientX - this._dragMobStart.x;
      const dy = e.clientY - this._dragMobStart.y;
      if ((dx * dx + dy * dy) >= 25) {     // >5 px
        const s = this._dragMobSerial;
        const wantMini = !!this._dragMobShift;
        this._dragMobSerial = 0;
        this._dragMobStart  = null;
        this._dragMobShift  = false;
        // Cancel the double-click watch + name request — drag wins over
        // single-click semantics.
        this._clearDoubleClick?.();
        // Mini status only makes sense for SELF (StatusGump is wired
        // to world.player); for foreign mobiles a HealthBar is the
        // canonical CUO drop target. Route accordingly so shift-drag
        // on an NPC actually opens something instead of silently
        // spawning a self-status panel that ignores the dragged mob.
        const isSelf = s === (world.player?.serial >>> 0);
        if (wantMini && isSelf) {
          this._toggleGump?.(`status-mini:${s}`, () => new StatusGump('mini'));
        } else {
          this._toggleGump?.(`health-bar:${s}`, () => new HealthBarGump(s, e.clientX - 80, e.clientY - 30));
        }
      }
    }
    // Hover tooltip — find a mobile under the cursor and ask the server
    // for properties on the first hover. Subsequent renders use the cache.
    const hit = overUi ? null : this._pickWorldEntity(e.clientX, e.clientY);
    if (overUi) {
      // Gump controls own their hover lifecycle. Hiding here used to erase a
      // ContainerGump tooltip in the very same pointermove that displayed it.
      bus.emit('world:cursor-hint', { name: null });
    } else if (dragDrop.isHolding()) {
      tooltips.hide();
      bus.emit('world:cursor-hint', { name: 'drag-hold' });
    } else if (hit && hit.serial) {
      tooltips.show(hit.serial, e.clientX, e.clientY);
      bus.emit('world:cursor-hint', { name: this._warMode ? 'attack' : 'help' });
    } else {
      tooltips.hide();
      const itemHit = this._pickWorldItem(e.clientX, e.clientY);
      bus.emit('world:cursor-hint', {
        name: itemHit ? (itemHit.movable ? 'drag-grab' : 'help') : null,
      });
    }
  };
  _onMouseLeave = () => {
    // Leaving the document while RMB is physically held must not cancel
    // movement: browsers stop reporting pointer coordinates at the window
    // edge but the game loop can safely keep using the last clamped vector.
    // `mouseup`, window blur and visibilitychange still end the hold, so this
    // cannot leave an avatar walking after Alt-Tab.
    this._mouseInside = !!this._mouseHeld;
    bus.emit('world:cursor-hint', { name: null });
    if (this._peekPanActive) {
      this._peekPanActive = false;
      camera.resetPan?.();
    }
    houseCustomization.clearPreviewTile();
    tooltips.hide();
  };

  // ---------------------------------------------------------------------
  // Touch input — pinch-zoom + long-press as RMB. Single-finger touches
  // synthesise a left-click via the underlying TouchEvent → mouse
  // synthesis the browser already does (we DON'T preventDefault on
  // single-finger so click semantics still work).
  //
  // Two fingers tracked for pinch — distance delta drives camera
  // zoom in / out. We DON'T pan on two fingers (would conflict with
  // mouse-walk gesture; users on touch devices use the chevrons or
  // tap-to-walk macros instead).
  //
  // Long-press (≥500 ms with finger sub-10 px movement) triggers an
  // _onRightDown synthesis at the touch point — gives mobile players
  // access to popup menus and pathfind-DC without a hardware RMB.

  _touchState = null;
  _touchPinchDist = 0;
  _touchLongPressTimer = null;
  _onTouchStart = (e) => {
    // DOM-panel check — let HTML inputs receive touches normally.
    if (e.target instanceof HTMLElement && e.target.closest('.uo-panel')) return;
    if (e.touches.length === 1) {
      const t = e.touches[0];
      this._touchState = { x: t.clientX, y: t.clientY, t: performance.now(), moved: false };
      // Arm long-press → RMB at touch coords.
      if (this._touchLongPressTimer) clearTimeout(this._touchLongPressTimer);
      this._touchLongPressTimer = setTimeout(() => {
        if (!this._touchState || this._touchState.moved) return;
        // Synthesise a right-click at the held point.
        this._onRightDown({
          clientX: this._touchState.x, clientY: this._touchState.y,
          button: 2, shiftKey: false, preventDefault() { /* noop */ },
        });
        // Client audit #4 B2 — touch long-press latched `_mouseHeld=true`
        // but had no matching `mouseup` event, so the avatar marched
        // until a real RMB-up arrived. Clear after the synthesised down.
        this._mouseHeld = false;
      }, 500);
    } else if (e.touches.length === 2) {
      // Pinch start — capture distance baseline.
      if (this._touchLongPressTimer) { clearTimeout(this._touchLongPressTimer); this._touchLongPressTimer = null; }
      const a = e.touches[0]; const b = e.touches[1];
      const dx = a.clientX - b.clientX; const dy = a.clientY - b.clientY;
      this._touchPinchDist = Math.hypot(dx, dy);
      e.preventDefault();
    }
  };
  _onTouchMove = (e) => {
    if (e.target instanceof HTMLElement && e.target.closest('.uo-panel')) return;
    if (e.touches.length === 1 && this._touchState) {
      const t = e.touches[0];
      const dx = t.clientX - this._touchState.x;
      const dy = t.clientY - this._touchState.y;
      if (dx * dx + dy * dy > 100) {       // >10 px movement
        this._touchState.moved = true;
        if (this._touchLongPressTimer) {
          clearTimeout(this._touchLongPressTimer);
          this._touchLongPressTimer = null;
        }
      }
      // Re-use mouse-walk pivot: feed coords into the same pivot
      // calculation used by mouse-walk. Touch acts like RMB-hold so
      // walking with one finger after a brief pause works.
      const playerScreenX = (camera.viewX | 0) + (camera.viewW | 0) / 2;
      const playerScreenY = (camera.viewY | 0) + (camera.viewH | 0) / 2;
      this._mouseDx = t.clientX - playerScreenX;
      this._mouseDy = t.clientY - playerScreenY;
      this._mouseInside = true;
    } else if (e.touches.length === 2) {
      const a = e.touches[0]; const b = e.touches[1];
      const dx = a.clientX - b.clientX; const dy = a.clientY - b.clientY;
      const dist = Math.hypot(dx, dy);
      const delta = dist - this._touchPinchDist;
      // Each ~40 px of pinch = one zoom step.
      if (Math.abs(delta) >= 40) {
        if (delta > 0) camera.zoomIn?.();
        else           camera.zoomOut?.();
        this._touchPinchDist = dist;
      }
      e.preventDefault();
    }
  };
  _onTouchEnd = (e) => {
    if (this._touchLongPressTimer) {
      clearTimeout(this._touchLongPressTimer);
      this._touchLongPressTimer = null;
    }
    // Stop synthesised mouse-walk.
    this._mouseHeld = false;
    this._touchState = null;
    void e;
  };
  _onMouseDown = (e) => {
    // Don't consume clicks landing on DOM panels (HUD/journal/chat input).
    if (e.target instanceof HTMLElement && e.target.closest('.uo-panel')) return;
    // MMB (middle-mouse) handling. CUO's extra-mouse path can bind
    // LookAtMouse; by default we make it a hold-to-peek camera pan and
    // still emit `input:mmb` for macros/tooling.
    if (e.button === 1) {
      this._peekPanActive = true;
      this._peekPanLastX = e.clientX;
      this._peekPanLastY = e.clientY;
      camera.resetPan?.();
      bus.emit('input:mmb', { x: e.clientX, y: e.clientY, state: 'down' });
      e.preventDefault?.();
      return;
    }
    // Audit #46 P1 — DragSelect: Ctrl/Shift/Alt + LMB-drag on the world
    // viewport spawns a marquee that selects multiple mobiles on release.
    // CUO `Profile.cs::EnableDragSelect`.
    if (e.button === 0 && this._isDragSelectActivator(e)) {
      if (!this._ui?.pickAtScreen(e.clientX, e.clientY)) {
        this._dragSelectActive = true;
        this._dragSelectStart = { x: e.clientX, y: e.clientY };
        this._dragSelectRect  = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
        e.preventDefault?.();
        return;
      }
    }
    if (e.button === 0) this._onLeftDown(e);
    else if (e.button === 2) this._onRightDown(e);
  };

  /** True when modifier+button match the dragSelect profile binding. */
  _isDragSelectActivator(e) {
    try {
      const cfg = profile.get?.('dragSelect') ?? {};
      if (!cfg.enabled) return false;
      const mod = cfg.modifierKey || 'ctrl';
      if (mod === 'ctrl'  && !e.ctrlKey)  return false;
      if (mod === 'shift' && !e.shiftKey) return false;
      if (mod === 'alt'   && !e.altKey)   return false;
      return true;
    } catch { return false; }
  }
  _onMouseUp = (e) => {
    this._mouseHeld = false; this._mouseShift = false;
    this._mouseAutoRun = false;
    // Cleanup temporary camera peeking. RMB walk and MMB peek both end
    // on mouseup so the next frame recenters on the player.
    if (this._peekPanActive || this._rmbPanActive) {
      camera.resetPan?.();
      if (this._peekPanActive) {
        bus.emit('input:mmb', { x: e.clientX, y: e.clientY, state: 'up' });
      }
      this._peekPanActive = false;
      this._rmbPanActive = false;
    }
    this._peekPanLastX = 0;
    this._peekPanLastY = 0;
    this._rmbDownX = null;
    this._rmbDownY = null;
    // Audit #46 P1 — DragSelect mouseup: resolve marquee to visible
    // mobiles inside the rect and open healthbars (or just spawn an
    // overhead select halo if `asAnchor` is false).
    if (this._dragSelectActive) {
      this._dragSelectActive = false;
      const rect = this._dragSelectRect || { x: 0, y: 0, w: 0, h: 0 };
      this._dragSelectRect = null;
      this._removeDragSelectOverlay?.();
      const cfg = profile.get?.('dragSelect') ?? {};
      const picks = this._pickMobilesInRect(rect, cfg);
      for (const s of picks) {
        try {
          if (cfg.asAnchor) {
            this._toggleGump?.(`health-bar:${s}`, () => new HealthBarGump(s));
          } else {
            net.send(buildLookReq(s));
          }
        } catch { /* ignore */ }
      }
      e.preventDefault?.();
      return;
    }
    // Cancel any pending drag-from-mobile arm — the user just released
    // without crossing the threshold (a normal click). Health bar
    // never spawns from a tap.
    this._dragMobSerial = 0;
    this._dragMobStart  = null;
    void e;
  };

  /** Iterate visible mobiles, return serials whose screen bbox intersects
   *  the marquee rect. Applies humanoidsOnly / hostileOnly filters. */
  _pickMobilesInRect(rect, cfg) {
    const out = [];
    if (!rect || (rect.w === 0 && rect.h === 0)) return out;
    const x0 = Math.min(rect.x, rect.x + rect.w);
    const y0 = Math.min(rect.y, rect.y + rect.h);
    const x1 = Math.max(rect.x, rect.x + rect.w);
    const y1 = Math.max(rect.y, rect.y + rect.h);
    try {
      const me = world.player;
      const visitMobile = (m) => {
        if (!m || m.serial === me?.serial) return;
        if (cfg.humanoidsOnly && !(m.body >= 0x0190 && m.body <= 0x0193)
            && !(m.body >= 0x025D && m.body <= 0x029B)) return;
        if (cfg.hostileOnly) {
          const noto = m.notoriety ?? 1;
          // 3=gray, 4=criminal, 5=enemy, 6=murderer = attackable
          if (noto !== 3 && noto !== 4 && noto !== 5 && noto !== 6) return;
        }
        const p = this._screenPosForMobile?.(m);
        if (!p) return;
        if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) return;
        out.push(m.serial >>> 0);
      };
      if (me && typeof world.forEachMobileNear === 'function') {
        world.forEachMobileNear(me.x, me.y, me.map ?? world.mapId ?? 1, 24, true, visitMobile);
      } else {
        const nearby = me && world.mobilesNear
          ? world.mobilesNear(me.x, me.y, me.map ?? world.mapId ?? 1, 24, true)
          : world.mobiles.values();
        for (const m of nearby) visitMobile(m);
      }
    } catch { /* ignore */ }
    return out;
  }

  /** Helper: best-effort mobile-to-screen projection. Returns null if
   *  the renderer hasn't placed the mob this frame. */
  _screenPosForMobile(m) {
    try {
      return this._worldScreenPoint(m.x, m.y, m.z);
    } catch { return null; }
  }

  /** Render or update the marquee overlay rect (lightweight DOM div). */
  _renderDragSelectOverlay(rect) {
    if (!rect) return;
    let el = this._dragSelectOverlay;
    if (!el) {
      el = document.createElement('div');
      el.style.cssText = 'position:fixed;border:1px dashed #ffd200;background:rgba(255,210,0,0.08);pointer-events:none;z-index:9999';
      document.body.appendChild(el);
      this._dragSelectOverlay = el;
    }
    const x0 = Math.min(rect.x, rect.x + rect.w);
    const y0 = Math.min(rect.y, rect.y + rect.h);
    el.style.left   = `${x0}px`;
    el.style.top    = `${y0}px`;
    el.style.width  = `${Math.abs(rect.w)}px`;
    el.style.height = `${Math.abs(rect.h)}px`;
  }
  _removeDragSelectOverlay() {
    if (this._dragSelectOverlay) {
      try { this._dragSelectOverlay.remove(); } catch { /* ignore */ }
      this._dragSelectOverlay = null;
    }
  }
  _onContextMenu = (e) => {
    if (e.target instanceof HTMLElement && e.target.closest('.uo-panel')) return;
    e.preventDefault();
  };

  _onResizeMove = (e) => {
    if (!this._dragResize) return;
    const dw = e.clientX - this._dragResize.startX;
    const dh = e.clientY - this._dragResize.startY;
    camera.setUserSize(this._dragResize.w0 + dw, this._dragResize.h0 + dh);
    this._redrawViewportFrame();
  };
  _onResizeEnd = () => { this._dragResize = null; };

  _onLeftDown(e) {
    // If the cursor is on top of an open gump, let the UI handle the
    // click — never start mouse-walk through a gump. Without this the
    // player walks every time you drag/click a paperdoll, journal,
    // bag, status bar, etc. (since those are Pixi nodes, not DOM).
    if (this._ui?.pickAtScreen(e.clientX, e.clientY)) return;
    if (!this._isInsideGameViewport(e.clientX, e.clientY)) return;
    // House Customizer paint-on-click: when the player is in design
    // mode with a brush selected (or eraser), translate the screen click
    // to a world tile and dispatch through `houseCustomization.place()`
    // / `.erase()` instead of taking the normal click path. This is
    // gated on `houseCustomization.state` so non-editing clicks fall
    // through unchanged.
    if (houseCustomization?.state && houseCustomization.state !== HouseCustomState.Idle) {
      const tile = this._pickWorldTile(e.clientX, e.clientY);
      if (tile) {
        if (houseCustomization.state === HouseCustomState.Erasing) {
          // Eraser mode — pull whatever item is on the tile (we don't
          // know its graphic from a tile-only pick, so erase by graphic
          // 0 lets the server resolve "topmost at tile").
          houseCustomization.erase(0, tile.x, tile.y, tile.z);
        } else {
          houseCustomization.place(tile.x, tile.y, tile.z);
        }
        e.preventDefault?.();
        return;
      }
    }
    // Same for the zoom +/- buttons and the viewport resize-handle in
    // the corner of the gameplay rectangle. Their Pixi event handlers
    // run ahead of this window-level mousedown but don't stop the
    // default → without an explicit hit-test the user walks every
    // time they zoom in/out.
    if (this._isUiHotspot(e.clientX, e.clientY)) return;
    // Holding an item from a container/paperdoll lift? A click on the
    // game viewport is a "drop on the ground" gesture — translate the
    // screen point to a world tile and send 0x08 with serial
    // 0xFFFFFFFF (world drop). Mirrors CUO ItemHold drop logic.
    if (dragDrop.isHolding()) {
      // Drop ON a mobile under the cursor → trade gesture (player) or
      // item-give (NPC). Server's handleDrop branches on `container`
      // being a mobile serial. CUO `GameActions.DropItem(target)` does
      // the same: serial of the picked entity goes into the dest field.
      const mobHit = this._pickWorldEntity(e.clientX, e.clientY);
      if (mobHit?.serial) {
        dragDrop.dropToContainer(mobHit.serial, 0, 0, 0);
        return;
      }
      const tile = this._pickWorldTile(e.clientX, e.clientY);
      if (tile) dragDrop.dropToGround(tile.x, tile.y, tile.z);
      else dragDrop.reject();   // Off-map click — restore the item.
      return;
    }
    // Targeting prompt active? click resolves the target.
    const hit = this._pickWorldEntity(e.clientX, e.clientY);
    if (targetManager.active) {
      e.preventDefault();
      if (targetManager.cursorType === 2 /* Multi */) {
        const tile = this._pickWorldTile(e.clientX, e.clientY);
        if (tile) {
          targetManager.pickPosition(tile.x, tile.y, tile.z, targetManager.multi?.multiId ?? 0);
        } else {
          targetManager.cancel();
        }
        return;
      }
      const itemHitT = !hit?.serial ? this._pickWorldItem(e.clientX, e.clientY) : null;
      if (hit?.serial) targetManager.pickEntity({ serial: hit.serial });
      else if (itemHitT?.serial) targetManager.pickEntity({
        serial: itemHitT.serial,
        x: itemHitT.x,
        y: itemHitT.y,
        z: itemHitT.z,
        graphic: itemHitT.itemId,
      });
      else {
        const staticHit = this._pickWorldStatic(e.clientX, e.clientY);
        if (staticHit) targetManager.pickEntity(staticHit);
        else {
          const tile = this._pickWorldTile(e.clientX, e.clientY);
          if (tile) targetManager.pickEntity({ serial: 0, ...tile, graphic: 0 });
          else targetManager.cancel();
        }
      }
      return;
    }
    // ---- Mobile under cursor ----------------------------------------------
    // Single click → 0x09 LookReq (overhead name) + start double-click watch.
    // A second LMB on the SAME serial within DBLCLICK_MS resolves to a
    // 0x06 UseReq (paperdoll for player, vendor buy window, etc.).
    if (hit?.serial) {
      if (this._isDoubleClick(hit.serial)) {
        this._clearDoubleClick();
        net.send(buildUseReq(hit.serial));
        return;
      }
      net.send(buildLookReq(hit.serial));
      targetManager.selectEntity?.(hit.serial);
      this._namesRequested.add(hit.serial >>> 0);
      this._armDoubleClick(hit.serial);
      // CUO drag-from-mobile gesture: arm a "potential drag" so a
      // press-then-move >5 px spawns a HealthBarGump (Shift+drag spawns
      // a mini StatusGump). Final dispatch lives in `_onMouseUp` /
      // `_onMouseMove`. Self-drag spawns a self-aware HealthBarGump too
      // (3 bars HP/MP/ST since server has full attribute knowledge for
      // your own mobile) — Marcin reported he couldn't tear off his own
      // bar because the previous code skipped self entirely.
      this._dragMobSerial = hit.serial >>> 0;
      this._dragMobStart  = { x: e.clientX, y: e.clientY };
      this._dragMobShift  = !!e.shiftKey;
      // In war mode LMB = attack request.
      if (this._warMode) net.send(buildAttackReq(hit.serial));
      return;
    }
    // ---- World item under cursor ------------------------------------------
    // Movable item (server flag 0x20 in 0x1A WorldItem) → lift immediately
    // for responsiveness. Non-movable items (doors, signposts, fixed
    // chests) only react to double-click via UseReq. A second click in
    // quick succession resolves to UseReq regardless.
    const itemHit = this._pickWorldItem(e.clientX, e.clientY);
    if (itemHit) {
      if (this._isDoubleClick(itemHit.serial)) {
        this._clearDoubleClick();
        net.send(buildUseReq(itemHit.serial));
        return;
      }
      // Movable: drag now (no lift delay). Caller has 250 ms to issue a
      // second click on the same serial — but by then the lift already
      // sent its 0x07 and the item is on the cursor; the second click
      // will be handled by the `dragDrop.isHolding()` branch above as
      // a drop-to-ground / drop-on-mobile, which is the correct UX
      // ("click pick up, click put down").
      if (itemHit.movable) {
        dragDrop.tryLift({
          serial: itemHit.serial, itemId: itemHit.itemId,
          hue: itemHit.hue, amount: itemHit.amount,
        });
        return;
      }
      // Non-movable: arm DC watch and emit a single LookReq so the
      // overhead text still works on doors / signposts.
      net.send(buildLookReq(itemHit.serial));
      this._armDoubleClick(itemHit.serial);
      return;
    }
    // Empty ground click — no-op for LMB. Walk is bound to RMB-hold
    // (canonical UO behaviour: LMB = look/grab/use, RMB = walk). This
    // stops every accidental LMB on the world from kicking the avatar
    // off in the wrong direction.
    void e;
  }

  /** Double-click classifier (250 ms threshold, CUO default). The first
   *  click arms `_dcSerial` + `_dcExpireAt`; a second click on the same
   *  serial within the window returns true and the caller upgrades the
   *  gesture to UseReq. Non-aliased serials clear the prior arm so a
   *  click on A then B doesn't mis-fire double on B. */
  _isDoubleClick(serial) {
    const s = serial >>> 0;
    return this._dcSerial === s && performance.now() < (this._dcExpireAt ?? 0);
  }
  _armDoubleClick(serial) {
    this._dcSerial = serial >>> 0;
    this._dcExpireAt = performance.now() + 250;
  }
  _clearDoubleClick() {
    this._dcSerial = 0;
    this._dcExpireAt = 0;
  }

  /** Auto-LookReq (0x09) for any mobile we don't yet have a name for.
   *  Without this the overhead label hangs at `0xSERIAL` until the user
   *  manually clicks the mobile or opens its paperdoll (which carries
   *  the name in the 0x88 reply). Deduplicated per-serial so we don't
   *  spam the server when the same mobile re-enters view. */
  _requestName(serial) {
    const s = (serial ?? 0) >>> 0;
    if (!s || this._namesRequested.has(s)) return;
    const m = world.mobiles.get(s);
    if (m?.name) { this._namesRequested.add(s); return; }
    this._namesRequested.add(s);
    net.send(buildLookReq(s));
  }

  _onRightDown(e) {
    // RMB on a gump = close-it gesture (UIManager handles the actual
    // close). DON'T fall through to popup-menu / pathfind / walk —
    // Marcin: "kliknięcie prawym na gumpie zamyka go ALE postać się
    // rusza". This early-return matches `_onLeftDown`'s gump guard.
    if (this._ui?.pickAtScreen(e.clientX, e.clientY)) return;
    if (!this._isInsideGameViewport(e.clientX, e.clientY)) return;
    const hit = this._pickWorldEntity(e.clientX, e.clientY);
    if (hit?.serial) {
      e.preventDefault();
      this._lastRClickX = e.clientX;
      this._lastRClickY = e.clientY;
      net.send(buildPopupMenuRequest(hit.serial));
      return;
    }
    // Pathfinder autowalk on RMB-DC over empty ground (CUO behaviour).
    // First RMB starts a 350 ms window; the second RMB inside that
    // window kicks off the path computation and supersedes the
    // hold-walk that the first RMB began. Single RMB on ground also
    // has no other meaning, so we don't lose any other gesture.
    const now = performance.now();
    if (this._lastRClickT && now - this._lastRClickT < 350) {
      this._lastRClickT = 0;
      this._mouseHeld = false;       // pathfind takes over from hold-walk
      const tile = this._pickWorldTile(e.clientX, e.clientY);
      if (tile) this._beginAutowalk(tile.x, tile.y);
      e.preventDefault();
      return;
    }
    this._lastRClickT = now;
    // RMB-hold = mouse-walk. Capture the shift modifier so
    // `_maybeMouseWalk` can promote the cadence to run (CUO uses the
    // same convention: pressing shift before holding RMB forces run
    // for the entire hold).
    this._mouseHeld = true;
    this._mouseShift = !!e.shiftKey;
    this._mouseAutoRun = false;
    this._cancelAutowalk();
    const playerPoint = this._playerScreenPoint();
    this._mouseDx = e.clientX - playerPoint.x;
    this._mouseDy = e.clientY - playerPoint.y;
    this._mouseInside = true;
    // Audit rev.4 P2 — arm RMB-drag-pan detection. If the user drags
    // the mouse more than RMB_PAN_THRESHOLD px before releasing, we
    // switch from "walk" to "pan" mode for the rest of the hold. Stash
    // the down-position so the move handler can measure delta.
    this._rmbDownX = e.clientX;
    this._rmbDownY = e.clientY;
    this._rmbPanActive = false;
    this._maybeMouseWalk(now);
    e.preventDefault();
  }

  /** Compute an A* path from the player to (tx,ty) and feed each step
   *  into the existing _sendMove pipeline at WALK cadence. Cancels any
   *  previous autowalk in flight. */
  _beginAutowalk(tx, ty) {
    this._cancelAutowalk();
    if (!world.player) return;
    const requestId = this._autowalkRequestId ?? 0;
    const player = {
      x: world.player.x | 0,
      y: world.player.y | 0,
      z: world.player.z | 0,
      map: (world.player.map ?? world.player.mapId ?? world.mapId ?? 1) | 0,
    };
    pathfindAsync(player, tx | 0, ty | 0)
      .then((dirs) => {
        if (requestId !== this._autowalkRequestId) return;
        if (!dirs || !dirs.length) {
          this._appendJournal('[system] No path to that tile.');
          return;
        }
        this._autowalk = { dirs, idx: 0 };
      })
      .catch(() => {
        if (requestId === this._autowalkRequestId) {
          this._appendJournal('[system] No path to that tile.');
        }
      });
  }

  _cancelAutowalk() {
    this._autowalk = null;
    this._autowalkRequestId = ((this._autowalkRequestId ?? 0) + 1) >>> 0;
  }

  _tickAutowalk(now) {
    const aw = this._autowalk;
    if (!aw) return;
    if (aw.idx >= aw.dirs.length) { this._autowalk = null; return; }
    // Bail when the walker is in a server-resync state (0x21 reject
    // with `resyncRequested` set). Continuing would push more steps
    // along a stale path and amplify the desync.
    if (walker.resyncRequested) {
      this._autowalk = null;
      return;
    }
    if (!walker.canStep(now)) return;
    const dir = aw.dirs[aw.idx++];
    this._sendMove(dir, false, now);
  }

  /** Convert a screen-space click to the world tile beneath. Uses the
   *  current camera (screen center = camera.cx). */
  _pickWorldTile(sx, sy) {
    return this._worldPicker.pickTile(sx, sy);
  }

  _worldScreenPoint(x, y, z = 0) {
    return this._worldPicker.worldScreenPoint(x, y, z);
  }

  /** Exact rendered player foot position, including an in-flight predicted
   * step. Mouse-walk used the viewport centre before, which becomes wrong
   * after camera peeking, elevation changes and while a step is lerping;
   * the resulting angle could cross an octant and send the player backwards. */
  _playerScreenPoint() {
    return this._worldPicker.playerScreenPoint();
  }

  /** Return the topmost world ITEM under (sx, sy), or null.
   *  Items in `world.items` with no parent (parent==0|null) are on the
   *  ground; equipped / contained items have parent set and are skipped.
   *  Returns `{ serial, itemId, hue, amount, movable }`. The `movable`
   *  flag mirrors server-side ground-drop emission (0x1A flags & 0x20)
   *  so the click handler can decide lift vs use without a round trip. */
  _pickWorldItem(sx, sy) {
    return this._worldPicker.pickItem(sx, sy);
  }

  /** Hit-test map statics so target cursors can select sta*.mul doors,
   * signs and decorations, not only runtime items. */
  _pickWorldStatic(sx, sy) {
    return this._worldPicker.pickStatic(sx, sy);
  }

  /** Return `{ serial }` of the topmost world mobile under (sx, sy), or null.
   *  Cheap: scans the nearby mobile spatial bucket once per call.
   *
   *  Hit-test geometry is sprite-aware: a UO body sprite occupies roughly
   *  a 22 px wide × 78 px tall rectangle anchored at the foot tile.
   *  The earlier `max(|sx-screenX|,|sy-screenY|) < TOL` only matched
   *  clicks within ~14-18 px of the FOOT — clicking the head or torso
   *  reported "no entity" → caller (target prompt, attack click) treated
   *  it as a miss and SENT CANCEL to the server. Marcin: clicked an orc
   *  while casting magic-arrow, got "Targeting cancelled" then game
   *  froze waiting for a spell that never resolved.
   *
   *  Box matches CUO `Animations.cs:GetSpriteHitArea` — wide enough to
   *  cover the body silhouette while still letting adjacent mobs win
   *  the closest-foot tie-break. */
  _pickWorldEntity(sx, sy) {
    return this._worldPicker.pickEntity(sx, sy);
  }

  /** Hit-test all viewport-corner Pixi widgets (zoom buttons + resize
   *  handle). Returns true when (sx, sy) lands on one of them. */
  _isUiHotspot(sx, sy) {
    let w = this._zoomInBtn;
    if (w?.visible && w.hitArea?.contains?.(sx - w.x, sy - w.y)) return true;
    w = this._zoomOutBtn;
    if (w?.visible && w.hitArea?.contains?.(sx - w.x, sy - w.y)) return true;
    w = this._resizeHandle;
    return !!(w?.visible && w.hitArea?.contains?.(sx - w.x, sy - w.y));
  }

  _isInsideGameViewport(sx, sy) {
    return sx >= camera.viewX && sx <= camera.viewX + camera.viewW
      && sy >= camera.viewY && sy <= camera.viewY + camera.viewH;
  }

  _maybeMouseWalk(now = performance.now()) {
    if (!this._mouseHeld || !this._mouseInside) return;
    // Client audit #5 #5 — when a target cursor is up the player is
    // mid-flow (Mark/Recall/heal target); RMB-hold-to-walk shouldn't
    // hijack the gesture. Wait until the cursor closes.
    if (targetManager?.active) return;
    // Walker is the single cadence authority for turns/walk/run. The old
    // `_nextWalkAt` gate duplicated the same throttle and advanced even when
    // `_sendMove` failed to reserve a step (ACK pressure / a prior walk still
    // finishing). That made a walk→run transition keep walking cadence and
    // was the source of the "different animation, same speed" report.
    if (!walker.canStep(now)) return;
    // Dead zone — pivot ~½ tile around the player avatar so a small
    // nudge starts walking. CUO uses ~14 px radius (player feet); we
    // match by squaring TILE_HALF_W * 0.6 ≈ 13 px. Without a generous
    // pull-in the user has to drag the cursor noticeably before the
    // avatar starts moving.
    const r2 = this._mouseDx * this._mouseDx + this._mouseDy * this._mouseDy;
    const DEAD_ZONE_PX = TILE_HALF_W * 0.6;
    if (r2 < DEAD_ZONE_PX * DEAD_ZONE_PX) return;

    // Run modifiers — user report 2026-05-18: "postać nie biega gdy
    // odsuwam mysz dalej od postaci". Auto-run kicks in past ~2.5 tile
    // half-widths (~55 px), matching CUO retail's "anywhere past your
    // own feet circle = run". Was 5 tiles (110 px) which forced a wide
    // drag before run engaged. Shift still forces immediate run.
    const movementMode = resolveMouseRunState(r2, this._mouseAutoRun, this._mouseShift);
    this._mouseAutoRun = movementMode.autoRun;
    const run = movementMode.run;

    const dir = mouseAngleToDirection(this._mouseDx, this._mouseDy);
    // Direction-change → turn-only step. Walker.reserve selects the
    // canonical 80/200/400ms delay after it knows whether this packet really
    // reserved a turn, run or walk.
    this._sendMove(dir, run, now);
  }

  // -------------------------------------------------------------------------
  // Arrow-key fallback (until we wire targeting/chat properly).

  _onKey = (e) => {
    if (e.__uoUiHandled) return;
    if (document.activeElement instanceof HTMLInputElement) return;

    // ESC cancels active target prompt.
    if (e.key === 'Escape' && targetManager.active) {
      e.preventDefault();
      targetManager.cancel();
      return;
    }
    // Audit #33 P2.5 — CUO `GameSceneInputHandler.OnKeyDown` ESC chain:
    // cancel target → close top context menu → close top resizable
    // gump → close text-entry. We had only the first step; now also
    // close the top-most closable gump so ESC during a rename dialog
    // or container view actually dismisses it.
    if (e.key === 'Escape') {
      const top = this._ui?.topClosableGump?.();
      if (top) {
        e.preventDefault();
        try { top.close?.() ?? this._ui.removeGump?.(top); }
        catch { /* gump disposed mid-close */ }
        return;
      }
    }

    // Enter while game viewport has focus → activate the chat input
    // box at the bottom. CUO does the same — saves the user from
    // having to click the input every time they want to type chat or
    // a `[command`. The `activeElement` guard at the top of this
    // handler already lets the chat input keep focus once it has it
    // (Enter inside the input fires the input's own keydown, which
    // sends the line and blurs back to game).
    if (e.key === 'Enter' && this._chatInput && !targetManager.active) {
      e.preventDefault();
      try { this._chatInput.focus(); }
      catch { /* element detached */ }
      return;
    }

    // Tab toggles war mode (CUO default).
    if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      this._warMode = !this._warMode;
      net.send(buildWarMode(this._warMode));
      this._appendJournal(this._warMode ? '[system] War mode ON' : '[system] War mode OFF');
      return;
    }

    // Number row activates the unified action bar. Actions themselves use
    // standard UO packets, so this shortcut works against foreign shards too.
    if (!e.altKey && !e.ctrlKey && !e.metaKey && /^[0-9]$/.test(e.key)) {
      const bar = this._ui?.findGump?.((g) => g._toggleKey === 'actionbar');
      if (bar) {
        e.preventDefault();
        bar.activate(e.key === '0' ? 9 : Number(e.key) - 1);
        return;
      }
    }

    // UI hotkeys mirror common ClassicUO defaults (Paperdoll/Journal/etc).
    if (!e.altKey && !e.ctrlKey && !e.metaKey) {
      switch (e.key.toLowerCase()) {
        case 'p':
          // Round-trip 0x06 → 0x88 so the server fills in the title /
          // can-lift bit. Without this the paperdoll would open empty
          // and the avatar would show as `0x{serial}` instead of the
          // character's actual name.
          if (world.player) net.send(buildUseReq(world.player.serial));
          else this._toggleGump('paperdoll', () => new PaperdollGump(world.player?.serial ?? 0));
          e.preventDefault(); return;
        case 'j': this._toggleGump('journal',   () => new JournalGump());                          e.preventDefault(); return;
        case 'k': this._toggleGump('skills', () => profile.get('experimental.useStandardSkillsGump')
          ? new SkillsGump() : new SkillGumpAdvanced());                                          e.preventDefault(); return;
        case 't': this._toggleGump('status',    () => new StatusGump());                           e.preventDefault(); return;
        case 'm': this._toggleGump('minimap',   () => new MinimapGump());                          e.preventDefault(); return;
        case 'r': this._toggleGump('party',     () => new PartyGump());                            e.preventDefault(); return;
        case 'o': this._toggleGump('options',   async () => new (await lazyOptions())());          e.preventDefault(); return;
      }
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'm') {
      this._toggleGump('worldmap', async () => new (await lazyWorldmap())());
      e.preventDefault(); return;
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'n') {
      this._toggleGump('name-overhead', async () => new (await lazyNameOverHead())());
      e.preventDefault(); return;
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'i') {
      this._toggleGump('network-stats', async () => new (await lazyNetworkStats())());
      e.preventDefault(); return;
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
      this._toggleGump('resource-diagnostics', async () => {
        const { ResourceDiagnosticsGump } = await import('../ui/gumps/resource-diagnostics-gump.js');
        return new ResourceDiagnosticsGump();
      });
      e.preventDefault(); return;
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'x') {
      this._toggleGump('inspector', async () => new (await lazyInspector())());
      e.preventDefault(); return;
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c') {
      this._toggleGump('chat', async () => new (await lazyChat())());
      e.preventDefault(); return;
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'r') {
      this._toggleGump('racial-abilities',
        async () => new (await lazyRacialAbilities())(world.player?.race ?? 'human'));
      e.preventDefault(); return;
    }
    const dir = DIR_KEYS[e.key];
    if (dir == null) return;
    e.preventDefault();
    // Audit #39 client P2 #10 — CUO `GameSceneInputHandler.OnKeyDown`
    // treats Ctrl+ArrowKey as a "turn only" — face the cardinal
    // without taking a step. `_sendMove` already emits a turn-only
    // 0x02 when direction differs (CUO Mobile.cs:743-779 commits the
    // step on the second same-direction press); we just need to skip
    // adding the dir to `_heldDirs` so the per-frame pump doesn't
    // immediately turn it into a walk.
    if (e.ctrlKey && world.player && (world.player.direction & 7) !== (dir & 7)) {
      this._sendMove(dir, false);
      return;
    }
    // Track held direction so the per-frame `_tickHeldKeyWalk` keeps
    // sending steps at exactly walker.canStep cadence — independent of
    // the browser's key-repeat (which has a ~500 ms initial delay,
    // producing the visible "skok" between the first step and the
    // sustained walk). The keydown still fires `_sendMove` immediately
    // so the first step has zero perceived latency.
    if (!this._heldDirs) this._heldDirs = new Set();
    this._heldDirs.add(dir);
    this._heldDirsRun = !!e.shiftKey;
    // Walker handles the throttle; browser key-repeat timing is irrelevant.
    // Use the resolved diagonal so pressing the 2nd cardinal of a pair
    // (e.g. W then D) immediately steps NE instead of stepping E first.
    const resolved = this._resolveHeldDirection();
    this._sendMove(resolved >= 0 ? resolved : dir, e.shiftKey);
  };

  _onKeyUp = (e) => {
    const dir = DIR_KEYS[e.key];
    if (dir == null) return;
    this._heldDirs?.delete(dir);
    if (this._heldDirs && this._heldDirs.size === 0) this._heldDirsRun = false;
  };

  /** Per-frame walk pump for held arrow keys. Called from `update(dt)`.
   *  The browser's key-repeat fires every ~33 ms but only after a
   *  ~500 ms initial-delay — so without this pump the avatar walked
   *  one step on keydown then froze for half a second before the
   *  repeat kicked in. With the pump, walker's 400 ms / 200 ms throttle
   *  becomes the only gate and movement is perfectly continuous. */
  _tickHeldKeyWalk(now = performance.now()) {
    if (!this._heldDirs || this._heldDirs.size === 0) return;
    if (!walker.canStep(now)) return;
    const dir = this._resolveHeldDirection();
    if (dir < 0) return;
    this._sendMove(dir, this._heldDirsRun, now);
  }

  /** Combine simultaneously-held cardinals into one of 8 UO directions.
   *  Pressing W+D produces NE (1) instead of falling back to last-pressed.
   *  Without this, holding two keys at once snapped between cardinals
   *  every frame and the avatar walked in 4 directions only — even
   *  though the sprite has 8-direction frames in anim.mul. */
  _resolveHeldDirection() {
    const has = (d) => this._heldDirs.has(d);
    const n = has(0), e = has(2), s = has(4), w = has(6);
    if (n && e) return 1;     // NE
    if (e && s) return 3;     // SE
    if (s && w) return 5;     // SW
    if (w && n) return 7;     // NW
    if (n) return 0;
    if (e) return 2;
    if (s) return 4;
    if (w) return 6;
    return -1;
  }

  /** Toggle a singleton gump identified by `key`. If the gump is open it
   *  closes; otherwise the factory's gump is added. The factory may return
   *  either a gump instance (eager import) or a Promise resolving to one
   *  (lazy `await import(...)`). Lazy mode lets rarely-opened gumps stay
   *  out of the main bundle until the player first opens them. */
  _toggleGump(key, factory) {
    if (!this._ui) return null;
    const existing = this._ui.findGump((g) => g._toggleKey === key);
    if (existing) { this._ui.removeGump(existing); return null; }
    const r = factory();
    if (r && typeof r.then === 'function') {
      r.then((g) => {
        if (!g || !this._ui) return;
        // Player may have closed it (or re-toggled) while the chunk was
        // streaming — drop the late instance instead of double-mounting.
        if (this._ui.findGump((x) => x._toggleKey === key)) {
          try { g.destroy?.(); } catch { /* ignore */ }
          return;
        }
        g._toggleKey = key;
        g._reopenFactory = factory;
        this._ui.addGump(g);
      }).catch((e) => console.error(`[gump:${key}] lazy load failed:`, e));
      return null;
    }
    r._toggleKey = key;
    r._reopenFactory = factory;
    this._ui.addGump(r);
    return r;
  }

  /**
   * Client-side movement prediction. Mirrors the standard MMO/FPS
   * pattern: simulate the move locally the moment input arrives, send
   * 0x02 to the server in parallel, and only react to the server's
   * reply if it disagrees (0x21 reject → rollback to authoritative
   * position).
   *
   * Earlier the avatar waited for 0x22 movementAck before applying
   * x/y/z and the walk lerp — every step paid a full WS round-trip
   * (5–50 ms localhost, 50–150 ms over real network), which felt like
   * stop-and-go even with smooth pixel interpolation. With prediction
   * the sprite responds the instant the player presses an arrow key
   * or drags the mouse-walk cursor, and the server's ack is mostly
   * an idle confirmation we discard.
   */
  _sendMove(direction, run, now = performance.now()) {
    const p = world.player;
    if (!p) return;
    // Walker manages the seq + fast-walk-key + 5-step in-flight cap.
    // `directionOnly` flips when the first step in a new facing is just
    // a turn (CUO Mobile.cs:743-779).
    const directionOnly = p.direction !== direction;
    // Mounted players step 2× faster — CUO `MovementSpeed.cs`. Pass
    // through to walker so the canStep throttle matches what the
    // server expects, otherwise mounted runs trigger 0x21 reject thrash.
    const mounted = !!(p.isMounted || p.equipment?.get?.(25));
    const reservation = walker.reserve(run, directionOnly, now, mounted);
    if (!reservation) return;
    const seq = reservation.sequence;
    // Mirror into the legacy `world.moveSequence` so any other code that
    // peeks at it stays in sync.
    world.moveSequence = seq;
    const dirByte = direction | (run ? 0x80 : 0x00);

    // PREDICT — apply the step locally before the network round-trip.
    if (p.direction !== direction) {
      // CUO walking semantics (Mobile.cs:743-779): the first step in
      // a new facing is just a turn. The avatar pivots in place and
      // commits to walk on the next same-direction step.
      p.direction = direction;
      this._pendingMoves.set(seq, { dir: direction, run, kind: 'turn' });
    } else {
      const [dx, dy] = DIR_DELTA[direction];
      const oldX = p.x, oldY = p.y, oldZ = p.z;
      // Local walkability check — when we KNOW the destination is
      // blocked (impassable wall/door/chest with no surface), refuse
      // the prediction so the sprite doesn't visually walk INTO the
      // wall before the server's 0x21 MovementRej arrives and snaps
      // it back. ServUO's `resolveStep` mirrors this gate. Local
      // blocker only — ambiguous cases still go to the server who
      // has the authoritative statics + NPC occupancy.
      const mapId = p.map ?? world.mapId ?? 1;
      if (isLocallyBlocked(p.x + dx, p.y + dy, oldZ, mapId)) {
        // Still consume the sequence so seq numbering stays linear;
        // emit a turn-only step instead. Avoid `_pendingMoves` since
        // we never sent the 0x02.
        movementStats.localBlocks++;
        recordMovementTrace('local-block', { x: p.x + dx, y: p.y + dy, z: oldZ, dir: direction }, now);
        walker.releaseToTurn?.(reservation);
        return;
      }
      const newZ = resolveLocalStandingZ(p.x + dx, p.y + dy, oldZ, mapId);
      p.x = oldX + dx;
      p.y = oldY + dy;
      p.z = newZ;
      world.reindexMobile?.(p, oldX, oldY, p.map ?? 1);
      const dz = newZ - oldZ;
      // Lerp duration MUST match walker.js STEP_DELAY (400/200) so the
      // sprite finishes sliding exactly when the next step is ready —
      // shorter lerps left a visible pause every tile (Marcin's
      // "skacze przerywa" report).
      const dur = reservation.delayMs;
      // Pass the protocol run bit explicitly. Inferring it from duration made
      // a mounted WALK (200 ms) look like Run even though the packet and
      // footsteps still represented walking.
      p.beginMoveStep(dx, dy, dz, dur, now, run);
      const sprite = this._mobiles?.sprites.get(p.serial);
      if (sprite) sprite.markMoving(now, run, dur);
      this._pendingMoves.set(seq, {
        dir: direction, run, kind: 'walk',
        sentAt: now,
        delayMs: reservation.delayMs,
        // Snapshot for rollback on 0x21 reject.
        prev: { x: oldX, y: oldY, z: oldZ, direction: p.direction },
      });
    }
    const pending = this._pendingMoves.get(seq);
    if (pending && !pending.sentAt) {
      pending.sentAt = now;
      pending.delayMs = reservation.delayMs;
    }
    net.send(buildMovementReq(dirByte, seq, reservation.fastWalkKey));
    movementStats.sent++;
    recordMovementTrace('send', {
      seq, dir: direction, run: run ? 1 : 0,
      kind: this._pendingMoves.get(seq)?.kind ?? 'unknown',
      delayMs: reservation.delayMs,
    }, now);
  }

  _onMovementAck({ sequence, notoriety }) {
    const pending = this._pendingMoves.get(sequence);
    walker.onAck(sequence);
    // A late ACK can belong to a step queued before a rejection. It must
    // not release the resync latch: only the authoritative self 0x20 update
    // does that in net/handlers.js.
    // The client already simulated this step in `_sendMove`. Just
    // drop the pending entry and accept the notoriety byte the server
    // attached. No position/animation work here — doing it would
    // restart the in-flight lerp and reintroduce the stop-and-go
    // jitter the prediction was meant to eliminate.
    if (pending?.sentAt) {
      const latency = Math.max(0, performance.now() - pending.sentAt);
      movementStats.lastAckLatencyMs = latency;
      movementStats.avgAckLatencyMs = movementStats.avgAckLatencyMs
        ? movementStats.avgAckLatencyMs * 0.9 + latency * 0.1
        : latency;
      recordMovementTrace('ack', { seq: sequence, latencyMs: latency | 0 });
    }
    this._pendingMoves.delete(sequence);
    if (world.player) world.player.notoriety = notoriety;
  }

  _onMovementRej({ sequence, x, y, z, direction }) {
    // Server says the predicted step was illegal (e.g. partial-loaded
    // statics let the client think a wall was open, or another mobile
    // moved into the tile mid-flight). Roll back to the authoritative
    // (x,y,z) the rejection packet carries and snap the sprite.
    walker.onRej({ sequence, x, y, z, direction });
    const pending = this._pendingMoves.get(sequence);
    this._pendingMoves.delete(sequence);
    const p = world.player;
    if (!p) return;
    const oldX = p.x, oldY = p.y, oldMap = p.map ?? 1;
    // 0x21 echoes the protocol direction byte, including bit 0x80 for run.
    // Keeping that bit in Mobile.direction made the next comparison against
    // a logical 0..7 direction look like a facing change, so a rejected run
    // was followed by a fake turn-only request. Under occasional ACK/speed
    // rejects this repeatedly collapsed run throughput toward walk speed.
    p.x = x; p.y = y; p.z = z; p.direction = direction & 0x07;
    world.reindexMobile?.(p, oldX, oldY, oldMap);
    // Snap visual offset to zero — interrupting the in-flight lerp so
    // the avatar doesn't keep sliding toward the rejected tile.
    p.offsetX = p.offsetY = p.offsetZ = 0;
    p.offsetEndAt = 0;
    world.moveSequence = 0;
    // Future pending moves (inputs that fired between the predicted
    // step and the reject arriving) are no longer valid — drop them
    // so the server doesn't see a chain that diverges further.
    this._pendingMoves.clear();
    this._cancelAutowalk();
    // WebSocket ordering drains all already queued 0x02 packets before the
    // server handles this request. Keep input paused until the resulting
    // authoritative 0x20 self update arrives.
    bus.emit('net:resync-request');
    void pending;
  }

  _sub(topic, fn) { this._unsubs.push(bus.on(topic, fn)); }

  /** Lazy-import LoginScene (avoid circular import at module load) and
   *  swap to it after a server-side disconnect OR a user-initiated
   *  logout. Resets the world either way. `userInitiated` skips the
   *  "Connection lost" modal — clicking Logout in the topbar / paperdoll
   *  is a deliberate exit, not a kick, and surfacing a red modal
   *  ("Disconnected from server.") for it is misleading. */
  async _onDisconnected(reason, userInitiated = false) {
    if (this._unloading) return;
    this._unloading = true;
    // Audit #39 client P1 #3 — unbind per-character profile on logout
    // so the next character (or relog) picks up fresh defaults instead
    // of inheriting the prior character's gump layout.
    try { profile.bindCharacter(null, null); } catch { /* best effort */ }
    const msg = reason ? `Disconnected: ${reason}` : 'Disconnected from server.';
    this._appendJournal(`[system] ${userInitiated ? 'Logged out.' : msg}`);
    // Close the WS so the server can flush the player's save before
    // the frame closes. For server-initiated disconnects the socket is
    // already torn down so this is a no-op.
    if (userInitiated) {
      try { net.close?.(); } catch { /* socket already torn down */ }
    }
    // CUO `LoginScene` shows a modal with the reason + reconnect
    // button on a server kick / ping timeout — but a deliberate
    // logout doesn't need it. Skip the modal for userInitiated; show
    // it only on real server-initiated kicks. The Reconnect button
    // just dismisses the modal — the underlying scene is already
    // LoginScene where the user can re-enter creds. Was: it called
    // `location.reload()` which threw the whole page state away and
    // re-downloaded assets — jarring + slow.
    if (!userInitiated) {
      try {
        const el = document.createElement('div');
        el.id = 'uo-disconnect-modal';
        el.style.cssText = `
          position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:9500;
          display:flex; align-items:center; justify-content:center;
          font-family:'Consolas',monospace;
        `;
        el.innerHTML = `
          <div style="background:#1a1208;border:1px solid #6a4a18;padding:18px 24px;color:#fff0c0;min-width:300px;text-align:center">
            <div style="font-size:14px;margin-bottom:10px;color:#ff8a5a">Connection lost</div>
            <div style="font-size:12px;margin-bottom:14px;opacity:.9">${msg}</div>
            <button id="uo-reconnect" style="padding:6px 18px;background:#3a2a14;color:#ffd070;border:1px solid #6a4a18;cursor:pointer;font-family:inherit">OK</button>
          </div>`;
        document.body.appendChild(el);
        el.querySelector('#uo-reconnect')?.addEventListener('click', () => {
          el.remove();
        });
      } catch { /* DOM gone, fall through */ }
    }
    world.reset();
    const { LoginScene } = await import('./login-scene.js');
    await this.gc.setScene(new LoginScene(this.gc));
  }

  // -------------------------------------------------------------------------
  // Server-driven gumps

  _onContainerOpen(info) {
    if (!this._ui) return;
    // Spellbook ids (0xFFB1..0xFFB7) get a dedicated gump.
    const id = info.gumpId & 0xffff;
    // Cascade subsequent containers via ContainerManager so two open
    // bags don't sit on top of each other at (40,40).
    // Audit #46 P1 — pass gumpId so containerManager._posMemo lookup
    // can return the per-graphic remembered position.
    const cached = profile?.loadGumpState?.(`container:${info.serial >>> 0}`);
    const pos = containerManager.calculateOpenPosition({
      gumpId: id,
      lastPosition: cached ? { x: cached.x, y: cached.y } : null,
    });
    const factory = (id >= 0xFFB1 && id <= 0xFFB7)
      ? () => new SpellbookGump(info.serial, id)
      : () => new ContainerGump(info.serial, id, pos.x, pos.y);
    const key = `container:${info.serial >>> 0}`;
    const existing = this._ui.findGump((g) => g._toggleKey === key);
    if (existing) this._ui.removeGump(existing);
    const g = factory();
    g._toggleKey = key;
    g._reopenFactory = factory;
    this._ui.addGump(g);
  }

  _onGumpOpen(info) {
    if (!this._ui) return;
    // If a gump with the same gumpSerial is already open, replace it
    // BUT preserve its current screen position so re-opens (e.g. page-
    // flip on [items / [mobs which both use stable gumpIds) don't snap
    // the gump back to the server-supplied origin. User-report: "jak
    // zmieniamy strone to zachowuj pozycje gumpa zeby nie skakal".
    const existing = this._ui.findGump((g) => g.gumpSerial === info.gumpSerial);
    let preserved = null;
    if (existing) {
      preserved = { x: existing.x | 0, y: existing.y | 0 };
      this._ui.removeGump(existing);
    }
    let gump;
    try {
      gump = parseGumpLayout(info);
    } catch (e) {
      console.error('[gump] parse failed', e, info.layout);
      return;
    }
    if (preserved) gump.setPosition(preserved.x, preserved.y);
    this._ui.addGump(gump);
  }
}

/** Walk a gump tree and gather all checked Checkbox.switchId values. */
function collectSwitches(root) {
  const out = [];
  (function visit(c) {
    if (c instanceof Checkbox && c.checked) out.push(c.switchId);
    for (const ch of c.children) visit(ch);
  })(root);
  return out;
}

/** Walk a gump tree and gather every TextInput's current value. */
function collectTextEntries(root) {
  const out = [];
  (function visit(c) {
    if (c instanceof TextInput) out.push(c.serializeResponse());
    for (const ch of c.children) visit(ch);
  })(root);
  return out;
}

const DIR_KEYS = {
  ArrowUp: 0, ArrowRight: 2, ArrowDown: 4, ArrowLeft: 6,
  w: 0, d: 2, s: 4, a: 6,
  W: 0, D: 2, S: 4, A: 6,
};

const DIR_DELTA = [
  [ 0, -1], // 0 N
  [ 1, -1], // 1 NE
  [ 1,  0], // 2 E
  [ 1,  1], // 3 SE
  [ 0,  1], // 4 S
  [-1,  1], // 5 SW
  [-1,  0], // 6 W
  [-1, -1], // 7 NW
];

/** Convert a screen-space mouse delta from the player to a UO direction
 * (0..7). Mirrors ClassicUO's GameSceneInputHandler MouseToDirection.
 *
 * The isometric world is rotated 45°: tile-East axis runs visually
 * down-right (SE on screen), tile-South runs down-left (SW on screen).
 * So a cursor placed visually-east means the player should walk NE in
 * tile space.
 */
function mouseAngleToDirection(dx, dy) {
  let angle = Math.atan2(dy, dx);            // 0 = right, +π/2 = down
  if (angle < 0) angle += 2 * Math.PI;
  // 8 octants of size π/4, with ±π/8 hysteresis around each centre.
  const octant = Math.floor((angle + Math.PI / 8) / (Math.PI / 4)) % 8;
  // Screen octants (CCW from E): 0=E, 1=SE, 2=S, 3=SW, 4=W, 5=NW, 6=N, 7=NE.
  // UO directions: 0=N, 1=NE, 2=E, 3=SE, 4=S, 5=SW, 6=W, 7=NW.
  // After the 45° world rotation, screen-E maps to tile-NE, etc.
  const SCREEN_OCT_TO_UO = [1, 2, 3, 4, 5, 6, 7, 0];
  return SCREEN_OCT_TO_UO[octant];
}
