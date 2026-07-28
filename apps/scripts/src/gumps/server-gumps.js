// Server-driven gumps — script-side layouts that the server triggers
// via api.systems.serverGumps. The engine only owns the dispatcher
// (state.activeGumps registry + 0xB0/0xDD packet builders); the layouts
// themselves are content and live here.
//
// Includes:
//   GuildGump            — guild roster / leave / promote
//   RaceChangeGump       — change race (Human / Elf / Gargoyle)
//   BulkOrderGump        — opens a BOD for inspection / combine / hand-in
//   HouseSecureInfoGump  — list lockdowns + secures count
//   RaffleGump           — house raffle UI (player vs raffle stone)
//   HelpCategoriesGump   — the 9-category picker shown on Help (0x9B)

import { configuredGump } from './definition-runtime.js';

/** Generic 5054 panel + text/button helpers. */
function panel(w, h) { return `{ resizepic 0 0 5054 ${w} ${h} }`; }

// ---- GuildGump -----------------------------------------------------------

export function openGuildGump(gumps, state, guild) {
  if (!guild) return;
  const members = guild.members ?? [];
  const layout = [
    panel(420, 320),
    `{ text 20 10 1153 0 }`,                  // guild name
    `{ text 20 32 1149 1 }`,                  // abbreviation
    `{ text 20 54 1149 2 }`,                  // member count line
  ];
  let y = 80;
  for (let i = 0; i < Math.min(members.length, 10); i++) {
    layout.push(`{ text 30 ${y} 1149 ${3 + i} }`);
    layout.push(`{ button 280 ${y} 4011 4012 1 0 ${100 + i} }`);   // promote
    layout.push(`{ button 320 ${y} 4017 4018 1 0 ${200 + i} }`);   // kick
    y += 20;
  }
  layout.push(`{ button 20 290 4020 4022 1 0 1 }`);  // leave guild
  const texts = [
    guild.name ?? 'Guild',
    `[${guild.abbreviation ?? '???'}]`,
    `Members: ${members.length}`,
    ...members.slice(0, 10).map((m) => m.name ?? '?'),
  ];
  gumps.send(state, { definitionId: 'server:gumps-server-gumps:open-guild-gump-1', layout: layout.join(' '), texts }, (resp) => {
    if (resp.buttonId === 1) {
      // leave guild
      state.sendSystemMessage?.('You have left your guild.');
      if (guild.removeMember) guild.removeMember(state.mobile?.serial);
    } else if (resp.buttonId >= 100 && resp.buttonId < 200) {
      const m = members[resp.buttonId - 100];
      if (m && guild.promote) guild.promote(state.mobile?.serial, m.serial);
    } else if (resp.buttonId >= 200 && resp.buttonId < 300) {
      const m = members[resp.buttonId - 200];
      if (m && guild.removeMember) guild.removeMember(m.serial);
    }
  });
}

// ---- RaceChangeGump ------------------------------------------------------

export function openRaceChangeGump(gumps, state, applyRaceChange, definitions) {
  const fallback = { layout: [
    panel(280, 200),
    `{ text 20 14 1153 0 }`,             // "Change Race"
    `{ button 30 50 9720 9721 1 0 1 }`,  // Human
    `{ text 60 52 1149 1 }`,
    `{ button 30 80 9720 9721 1 0 2 }`,  // Elf
    `{ text 60 82 1149 2 }`,
    `{ button 30 110 9720 9721 1 0 3 }`, // Gargoyle
    `{ text 60 112 1149 3 }`,
    `{ button 30 170 4017 4018 1 0 0 }`, // Cancel
  ].join(' '), texts: ['Change Race', 'Human', 'Elf', 'Gargoyle'] };
  const gump = configuredGump(definitions, 'race-change', {}, fallback);
  gumps.send(state, gump, (resp) => {
    const race = ({ 1: 'human', 2: 'elf', 3: 'gargoyle' })[resp.buttonId];
    if (race && applyRaceChange) applyRaceChange(state.mobile, race);
  });
}

// ---- BulkOrderGump -------------------------------------------------------

export function openBulkOrderGump(gumps, state, bod, definitions) {
  if (!bod) return;
  const layout = [
    panel(400, 280),
    `{ text 20 14 1153 0 }`,                      // BOD: <kind>
    `{ text 20 40 1149 1 }`,                      // amount required
    `{ text 20 62 1149 2 }`,                      // progress
    `{ text 20 84 1149 3 }`,                      // resource
    `{ text 20 106 1149 4 }`,                     // quality
    `{ button 20 240 4023 4024 1 0 1 }`,          // hand in
    `{ button 100 240 4011 4012 1 0 2 }`,         // combine
    `{ button 320 240 4017 4018 1 0 0 }`,         // close
  ].join(' ');
  const texts = [
    `BOD: ${bod.itemKind ?? bod.kind ?? '?'}`,
    `Amount: ${bod.amount ?? 0}`,
    `Progress: ${bod.collected ?? 0}/${bod.amount ?? 0}`,
    `Material: ${bod.material ?? 'iron'}`,
    bod.exceptional ? 'Exceptional' : 'Normal',
  ];
  const configured = configuredGump(definitions, 'bulk-order', {
    kind: bod.itemKind ?? bod.kind ?? '?', amount: bod.amount ?? 0,
    collected: bod.collected ?? 0, material: bod.material ?? 'iron',
    quality: bod.exceptional ? 'Exceptional' : 'Normal',
  }, { layout, texts });
  gumps.send(state, configured, (resp) => {
    if (resp.buttonId === 1 && bod.handIn) bod.handIn(state.mobile);
    if (resp.buttonId === 2 && bod.combine) bod.combine(state.mobile);
  });
}

// ---- HouseSecureInfoGump -------------------------------------------------

export function openHouseSecureInfoGump(gumps, state, house, definitions) {
  if (!house) return;
  const layout = [
    panel(320, 200),
    `{ text 20 14 1153 0 }`,                  // House Info
    `{ text 20 40 1149 1 }`,                  // owner
    `{ text 20 62 1149 2 }`,                  // lockdowns
    `{ text 20 84 1149 3 }`,                  // secures
    `{ text 20 106 1149 4 }`,                 // co-owners
    `{ button 30 170 4017 4018 1 0 0 }`,
  ].join(' ');
  const texts = [
    'House Info',
    `Owner: ${house.ownerName ?? '?'}`,
    `Lockdowns: ${house.lockdownCount ?? 0}/${house.lockdownMax ?? 0}`,
    `Secures: ${house.secureCount ?? 0}/${house.secureMax ?? 0}`,
    `Co-owners: ${(house.coOwners?.length ?? 0)}`,
  ];
  gumps.send(state, configuredGump(definitions, 'house-secure-info', {
    ownerName: house.ownerName ?? '?', lockdownCount: house.lockdownCount ?? 0,
    lockdownMax: house.lockdownMax ?? 0, secureCount: house.secureCount ?? 0,
    secureMax: house.secureMax ?? 0, coOwnerCount: house.coOwners?.length ?? 0,
  }, { layout, texts }));
}

// ---- HelpCategoriesGump --------------------------------------------------
//
// Server-rendered category picker. Shows 9 categories with radio buttons.
// Callback receives the chosen category id (0..8) or -1 on cancel.

const HELP_CATEGORIES = [
  'I am stuck',
  'There is a bug in the game',
  'My account is in trouble',
  'Other',
  'I have a vendor / shop problem',
  'I want to report a bug',
  'I am being harassed',
  'I have a suggestion',
  'Other request',
];

export function openHelpCategoriesGump(gumps, state, callback, definitions) {
  const layout = [
    panel(380, 360),
    `{ text 20 14 1153 0 }`,                  // "Help"
  ];
  let y = 50;
  for (let i = 0; i < HELP_CATEGORIES.length; i++) {
    layout.push(`{ radio 25 ${y} 9720 9721 ${i === 0 ? 1 : 0} ${100 + i} }`);
    layout.push(`{ text 55 ${y + 2} 1149 ${1 + i} }`);
    y += 28;
  }
  layout.push(`{ button 30 320 4023 4024 1 0 1 }`);   // Submit
  layout.push(`{ button 230 320 4017 4018 1 0 0 }`);  // Cancel
  const texts = ['Page a GM — pick category:', ...HELP_CATEGORIES];
  const configured = configuredGump(definitions, 'help-categories', {}, { layout: layout.join(' '), texts });
  gumps.send(state, configured, (resp) => {
    if (resp.buttonId !== 1) { callback?.(-1); return; }
    const chosen = resp.switches.find((s) => s >= 100 && s < 200);
    callback?.(chosen != null ? chosen - 100 : 0);
  });
}

// ---- RaffleGump ----------------------------------------------------------

export function openRaffleGump(gumps, state, raffle, enterFn, definitions) {
  const layout = [
    panel(340, 260),
    `{ text 20 14 1153 0 }`,
    `{ text 20 40 1149 1 }`,                  // grand prize
    `{ text 20 62 1149 2 }`,                  // ends in
    `{ text 20 84 1149 3 }`,                  // entry cost
    `{ button 30 200 4023 4024 1 0 1 }`,      // enter
    `{ text 70 202 1149 4 }`,
    `{ button 240 200 4017 4018 1 0 0 }`,     // close
  ].join(' ');
  const remainingMs = Math.max(0, (raffle?.endsAt ?? 0) - Date.now());
  const texts = [
    'Raffle',
    `Prize: ${raffle?.prize ?? 'a custom house'}`,
    `Ends in: ${Math.ceil(remainingMs / 3600_000)}h`,
    `Cost: ${raffle?.entryCost ?? 25000}gp`,
    'Enter',
  ];
  const configured = configuredGump(definitions, 'raffle', {
    prize: raffle?.prize ?? 'a custom house', remainingHours: Math.ceil(remainingMs / 3600_000),
    entryCost: raffle?.entryCost ?? 25000,
  }, { layout, texts });
  gumps.send(state, configured, (resp) => {
    if (resp.buttonId === 1 && enterFn) enterFn(state.mobile);
  });
}

// Generic bridge for layouts authored in Content Studio. Gameplay scripts can
// open a newly-created definition immediately without adding another bespoke
// layout builder here. The generated packet is still the standard UO gump
// layout/text-table pair; `values` only resolves {{runtime.placeholders}}.
export function openConfiguredGump(gumps, state, definitions, definitionId, values = {}, callback) {
  const definition = definitions?.get?.(definitionId)
    ?? (Array.isArray(definitions)
      ? definitions.find((entry) => (entry?.definitionId ?? entry?.id) === definitionId)
      : null);
  if (!definition) return false;
  gumps.send(state, configuredGump(definitions, definitionId, values), callback);
  return true;
}

// --- script entry point ---------------------------------------------
//
// Registers all gump openers under `api.systems.serverGumps` so other
// scripts (commands, help dispatcher, etc.) can call them. The server
// engine consumes from `state.ctx.systems.serverGumps` — the script API
// stores under that same key by setting it explicitly on registration.

export default function register(api) {
  // Install the openers on the shared systems map. The handler
  // (server/src/net/handlers.js handleHelpRequest) reads
  // `state.ctx.systems.serverGumps.openHelpCategoriesGump`.
  if (api.systems) {
    api.systems.serverGumps = api.systems.serverGumps ?? {};
    api.systems.serverGumps.openGuildGump = openGuildGump;
    const definitions = () => api.systems?.gumpDefinitions;
    api.systems.serverGumps.openRaceChangeGump = (gumps, state, apply) => openRaceChangeGump(gumps, state, apply, definitions());
    api.systems.serverGumps.openBulkOrderGump = (gumps, state, bod) => openBulkOrderGump(gumps, state, bod, definitions());
    api.systems.serverGumps.openHouseSecureInfoGump = (gumps, state, house) => openHouseSecureInfoGump(gumps, state, house, definitions());
    api.systems.serverGumps.openRaffleGump = (gumps, state, raffle, enter) => openRaffleGump(gumps, state, raffle, enter, definitions());
    api.systems.serverGumps.openHelpCategoriesGump = (gumps, state, callback) => openHelpCategoriesGump(gumps, state, callback, definitions());
    api.systems.serverGumps.openConfiguredGump = (gumps, state, definitionId, values, callback) => openConfiguredGump(gumps, state, definitions(), definitionId, values, callback);
  }
  api.log?.('gumps/server-gumps: 7 openers installed');
  return () => {
    if (api.systems?.serverGumps) {
      delete api.systems.serverGumps.openGuildGump;
      delete api.systems.serverGumps.openRaceChangeGump;
      delete api.systems.serverGumps.openBulkOrderGump;
      delete api.systems.serverGumps.openHouseSecureInfoGump;
      delete api.systems.serverGumps.openRaffleGump;
      delete api.systems.serverGumps.openHelpCategoriesGump;
      delete api.systems.serverGumps.openConfiguredGump;
    }
  };
}
