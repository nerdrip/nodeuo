// Public moongate behaviour — onUse opens a city-picker gump; walked-onto
// nudges the player to use it. Mirrors ServUO `Server.Gumps.MoongateGump`.
//
// The destination list is stored on `item.gateNetwork` (set at spawn by
// `apps/scripts/src/spawns/moongates.js`). Each entry is
// `{ name, x, y, z }`. `item.gateFacet` (or item.map) selects which
// facet the destinations resolve onto.

import { teleportToRune } from '../../../spells/rune-helpers.js';
import { MOONGATE_LOCATIONS } from '../../../spawns/moongates.js';
import { itemBySerial } from '../../../_entities.js';

/** Self-heal hook: ensure `item.gateNetwork` + `item.gateFacet` are populated.
 *  Persistence only round-trips ITEM_EXT_KEYS, and `gateNetwork` is a large
 *  array deliberately excluded from that whitelist. After a server restart
 *  every saved moongate has `script: 'public-moongate'` but a stripped
 *  `gateNetwork`, which made `openMoongateGump` bail with "no destinations"
 *  on every walk-on / double-click. We re-attach by matching the item's
 *  facet to the canonical table here. */
function ensureGateNetwork(item) {
  if (Array.isArray(item.gateNetwork) && item.gateNetwork.length > 0) return;
  const facet = item.gateFacet ?? item.map ?? 1;
  const network = MOONGATE_LOCATIONS.filter((g) => (g.map | 0) === (facet | 0))
    .map(({ name, x, y, z }) => ({ name, x, y, z }));
  if (network.length > 0) {
    item.gateNetwork = network;
    item.gateFacet = facet;
  }
}

/** ServUO `MoongateGump` layout — three columns of city buttons + a
 *  centred "Cancel" at the bottom. We render via the standard gump
 *  protocol so it shows up in the UO gump host on the client. */
function openMoongateGump(api, item, user) {
  ensureGateNetwork(item);
  const list = item.gateNetwork ?? [];
  const facet = item.gateFacet ?? item.map ?? 1;
  if (!list.length) {
    user.client?.sendSystemMessage?.('This moongate has no destinations.');
    return;
  }
  if (!api.gumps?.send) {
    // Gump host not ready — fall back to text picker so the player
    // isn't completely stuck.
    user.client?.sendSystemMessage?.('Where would you like to travel?');
    for (let i = 0; i < list.length; i++) {
      user.client?.sendSystemMessage?.(`  ${i + 1}. ${list[i].name ?? '?'}`);
    }
    user.client?.sendSystemMessage?.('Type [moongate <number> to travel.');
    user._pendingMoongate = item.serial;
    return;
  }
  const ROWS_PER_COL = 6;
  const COLS = Math.max(1, Math.ceil(list.length / ROWS_PER_COL));
  const W = 60 + COLS * 170;
  const H = 80 + Math.min(ROWS_PER_COL, list.length) * 28;
  /** @type {string[]} */
  const layout = [];
  /** @type {string[]} */
  const texts = [];
  // 5054 = ServUO's standard parchment background. Same gump used by
  // [edititem / [go pickers so the visual stays consistent.
  layout.push(`{ resizepic 0 0 5054 ${W} ${H} }`);
  texts.push('Choose a destination');
  layout.push(`{ text 24 14 1153 ${texts.length - 1} }`);
  list.forEach((dest, i) => {
    const col = Math.floor(i / ROWS_PER_COL);
    const row = i % ROWS_PER_COL;
    const x = 24 + col * 170;
    const y = 44 + row * 28;
    // Button: 4005 normal, 4007 pressed (CUO `RadioButtonGumps` blue
    // arrow set). buttonId 100+i so we can distinguish from cancel (0).
    layout.push(`{ button ${x} ${y} 4005 4007 1 0 ${100 + i} }`);
    texts.push(dest.name ?? `Destination ${i + 1}`);
    layout.push(`{ text ${x + 32} ${y + 2} 1153 ${texts.length - 1} }`);
    texts.push(`(${dest.x},${dest.y})`);
    layout.push(`{ text ${x + 32} ${y + 14} 32 ${texts.length - 1} }`);
  });
  // Cancel button at bottom-centre.
  texts.push('Cancel');
  const cancelX = Math.floor(W / 2) - 32;
  layout.push(`{ button ${cancelX} ${H - 32} 4020 4022 1 0 0 }`);
  layout.push(`{ text ${cancelX + 32} ${H - 30} 1153 ${texts.length - 1} }`);

  api.gumps.send(user.client, {
    gumpId: 0xF00FA7E0, x: 100, y: 80,
    layout: layout.join(''), texts,
  }, (resp) => {
    const b = resp?.buttonId | 0;
    if (b === 0) return;                         // Cancel
    const idx = b - 100;
    if (idx < 0 || idx >= list.length) return;
    const dest = list[idx];
    const ok = teleportToRune(api, user, { ...dest, map: facet });
    if (!ok) user.client?.sendSystemMessage?.('You cannot travel there.');
    else    user.client?.sendSystemMessage?.(`The world swirls around you... ${dest.name}.`);
  });
}

export default function buildPublicMoongateScript(api) {
  return {
    name: 'public-moongate',
    onUse(world, item, user) {
      if (!user?.client) return true;
      openMoongateGump(api, item, user);
      // Stash for the legacy text fallback (`[moongate N`) — harmless
      // when the gump path is in use.
      user._pendingMoongate = item.serial;
      return true;
    },
    onWalkOn(world, item, mob) {
      if (!mob?.client) return;
      // ServUO behaviour cycles by moon phase (Felucca↔Trammel etc.).
      // Without the lunar table we just open the picker so walking ON
      // the gate isn't a dead-end. Most players use the gate by walking
      // into it, not double-clicking.
      openMoongateGump(api, item, mob);
      mob._pendingMoongate = item.serial;
    },
  };
}

/** `[moongate <n>` — text fallback for when the gump host isn't up. */
export function registerMoongateCommand(api) {
  if (!api.commands) return () => {};
  api.commands.register({
    name: 'moongate',
    help: '[moongate <number> — travel through the last-opened public moongate.',
    access: 'Player',
    run(ctx) {
      const sender = ctx.sender;
      const idx = (ctx.args?.[0] | 0) - 1;
      const gateSerial = sender._pendingMoongate | 0;
      if (!gateSerial) {
        ctx.state.sendSystemMessage('Stand on a public moongate first.');
        return;
      }
      const gate = itemBySerial(api, gateSerial);
      if (!gate) {
        ctx.state.sendSystemMessage('That moongate is no longer here.');
        return;
      }
      const dest = gate.gateNetwork?.[idx];
      if (!dest) {
        ctx.state.sendSystemMessage('Invalid destination.');
        return;
      }
      const ok = teleportToRune(api, sender, { ...dest, map: gate.gateFacet ?? gate.map ?? 1 });
      if (!ok) ctx.state.sendSystemMessage('You cannot travel there.');
      else ctx.state.sendSystemMessage(`The world swirls around you... ${dest.name}.`);
    },
  });
  return () => api.commands.unregister('moongate');
}
