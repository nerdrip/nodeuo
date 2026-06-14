// Reports — port of ServUO `Scripts/Services/Reports/`. Periodic
// aggregate statistics for ops (online players, items in world, NPC
// counts, mobiles per facet). ServUO writes XML; we keep the same
// structure as a JSON object so a follow-up REST endpoint can serve it.

export function gatherSnapshot(world, ctx = {}) {
  if (!world) return null;
  const playerOnline = ctx.netStates
    ? Array.from(ctx.netStates.values()).filter((s) => s.stage === 'in-world').length
    : 0;
  const mobs = world.mobiles?.values?.() ?? [];
  const items = world.items?.values?.() ?? [];

  let players = 0, npcs = 0;
  const byFacet = {};
  for (const m of mobs) {
    if (m.client) players++;
    else npcs++;
    byFacet[m.map | 0] = (byFacet[m.map | 0] | 0) + 1;
  }
  let itemCount = 0, parentless = 0;
  for (const it of items) {
    itemCount++;
    if (it.parent == null) parentless++;
  }

  return {
    ts: Date.now(),
    playerOnline,
    playersInWorld: players,
    npcs,
    mobsByFacet: byFacet,
    itemCount,
    itemsOnGround: parentless,
    uptimeMs: ctx.startedAt ? Date.now() - ctx.startedAt : 0,
  };
}

export function formatSnapshot(snap) {
  if (!snap) return 'No snapshot.';
  const facets = Object.entries(snap.mobsByFacet)
    .map(([k, v]) => `f${k}=${v}`).join(' ');
  return [
    `Online: ${snap.playerOnline}  In-world: ${snap.playersInWorld}  NPCs: ${snap.npcs}`,
    `Items: ${snap.itemCount}  On-ground: ${snap.itemsOnGround}`,
    `Mobs/facet: ${facets}`,
    `Uptime: ${(snap.uptimeMs / 1000 / 60 / 60).toFixed(2)}h`,
  ].join('\n');
}
