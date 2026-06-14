// Shadowguard — port of ServUO `Scripts/Services/Shadowguard/`. Tower
// dungeon with five themed rooms. Each room is a self-contained encounter
// with a unique mechanic; clearing all five spawns the Roof boss.
//
// Rooms (ServUO names → our handler):
//   Bar      — kill drunken pirates, find the captain, drink the keg
//   Orchard  — pick fruit + dodge bursts of pollen, avoid the Wisp lord
//   Belfry   — escort a captive without taking damage, ring the bell
//   Armory   — reforge a broken sword from pieces inside chests
//   Fountain — extinguish elemental imps blessing the spring
//
// Each room is self-instanced per party. We track the room state on the
// party object via `party._shadowguard`. Spawn-points + boss handlers are
// hooked into the spawner via a region tag `shadowguard:{room}`.

const ROOM_NAMES = ['bar', 'orchard', 'belfry', 'armory', 'fountain'];

export const SHADOWGUARD_BOSSES = {
  bar:      { kind: 'pirate-captain',  hp: 30000, fame: 22500 },
  orchard:  { kind: 'wisp-lord',       hp: 25000, fame: 19000 },
  belfry:   { kind: 'lady-mhirana',    hp: 28000, fame: 21000 },
  armory:   { kind: 'forge-tyrant',    hp: 32000, fame: 24000 },
  fountain: { kind: 'fountain-mother', hp: 26000, fame: 20000 },
  roof:     { kind: 'minax',           hp: 75000, fame: 90000 },
};

export function freshState() {
  return {
    rooms: Object.fromEntries(ROOM_NAMES.map((r) => [r, { cleared: false, startedAt: 0 }])),
    roofUnlocked: false,
    roofKilled: false,
  };
}

export function ensureState(party) {
  if (!party._shadowguard) party._shadowguard = freshState();
  return party._shadowguard;
}

export function startRoom(party, room) {
  const st = ensureState(party);
  if (!st.rooms[room]) return false;
  if (st.rooms[room].cleared) return false;
  st.rooms[room].startedAt = Date.now();
  return true;
}

export function clearRoom(party, room) {
  const st = ensureState(party);
  if (!st.rooms[room]) return false;
  st.rooms[room].cleared = true;
  st.roofUnlocked = ROOM_NAMES.every((r) => st.rooms[r].cleared);
  return st.roofUnlocked;
}

export function progress(party) {
  const st = ensureState(party);
  return {
    rooms: ROOM_NAMES.map((r) => ({ room: r, cleared: !!st.rooms[r].cleared })),
    roofUnlocked: st.roofUnlocked,
    roofKilled:   st.roofKilled,
  };
}

export function killRoof(party) {
  const st = ensureState(party);
  if (!st.roofUnlocked) return false;
  st.roofKilled = true;
  return true;
}
