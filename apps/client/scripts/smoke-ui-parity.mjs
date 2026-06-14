import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

function requireNeedles(label, source, needles) {
  for (const needle of needles) {
    assert.ok(source.includes(needle), `${label} should include ${needle}`);
  }
}

const login = read('../src/scenes/login-scene.js');
requireNeedles('LoginScene flow', login, [
  'LoginSteps = Object.freeze',
  'ServerSelection',
  'CharacterSelection',
  'CharacterCreation',
  '_renderServerSelection()',
  '_renderCharacterSelection()',
  '_renderCcAppearance()',
  '_renderCcProfession()',
  '_submitCreation(cityIndex)',
]);
requireNeedles('LoginScene server/character selection parity', login, [
  'uo-server-list',
  'uo-char-list',
  'this._cities = info.cities ?? []',
  'this._cities?.[0]?.index ?? 0',
]);
requireNeedles('Character creation parity', login, [
  'normalizeCreationSkills',
  '_loadCustomProfessions(assets)',
  'assets.professions',
  'normalizeCreationAppearance',
  'creationSkinHues(c.race)',
  'creationHairStyles(c.race, c.sex)',
  'creationBeardStyles(c.race, c.sex)',
  'cc-race',
  'Human',
  'Elf',
  'Gargoyle',
  'uo-city-list',
]);

requireNeedles('ProfileGump edit/save', read('../src/ui/gumps/profile-gump.js'), [
  'buildProfileUpdate',
  'this._editor.value',
  "get positionKey() { return 'profile'; }",
]);

requireNeedles('NameOverheadHandler filters', read('../src/ui/gumps/name-overhead-handler-gump.js'), [
  "profile.get('nameOverhead.showOwn')",
  "profile.get('nameOverhead.showItems')",
  'NameOverheadManager',
]);

requireNeedles('NameOverheadPopup actions', read('../src/ui/gumps/name-overhead-popup-gump.js'), [
  'buildAttackReq',
  'buildUseReq',
  'buildLookReq',
  'buildPopupMenuRequest',
  "get type() { return 'name-overhead-popup'; }",
]);

requireNeedles('AnchorManager opt-in', read('../src/managers/anchor-manager.js'), [
  'AnchorManager',
  "bus.on('gump:dragged'",
  "bus.on('gump:dropped'",
  'gump?.anchorable !== false',
]);
requireNeedles('UIManager anchor registration', read('../src/ui/ui-manager.js'), [
  'gump.anchorable !== false',
  '__anchorManager',
]);

requireNeedles('UseSpellButton hotbar', read('../src/ui/gumps/use-spell-button-gump.js'), [
  'readHotbarEntries',
  'writeHotbarEntries',
  'icon.isDragHandle = true',
  "get positionKey() { return `use-spell:${this.spell?.id}`; }",
]);
requireNeedles('UseAbilityButton hotbar', read('../src/ui/gumps/use-ability-button-gump.js'), [
  'UseAbilityButtonGump',
  'icon.isDragHandle = true',
  "buildTextCommand(0x12, `wpn ${this.slot}`)",
  'get type() { return `use-ability:${this.slot}`; }',
]);
requireNeedles('Spell/ability source gumps', read('../src/ui/gumps/spellbook-gump.js'), [
  'UseSpellButtonGump',
  'ui._dragging',
]);
requireNeedles('CombatBook ability source', read('../src/ui/gumps/combat-book-gump.js'), [
  'UseAbilityButtonGump',
  'drag-source for UseAbilityButtonGump',
]);

requireNeedles('ResizableJournal', read('../src/ui/gumps/journal-gump.js'), [
  '_resizeHandle',
  '_resizeTo(w, h)',
  "profile.set('ui.journal'",
  'normalizeJournalFilters',
]);

requireNeedles('ShopGump buy/sell parity', read('../src/ui/gumps/buy-gump.js'), [
  'buildBuyRequest',
  'buildSellRequest',
  "get type() { return this.isSell ? 'sell-shop' : 'buy-shop'; }",
  "bus.on('drag:dropped-on-sell'",
]);

requireNeedles('Party invite parity', read('../src/ui/gumps/party-invite-gump.js'), [
  'buildPartyAccept',
  'buildPartyDecline',
  'party:invite',
]);
requireNeedles('PartyGump parity', read('../src/ui/gumps/party-gump.js'), [
  "bus.on('party:roster'",
  'buildPartyAdd',
  'buildPartyRemove',
  'partyManager.setCanLoot',
]);

requireNeedles('BuffGump icons/timeouts', read('../src/ui/gumps/buff-gump.js'), [
  "bus.on('buff:add'",
  "bus.on('buff:remove'",
  '_setTimer(duration)',
  "get type() { return 'buffs'; }",
]);
requireNeedles('ActiveIconsManager', read('../src/managers/active-icons-manager.js'), [
  "bus.on?.('buff:add'",
  "bus.on?.('buff:remove'",
  "bus.on?.('buff:clear'",
  "bus.emit?.('active-icons:changed')",
]);

requireNeedles('CounterBar drag/drop/use', read('../src/ui/gumps/counter-bar-gump.js'), [
  'function counterKey',
  'dragDrop.held',
  'dragDrop.reject',
  "profile.saveGumpState?.('counterbar'",
  "get type() { return 'counterbar'; }",
]);

requireNeedles('StatusGump values/locks', read('../src/ui/gumps/status-gump.js'), [
  'buildStatusRequest',
  'buildStatLockRequest',
  'str',
  'dex',
  'int',
  'followers',
  'gold',
  'weight',
]);

requireNeedles('Paperdoll layer hit tests', read('../src/ui/gumps/paperdoll-gump.js'), [
  'PaperDollInteractable',
  'PAPERDOLL_DRAW_ORDER',
  'dragDrop.dropToEquip',
  'dragDrop.dropToContainer',
  '_openSkinHuePicker',
]);
requireNeedles('PaperDollInteractable control', read('../src/ui/controls/paper-doll-interactable.js'), [
  'PaperDollInteractable',
  'layer = 0',
  'this.layer = layer | 0',
]);

requireNeedles('Container split/drag/drop', read('../src/ui/gumps/container-gump.js'), [
  'SplitMenuGump',
  'dragDrop.tryLift',
  'dragDrop.dropToContainer',
  '_dropAtPixel(gx, gy)',
  "get positionKey() { return `container:${this.containerSerial}`; }",
]);
requireNeedles('SplitMenu amount dialog', read('../src/ui/gumps/split-menu-gump.js'), [
  'SplitMenuGump',
  "label: 'All'",
  "label: 'OK'",
  "get type() { return 'split-menu'; }",
]);

requireNeedles('OptionsGump lazy tabs', read('../src/ui/gumps/options-gump.js'), [
  'this._tabContent = []',
  "this._showTab('audio')",
  '_showTab(id)',
  'this._contentScroll?.beginBulkUpdate?.()',
  'this._contentScroll?.remove?.(c)',
  'this._contentScroll?.scrollTo(0)',
  'target?.build(0)',
  'this._contentScroll?.endBulkUpdate?.()',
  '_refreshContentHeight()',
]);

const vendorSearch = read('../src/ui/gumps/vendor-search-gump.js');
requireNeedles('VendorSearch command-only results', vendorSearch, [
  'VendorSearchGump',
  'renderResultsToSysmsg',
  'const cmd = `vsearch ${parts.join(\' \')}`.trim();',
  'this._net.sendCommand(cmd)',
  "get type() { return 'vendor-search'; }",
]);
assert.ok(!vendorSearch.includes('ScrollArea'), 'VendorSearch should not keep a local scrollable result list');
assert.ok(!vendorSearch.includes('setRows'), 'VendorSearch should not rebuild client-side result rows');

console.log('[smoke:ui-parity] ok');
