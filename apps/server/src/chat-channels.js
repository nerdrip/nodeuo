// Chat channels — port of ServUO `Scripts/Services/Chat/Channel.cs` and
// `ChatActionHandlers.cs`, simplified.
//
// Channels are independent of party / guild / overhead. A player joins a
// channel, then text typed with the chat prefix gets fanned out to every
// other subscribed mob's client. Default channels are pre-registered:
//   General   public
//   Trade     buy/sell ads
//   Help      novice support (mirror of help-queue but realtime)
//   Roleplay  IC chat
//   Off-topic out-of-character banter
//
// We don't reproduce the full 0xB3 ChatMessage opcode — most modern UO
// clients send chat as 0xAD UnicodeSpeech with the channel name as a
// command prefix (`/general hello`). The dispatcher in handlers.js
// detects this prefix and forwards through `chat-channels.send()`.

const _channels = new Map();
const _bans = new Map();            // chName -> Set<accountId>
const _mutes = new Map();           // chName -> Map<accountId, untilMs>
const _ownerships = new Map();      // chName -> ownerSerial
const _password = new Map();        // chName -> password

/** Bootstrap the canonical set. */
export function ensureDefaults() {
  for (const name of ['General', 'Trade', 'Help', 'Roleplay', 'Off-topic']) {
    if (!_channels.has(name.toLowerCase())) {
      _channels.set(name.toLowerCase(), {
        name,
        members: new Map(), // serial -> { send: fn, name, accountId }
        moderators: new Set(),
        custom: false,
      });
    }
  }
}
ensureDefaults();

/** List visible channels (name only). */
export function list() {
  return [..._channels.values()].map((c) => ({
    name: c.name, members: c.members.size,
  }));
}

/** Join `mob` to `name`. Returns true if newly joined.
 *  Optional `password` required for protected channels. */
export function join(name, mob, password = null) {
  if (!mob?.client) return false;
  const ch = _channels.get(name.toLowerCase());
  if (!ch) return false;
  if (ch.members.has(mob.serial)) return false;
  const acctId = mob.client?.account?.id ?? mob.account?.id ?? null;
  // Ban gate.
  const bans = _bans.get(name.toLowerCase());
  if (bans && acctId && bans.has(acctId)) return false;
  // Password gate.
  const pw = _password.get(name.toLowerCase());
  if (pw && pw !== password) return false;
  ch.members.set(mob.serial, {
    send: mob.client.send.bind(mob.client),
    name: mob.name ?? '?',
    accountId: acctId,
  });
  return true;
}

/** Create a custom channel owned by `mob`. Returns the channel or null
 *  if name is taken. Owner gets auto-moderator status. */
export function createChannel(name, mob, opts = {}) {
  if (!name || !mob) return null;
  const key = name.toLowerCase();
  if (_channels.has(key)) return null;
  const ch = {
    name,
    members: new Map(),
    moderators: new Set([mob.serial]),
    custom: true,
  };
  _channels.set(key, ch);
  _ownerships.set(key, mob.serial);
  if (opts.password) _password.set(key, opts.password);
  join(name, mob, opts.password);
  return ch;
}

/** Remove a channel. Only owner or shard staff may invoke. Returns true
 *  on success. */
export function deleteChannel(name, requester) {
  const key = name.toLowerCase();
  const ch = _channels.get(key);
  if (!ch || !ch.custom) return false;
  const owner = _ownerships.get(key);
  const isStaff = (requester?.accessLevel | 0) >= 2;
  if (!isStaff && owner !== requester?.serial) return false;
  _channels.delete(key);
  _bans.delete(key);
  _mutes.delete(key);
  _ownerships.delete(key);
  _password.delete(key);
  return true;
}

/** Promote `target` to moderator. Owner/staff only. */
export function promote(name, requester, target) {
  const key = name.toLowerCase();
  const ch = _channels.get(key);
  if (!ch || !target) return false;
  const owner = _ownerships.get(key);
  const isStaff = (requester?.accessLevel | 0) >= 2;
  if (!isStaff && owner !== requester?.serial) return false;
  ch.moderators.add(target.serial);
  return true;
}

/** Kick `target` from a channel. Mods only. */
export function kick(name, requester, target) {
  const key = name.toLowerCase();
  const ch = _channels.get(key);
  if (!ch || !target) return false;
  if (!ch.moderators.has(requester?.serial) && (requester?.accessLevel | 0) < 2) return false;
  return ch.members.delete(target.serial);
}

/** Ban an account from rejoining. Mods only. */
export function ban(name, requester, target) {
  const key = name.toLowerCase();
  const ch = _channels.get(key);
  if (!ch || !target) return false;
  if (!ch.moderators.has(requester?.serial) && (requester?.accessLevel | 0) < 2) return false;
  const acctId = target.client?.account?.id ?? target.account?.id;
  if (!acctId) return false;
  if (!_bans.has(key)) _bans.set(key, new Set());
  _bans.get(key).add(acctId);
  ch.members.delete(target.serial);
  return true;
}

/** Mute a member for `durationMs`. */
export function mute(name, requester, target, durationMs = 5 * 60 * 1000) {
  const key = name.toLowerCase();
  const ch = _channels.get(key);
  if (!ch || !target) return false;
  if (!ch.moderators.has(requester?.serial) && (requester?.accessLevel | 0) < 2) return false;
  const acctId = target.client?.account?.id ?? target.account?.id;
  if (!acctId) return false;
  if (!_mutes.has(key)) _mutes.set(key, new Map());
  _mutes.get(key).set(acctId, Date.now() + durationMs);
  return true;
}

/** Is `mob` currently muted in `name`? */
export function isMuted(name, mob) {
  const key = name.toLowerCase();
  const m = _mutes.get(key);
  if (!m) return false;
  const acctId = mob?.client?.account?.id ?? mob?.account?.id;
  if (!acctId) return false;
  const until = m.get(acctId);
  if (!until) return false;
  if (Date.now() > until) { m.delete(acctId); return false; }
  return true;
}

/** Drop `mob` from `name`. Returns true if removed. */
export function leave(name, mob) {
  const ch = _channels.get(name.toLowerCase());
  if (!ch || !mob) return false;
  return ch.members.delete(mob.serial);
}

/** Drop `mob` from every channel — used at logout. */
export function leaveAll(mob) {
  if (!mob) return;
  for (const ch of _channels.values()) ch.members.delete(mob.serial);
}

/**
 * Broadcast `text` from `sender` on `name`. Caller is responsible for
 * building the network packet (so we can swap between unicodeMessage and
 * a future native 0xB3 emitter without touching this module). Returns
 * the recipient count.
 *
 * @param {string} name
 * @param {*} sender
 * @param {(recipient:any) => Uint8Array} packetFor
 */
export function broadcast(name, sender, packetFor) {
  const ch = _channels.get(name.toLowerCase());
  if (!ch || !sender) return 0;
  if (!ch.members.has(sender.serial)) return 0;     // must be subscribed
  if (isMuted(name, sender)) return 0;
  let count = 0;
  for (const [serial, member] of ch.members) {
    if (serial === sender.serial) continue;
    try {
      const pkt = packetFor(member);
      if (pkt) { member.send(pkt); count++; }
    } catch { /* dead client — skip */ }
  }
  return count;
}

/** True if `mob` is in `name`. */
export function isMember(name, mob) {
  const ch = _channels.get(name.toLowerCase());
  if (!ch || !mob) return false;
  return ch.members.has(mob.serial);
}

/** Members visible to `mob` for /who-style listing. */
export function members(name) {
  const ch = _channels.get(name.toLowerCase());
  if (!ch) return [];
  return [...ch.members.values()].map((m) => m.name);
}

/** Reset (tests). */
export function clearAll() {
  _channels.clear();
  _bans.clear();
  _mutes.clear();
  _ownerships.clear();
  _password.clear();
  ensureDefaults();
}
