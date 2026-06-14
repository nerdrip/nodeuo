// PartyManager — client-side mirror of the party system. The server
// authority is `apps/server/src/party.js` + the `partyRegistry` reachable
// via `0xBF subop 0x06`. We listen to incoming `party:command` events
// (surfaced from net/handlers.js) and maintain the local roster + leader
// state so the UI (chat tag colours, party manifest gump, healthbars)
// can read who's in our party.
//
// Outbound 0xBF 0x06 sub-subop layout (matches ServUO `PartyMessage`):
//   0x01 add member        — payload: u32 serial
//   0x02 remove member     — payload: u32 serial
//   0x03 send private msg   — payload: u32 to + utf-16 text
//   0x04 send party message — payload: utf-16 text
//   0x06 canLoot            — payload: bool, "party can loot my corpse"
//   0x07 invite             — payload: u32 inviter (server-driven)
//   0x08 accept invite      — payload: u32 leader
//   0x09 decline invite     — payload: u32 leader
//
import { bus } from '../core/event-bus.js';
import { net } from '../net/net-client.js';
import { world } from '../world/world.js';
import {
  buildPartyAccept,
  buildPartyAdd,
  buildPartyCanLoot,
  buildPartyDecline,
  buildPartyMessage,
  buildPartyMessageTo,
  buildPartyRemove,
} from '../net/outgoing.js';

function readU32BE(bytes, off) {
  return ((bytes[off] << 24) | (bytes[off + 1] << 16)
       | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
}

class PartyManager {
  constructor() {
    /** Members keyed by serial. The leader is the first entry the
     *  server-side roster advertises (0x06 0x01 with us in the list). */
    this.members = new Map();
    this.leaderSerial = 0;
    this.pendingInviter = 0;
    bus.on('party:command', (info) => this._onCommand(info?.payload));
  }

  isMember(serial) { return this.members.has(serial >>> 0); }
  isLeader(serial) { return (serial >>> 0) === this.leaderSerial; }
  size() { return this.members.size; }
  amILeader() { return !!world.player && this.leaderSerial === (world.player.serial >>> 0); }
  canLoot(serial) { return this.members.get(serial >>> 0)?.canLoot === true; }
  myCanLoot() {
    const self = world.player?.serial;
    return self ? this.canLoot(self) : false;
  }

  // ---- Outbound -----------------------------------------------------------

  /** Send a party-wide chat message. */
  sayParty(text) {
    net.send(buildPartyMessage(text));
  }

  /** Whisper to one party member. */
  sayPrivate(serial, text) {
    net.send(buildPartyMessageTo(serial, text));
  }

  /** Add a member (leader gesture). serial = invitee.
   *  Returns false (without sending) if we're in a party and not the
   *  leader — CUO gates the invite gump on PartyManager.IsPartyLeader. */
  invite(serial) {
    if (this.members.size > 0 && !this.amILeader()) {
      bus.emit('party:denied', { reason: 'not-leader', action: 'invite' });
      return false;
    }
    net.send(buildPartyAdd(serial));
    return true;
  }

  /** Remove a member. serial = victim. Leader-only unless removing self. */
  kick(serial) {
    const s = serial >>> 0;
    const isSelf = !!world.player && s === (world.player.serial >>> 0);
    if (!isSelf && this.members.size > 0 && !this.amILeader()) {
      bus.emit('party:denied', { reason: 'not-leader', action: 'kick' });
      return false;
    }
    net.send(buildPartyRemove(s));
    return true;
  }

  /** Toggle "party can loot my corpse" (0xBF/0x06/0x06). */
  setCanLoot(serialOrAllow, maybeAllow) {
    const self = world.player?.serial >>> 0;
    if (!self) return false;
    const hasSerial = maybeAllow !== undefined;
    const requestedSerial = hasSerial ? (serialOrAllow >>> 0) : self;
    const allow = !!(hasSerial ? maybeAllow : serialOrAllow);
    if (requestedSerial !== self) {
      bus.emit('party:denied', { reason: 'can-loot-self-only', action: 'canLoot' });
      return false;
    }
    const m = this.members.get(self);
    if (m) m.canLoot = allow;
    net.send(buildPartyCanLoot(allow));
    bus.emit('party:loot', { serial: self, canLoot: allow });
    bus.emit('party:roster', { members: [...this.members.values()], leaderSerial: this.leaderSerial });
    return true;
  }

  /** Reply to a pending invite from `leaderSerial`. */
  acceptInvite(leaderSerial) {
    net.send(buildPartyAccept(leaderSerial));
    this.pendingInviter = 0;
  }
  declineInvite(leaderSerial) {
    net.send(buildPartyDecline(leaderSerial));
    this.pendingInviter = 0;
  }
  /** Leave the current party (server treats us removing ourselves as a leave). */
  leave() {
    if (!world.player) return;
    this.kick(world.player.serial);
  }

  // ---- Inbound (called from 0xBF 0x06 subop) ------------------------------

  _onCommand(payload) {
    if (!payload || payload.length < 1) return;
    const sub = payload[0];
    switch (sub) {
      case 0x01: {
        // Member-list update. payload: u8 count + u32×count members.
        if (payload.length < 2) return;
        const count = payload[1];
        const previous = this.members;
        const members = new Map();
        let leader = 0;
        for (let i = 0; i < count; i++) {
          const off = 2 + i * 4;
          if (payload.length < off + 4) break;
          const s = readU32BE(payload, off);
          // First entry is the leader by ServUO convention.
          if (i === 0) leader = s;
          members.set(s, { serial: s, canLoot: previous.get(s)?.canLoot === true });
        }
        this.leaderSerial = leader;
        this.members = members;
        bus.emit('party:roster', { members: [...members.values()], leaderSerial: this.leaderSerial });
        break;
      }
      case 0x02: {
        // Member removed. payload: u8 remainingCount + u32 removed + u32*remaining.
        if (payload.length < 6) return;
        const count = payload[1];
        const removed = readU32BE(payload, 2);
        const previous = this.members;
        const members = new Map();
        let leader = 0;
        for (let i = 0; i < count; i++) {
          const off = 6 + i * 4;
          if (payload.length < off + 4) break;
          const s = readU32BE(payload, off);
          if (i === 0) leader = s;
          members.set(s, { serial: s, canLoot: previous.get(s)?.canLoot === true });
        }
        this.members = members;
        this.leaderSerial = leader;
        if (removed === world.player?.serial) this.pendingInviter = 0;
        bus.emit('party:roster', { members: [...this.members.values()], leaderSerial: this.leaderSerial });
        break;
      }
      case 0x03:
      case 0x04: {
        // Inbound chat from a party member.
        if (payload.length < 5) return;
        const off = 5;
        const fromSerial = readU32BE(payload, 1);
        let text = '';
        for (let i = off; i + 1 < payload.length; i += 2) {
          const c = (payload[i] << 8) | payload[i + 1];
          if (c === 0) break;
          text += String.fromCharCode(c);
        }
        bus.emit('party:chat', { from: fromSerial, text, private: sub === 0x03 });
        break;
      }
      case 0x07: {
        // Server invites us — leader serial follows.
        if (payload.length < 5) return;
        const leader = readU32BE(payload, 1);
        this.pendingInviter = leader;
        bus.emit('party:invite', { leader });
        break;
      }
      default: /* unknown sub — ignored */ break;
    }
  }
}

export const party = new PartyManager();
