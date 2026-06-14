// FAZA HB — `[go <location|x y [z]>` teleport with named presets.
//
// ServUO reference: Scripts/Commands/Go.cs — a multi-tab gump listing
// every canonical destination (towns, dungeons, shrines, moongates,
// landmarks). We expose the same library as a flat keyword table so
// players can type `[go britain` instead of memorising coordinates.
//
// Coordinates are world-classic Felucca/Trammel (map id 1) values.
// Each entry: name → { x, y, z, map, label }.

import { moveMobile } from '../_movement.js';
import { nearbyClients } from '../_spatial.js';
import { MOONGATE_LOCATIONS } from '../spawns/moongates.js';

function* clientsNear(api, center, range = 18, self = null) {
  if (api.query?.clientsNear) {
    yield* api.query.clientsNear(center, range, self);
    return;
  }
  yield* nearbyClients(api.world, center, self, range);
}

/** @typedef {{ x: number, y: number, z: number, map: number, label: string }} GoEntry */

/** @type {Record<string, GoEntry>} */
const LOCATIONS = {
  // ---- Towns (Felucca/Trammel — map 1) -----------------------------------
  britain:           { x: 1495, y: 1629, z: 10, map: 1, label: 'Britain (center)' },
  'britain-bank':    { x: 1434, y: 1699, z:  2, map: 1, label: 'Britain Bank' },
  'britain-inn':     { x: 1495, y: 1689, z:  0, map: 1, label: 'Britain Inn' },
  'britain-castle':  { x: 1323, y: 1624, z: 20, map: 1, label: "Lord British's Castle" },
  trinsic:           { x: 1846, y: 2745, z:  0, map: 1, label: 'Trinsic' },
  'trinsic-bank':    { x: 1827, y: 2742, z:  0, map: 1, label: 'Trinsic Bank' },
  vesper:            { x: 2895, y:  676, z:  0, map: 1, label: 'Vesper' },
  'vesper-bank':     { x: 2876, y:  657, z:  0, map: 1, label: 'Vesper Bank' },
  yew:               { x:  633, y:  858, z:  0, map: 1, label: 'Yew' },
  'yew-bank':        { x:  651, y:  857, z:  0, map: 1, label: 'Yew Bank' },
  'empath-abbey':    { x:  640, y:  817, z:  0, map: 1, label: 'Empath Abbey' },
  minoc:             { x: 2479, y:  439, z: 15, map: 1, label: 'Minoc' },
  'minoc-bank':      { x: 2509, y:  548, z:  0, map: 1, label: 'Minoc Bank' },
  magincia:          { x: 3713, y: 2113, z: 20, map: 1, label: 'Magincia' },
  'magincia-bank':   { x: 3725, y: 2128, z: 20, map: 1, label: 'Magincia Bank' },
  moonglow:          { x: 4406, y: 1045, z:  0, map: 1, label: 'Moonglow' },
  'moonglow-bank':   { x: 4471, y: 1170, z:  0, map: 1, label: 'Moonglow Bank' },
  nujelm:            { x: 3768, y: 1297, z:  0, map: 1, label: "Nu'Jelm" },
  occlo:             { x: 3650, y: 2658, z:  0, map: 1, label: 'Occlo' },
  papua:             { x: 5740, y: 3209, z:  0, map: 1, label: 'Papua' },
  'skara-brae':      { x:  599, y: 2148, z:  0, map: 1, label: 'Skara Brae' },
  'skara-brae-bank': { x:  583, y: 2154, z:  0, map: 1, label: 'Skara Brae Bank' },
  jhelom:            { x: 1417, y: 3821, z:  0, map: 1, label: 'Jhelom' },
  'jhelom-bank':     { x: 1417, y: 3826, z:  0, map: 1, label: 'Jhelom Bank' },
  delucia:           { x: 5276, y: 4017, z: 37, map: 1, label: 'Delucia' },
  cove:              { x: 2237, y: 1190, z:  0, map: 1, label: 'Cove' },
  'serpent-hold':    { x: 2901, y: 3473, z: 15, map: 1, label: "Serpent's Hold" },
  wind:              { x: 5272, y:   16, z:  0, map: 1, label: 'Wind' },
  'buccs-den':       { x: 2729, y: 2106, z:  0, map: 1, label: "Buccaneer's Den" },

  // ---- Dungeons --------------------------------------------------------
  covetous:          { x: 2496, y:  921, z:  0, map: 1, label: 'Covetous' },
  deceit:            { x: 4111, y:  430, z:  5, map: 1, label: 'Deceit' },
  despise:           { x: 1300, y: 1080, z:  0, map: 1, label: 'Despise' },
  destard:           { x: 1176, y: 2638, z:  0, map: 1, label: 'Destard' },
  hythloth:          { x: 4722, y: 3814, z:  0, map: 1, label: 'Hythloth' },
  ice:               { x: 1996, y:   81, z:  4, map: 1, label: 'Ice Dungeon' },
  shame:             { x:  513, y: 1561, z:  0, map: 1, label: 'Shame' },
  wrong:             { x: 2042, y:  236, z: 10, map: 1, label: 'Wrong' },
  fire:              { x: 2923, y: 3402, z: 15, map: 1, label: 'Fire Dungeon' },
  ankh:              { x:  574, y:  823, z:  0, map: 1, label: 'Ankh Dungeon' },
  'terathan-keep':   { x: 5544, y: 2906, z:  0, map: 1, label: 'Terathan Keep' },
  'cyclops':         { x: 5269, y: 3047, z:  0, map: 1, label: 'Cyclops Dungeon' },

  // ---- Shrines (Britannia 8 virtues) -----------------------------------
  'shrine-humility':     { x: 4274, y: 3697, z:  0, map: 1, label: 'Humility Shrine' },
  'shrine-sacrifice':    { x: 1858, y:  873, z:  0, map: 1, label: 'Sacrifice Shrine' },
  'shrine-compassion':   { x: 1858, y:  873, z:  0, map: 1, label: 'Compassion Shrine' },
  'shrine-spirituality': { x: 1280, y: 1450, z:  0, map: 1, label: 'Spirituality Shrine' },
  'shrine-valor':        { x: 2496, y: 3792, z: 15, map: 1, label: 'Valor Shrine' },
  'shrine-honor':        { x: 1721, y: 3526, z: 10, map: 1, label: 'Honor Shrine' },
  'shrine-justice':      { x: 1300, y:  642, z:  8, map: 1, label: 'Justice Shrine' },
  'shrine-honesty':      { x: 4218, y:  563, z: 36, map: 1, label: 'Honesty Shrine' },

  // ---- Landmarks --------------------------------------------------------
  haven:             { x: 3486, y: 2503, z: 14, map: 1, label: 'Haven (New Player Isle)' },
  britain2:          { x: 1495, y: 1689, z:  0, map: 1, label: 'Britain (West Gate)' },
  'lost-lands':      { x: 5276, y: 4017, z: 37, map: 1, label: 'Lost Lands (Delucia)' },
  'tomb-of-kings':   { x: 1923, y:  836, z:  0, map: 1, label: 'Tomb of Kings' },
  'sanctuary':       { x: 6995, y:  396, z:  6, map: 1, label: 'Sanctuary (ML)' },
  'twisted-weald':   { x: 6772, y:  511, z:  0, map: 1, label: 'Twisted Weald (ML)' },
  'citadel':         { x: 6444, y:  290, z:  0, map: 1, label: 'Citadel of Doom (ML)' },
  'champion-britain':{ x: 1170, y: 2231, z:  0, map: 1, label: 'Champion Spawn — Despise (Britain)' },
  'champion-destard':{ x: 1290, y: 2624, z:  0, map: 1, label: 'Champion Spawn — Destard' },
};

// ---- Public moongates -----------------------------------------------------
// Pulled from `spawns/moongates.js` so the [go picker stays in sync with
// the actual portals `[createworld` places. Keys are
// `moongate-<facet>-<city>` (e.g. `moongate-trammel-britain`,
// `moongate-felucca-britain`, `moongate-malas-luna`).
{
  const FACET_NAMES = { 0: 'felucca', 1: 'trammel', 3: 'malas', 4: 'tokuno' };
  const FACET_LABEL = { 0: 'Felucca', 1: 'Trammel', 3: 'Malas',  4: 'Tokuno' };
  for (const g of MOONGATE_LOCATIONS) {
    const facetKey = FACET_NAMES[g.map];
    if (!facetKey) continue;
    const cityKey = g.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const key = `moongate-${facetKey}-${cityKey}`;
    LOCATIONS[key] = {
      x: g.x, y: g.y, z: g.z, map: g.map,
      label: `Moongate — ${g.name} (${FACET_LABEL[g.map]})`,
    };
  }
}

export default function register(api) {
  if (!api.commands) return () => {};

  api.commands.register({
    name: 'go',
    help: '[go <name|list|x y [z]> — teleport to a named landmark or coordinates.',
    access: 'GM',
    run(ctx, args) {
      const sender = ctx.sender;
      // FAZA NE: bare `[go` opens the gump with the full destination
      // list. Previously it just printed "Usage: ..." which made the
      // travel UI feel hidden. Mirrors ServUO's `Help/GoGump.cs` —
      // bare command opens the picker.
      const noArgs = !args || args.length === 0;
      if (noArgs) {
        const allMatches = Object.entries(LOCATIONS);
        if (api.gumps?.send) {
          renderGoGump(api, ctx, allMatches);
          return;
        }
        ctx.state.sendSystemMessage('Usage: [go <name>|list|<x> <y> [z]');
        return;
      }
      // ---- list / find ---------------------------------------------------
      if (args[0] === 'list' || args[0] === 'find') {
        const filter = (args[1] ?? '').toLowerCase();
        const matches = Object.entries(LOCATIONS)
          .filter(([k, v]) => !filter || k.includes(filter) || v.label.toLowerCase().includes(filter));
        if (matches.length === 0) {
          ctx.state.sendSystemMessage('No matching destinations.');
          return;
        }
        // FAZA II: render via gump if available — players asked for the
        // CUO-style picker. ServUO `Help/GoGump.cs` is exactly this.
        if (api.gumps?.send) {
          renderGoGump(api, ctx, matches);
          return;
        }
        // Fallback: plain-text listing.
        ctx.state.sendSystemMessage(`Destinations (${Math.min(30, matches.length)} of ${Object.keys(LOCATIONS).length}):`);
        for (const [k, v] of matches.slice(0, 30)) {
          ctx.state.sendSystemMessage(`  ${k} — ${v.label}`);
        }
        return;
      }

      // ---- numeric (`go x y [z]`) ----------------------------------------
      const maybeX = parseInt(args[0], 10);
      const maybeY = parseInt(args[1] ?? '', 10);
      let dest;
      if (Number.isFinite(maybeX) && Number.isFinite(maybeY)) {
        const z = args[2] != null ? parseInt(args[2], 10) | 0 : sender.z;
        dest = { x: maybeX, y: maybeY, z, map: sender.map, label: 'manual coords' };
      } else {
        // ---- named lookup ------------------------------------------------
        const key = args.join('-').toLowerCase();
        dest = LOCATIONS[key] ?? LOCATIONS[args[0].toLowerCase()];
        if (!dest) {
          ctx.state.sendSystemMessage(
            `Unknown location: ${args.join(' ')}. Try [go list or [go find <keyword>.`,
          );
          return;
        }
      }

      const next = {
        x: dest.x & 0xffff,
        y: dest.y & 0xffff,
        z: (dest.z | 0) & 0xff,
        map: typeof dest.map === 'number' ? dest.map | 0 : sender.map,
      };
      if (!api.game?.mobile?.teleport?.(sender, next, { state: ctx.state, refresh: true })) {
        // BUGFIX #116 (FAZA HB): the original `[go` mutated coords but
        // never told observers the player vanished from the old spot,
        // so phantom mobiles lingered for nearby clients until their
        // own next frame. Recall (FAZA DU) had the same bug fixed — we
        // adopt the same removeEntity-to-pre-observers approach here.
        const preObservers = [...clientsNear(api, sender, 18, sender)];
        if (api.protocol?.removeEntity) {
          const rm = api.protocol.removeEntity(sender.serial);
          for (const m of preObservers) m.client.send(rm);
        }

        moveMobile(api, sender, next);

        if (sender.client && api.protocol?.mobileUpdate) {
          sender.client.send(api.protocol.mobileUpdate({
            serial: sender.serial, body: sender.body, hue: sender.hue ?? 0,
            flags: sender.flags ?? 0,
            x: sender.x, y: sender.y, z: sender.z, direction: sender.direction ?? 0,
          }));
        }
        // Tell post-arrival observers the player appeared.
        if (api.protocol?.mobileMoving) {
          const moving = api.protocol.mobileMoving({
            serial: sender.serial, body: sender.body,
            x: sender.x, y: sender.y, z: sender.z,
            direction: sender.direction ?? 0, hue: sender.hue ?? 0,
            flags: sender.flags ?? 0, notoriety: sender.notoriety ?? 1,
          });
          for (const m of clientsNear(api, sender, 18, sender)) m.client.send(moving);
        }
        // Push every now-in-range NPC/item back to the player. Without this
        // the dest is a clean viewport — the server already knew about
        // those spawns but never told the client. Mirrors the 0x22 resync
        // path so [go feels identical to a manual relog.
        try { ctx.state?.ctx?.handlers?.refreshSurroundings?.(ctx.state); }
        catch { /* helper missing in test setups */ }
      }
      ctx.state.sendSystemMessage(`Go: ${dest.label} (${dest.x}, ${dest.y}, ${dest.z}).`);
      api.log?.(`[go] ${sender.name} → ${dest.label}`);
    },
  });

  return () => api.commands.unregister('go');
}

export const _LOCATIONS_FOR_TEST = LOCATIONS;
// Public export — admin editor reads via /api/locations.
export const LOCATIONS_REGISTRY = LOCATIONS;

// FAZA II — `[go` picker gump. Two columns × N rows; each row is a
// button that re-dispatches `[go <key>` so the move + visibility
// fixes (#116) all run through the same path.
function renderGoGump(api, ctx, entries) {
  const PAGE_SIZE = 14;
  const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));

  function page(pageIdx) {
    const slice = entries.slice(pageIdx * PAGE_SIZE, (pageIdx + 1) * PAGE_SIZE);
    const W = 480, H = 60 + slice.length * 28 + 40;
    const parts = [];
    const texts = [];
    parts.push('{ page 0 }');
    parts.push(`{ resizepic 0 0 5054 ${W} ${H} }`);
    texts.push(`Travel destinations (page ${pageIdx + 1}/${totalPages})`);
    parts.push(`{ text 18 12 1153 ${texts.length - 1} }`);
    slice.forEach(([, def], i) => {
      const y = 40 + i * 28;
      // Use the small "go" radio-button gump (0x0FB7/0x0FB8 = ~24×24
      // checkbox-style button) and place it tight to the left edge.
      // 4005/4006 was a vertical-scroll arrow that rendered ~36 px
      // wide and offset visually right of its declared x=18 — gump
      // looked like the nav buttons were floating in the middle of
      // each row instead of acting as a clear "click here to go".
      parts.push(`{ button 8 ${y} 0x0FA5 0x0FA7 1 0 ${100 + i} }`);
      texts.push(def.label);
      parts.push(`{ text 36 ${y + 2} 1153 ${texts.length - 1} }`);
      texts.push(`(${def.x},${def.y},${def.z})`);
      parts.push(`{ text 280 ${y + 2} 32 ${texts.length - 1} }`);
    });
    if (pageIdx > 0) {
      parts.push(`{ button 18 ${H - 28} 4014 4015 1 0 2000 }`);
      texts.push('< Prev');
      parts.push(`{ text 46 ${H - 26} 1153 ${texts.length - 1} }`);
    }
    if (pageIdx < totalPages - 1) {
      parts.push(`{ button ${W - 80} ${H - 28} 4005 4006 1 0 2001 }`);
      texts.push('Next >');
      parts.push(`{ text ${W - 52} ${H - 26} 1153 ${texts.length - 1} }`);
    }
    parts.push(`{ button ${W - 30} 8 4017 4018 1 0 0 }`);

    api.gumps.send(ctx.state, {
      x: 100, y: 80,
      layout: parts.join(''),
      texts,
    }, (resp) => {
      const b = resp.buttonId;
      if (b === 0) return;
      if (b === 2000) { page(pageIdx - 1); return; }
      if (b === 2001) { page(pageIdx + 1); return; }
      if (b >= 100 && b < 100 + PAGE_SIZE) {
        const [key] = slice[b - 100] ?? [];
        if (!key) return;
        // Re-dispatch through `[go <key>` so the same move + observer
        // broadcast path runs.
        api.commands.dispatch(`go ${key}`, ctx);
      }
    });
  }
  page(0);
}
