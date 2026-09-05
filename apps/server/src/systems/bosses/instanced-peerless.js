// Instanced Peerless — port of ServUO `Scripts/Services/InstancedPeerless/`.
// Each peerless lair is an instance: a party that summons the boss has
// the room to itself for the duration. Mirrors ServUO `PeerlessAltar`
// logic collapsed to a registry.

const INSTANCE_TIMEOUT_MS = 30 * 60 * 1000;   // 30 minutes per attempt
const _instances = new Map();    // bossKind → { partyId, ownerSerial, expiresAt }

export function isOccupied(bossKind, now = Date.now()) {
  const inst = _instances.get(bossKind);
  if (!inst) return false;
  if (now >= inst.expiresAt) { _instances.delete(bossKind); return false; }
  return true;
}

export function claim(bossKind, party, leader, now = Date.now()) {
  if (isOccupied(bossKind, now)) return false;
  _instances.set(bossKind, {
    partyId: party?.id ?? null,
    ownerSerial: leader?.serial ?? null,
    expiresAt: now + INSTANCE_TIMEOUT_MS,
  });
  return true;
}

export function release(bossKind) {
  return _instances.delete(bossKind);
}

export function instanceFor(bossKind) {
  return _instances.get(bossKind) ?? null;
}

export function isMember(bossKind, mob, party) {
  const inst = _instances.get(bossKind);
  if (!inst) return true;   // no instance = open
  if (inst.ownerSerial === mob?.serial) return true;
  if (party?.id && inst.partyId === party.id) return true;
  return false;
}

export function listActive() {
  return Array.from(_instances.entries())
    .map(([k, v]) => ({ bossKind: k, ...v }));
}

/** Test and clean-shutdown helper. */
export function reset() {
  _instances.clear();
}
