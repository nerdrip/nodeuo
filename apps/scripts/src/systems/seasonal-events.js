// Seasonal events loader — reads scripts/data/world/seasonal-events.json and
// pushes the event list into the server engine via setEvents.
//
// This is the right place to also register per-event open/close hooks
// (e.g. spawning Krampus on krampus open, despawning on close). Add
// registerEventHooks calls here as needed.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DATA = path.resolve(HERE, '../data/world/seasonal-events.json');

export default function register(api) {
  const sys = api.systems?.seasonalEvents;
  if (!sys?.setEvents) {
    api.log?.('seasonal-events: engine API missing, skipping');
    return () => {};
  }
  let list = [];
  try { list = JSON.parse(fs.readFileSync(DATA, 'utf8')); }
  catch (e) { api.log?.(`seasonal-events: ${e.message}`); return () => {}; }
  sys.setEvents(list);
  api.log?.(`seasonal-events: loaded ${list.length} events`);
  // Per-event hook examples — add more here as systems integrate:
  // sys.registerEventHooks('krampus', { onOpen: (world) => krampusSystem.spawn(world) });
  return () => sys.setEvents([]);
}
