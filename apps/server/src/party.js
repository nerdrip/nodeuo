// Server-side party registry.
//
// A party is a tiny object:
//   {
//     leader:  number,
//     members: number[],        // includes the leader
//     pending: Map<number, number>,   // invited mobileSerial → inviter serial
//     canLoot: Map<number, boolean>,  // per-member loot permission
//   }
//
// Each mobile that is in a party has a back-pointer on `mob._party`.

/**
 * @typedef {Object} Party
 * @property {number} id
 * @property {number} leader
 * @property {number[]} members
 * @property {Map<number, number>} pending
 * @property {Map<number, boolean>} canLoot
 */

import { partyList, partyRemove, partyMessage, partyInvitation } from '@uo/protocol';
import { sendNodeUOPartySnapshot } from './net/handlers/nodeuo-modern.js';

export class PartyRegistry {
  /**
   * @param {import('../world/world.js').World} world
   */
  constructor(world) {
    this.world = world;
    /** @type {Set<Party>} */
    this.parties = new Set();
    /** Stable lookup used by queued group activities such as the PvP arena. */
    this.byId = new Map();
  }

  /** Return the party containing `mobileSerial`, or null. */
  partyOf(mobileSerial) {
    const serial = typeof mobileSerial === 'object' ? mobileSerial?.serial : mobileSerial;
    const mob = this.world.mobiles.get(Number(serial) >>> 0);
    return mob?._party ?? null;
  }

  _broadcast(party, bytes) {
    for (const s of party.members) {
      const m = this.world.mobiles.get(s);
      if (m?.client) m.client.send(bytes);
    }
  }

  _sendRoster(party) {
    const bytes = partyList(party.members);
    for (const serial of party.members) {
      const state = this.world.mobiles.get(serial)?.client;
      if (state && !sendNodeUOPartySnapshot(state)) state.send(bytes);
    }
  }

  /** Invite `targetSerial` to join `leader`'s party (creating one if needed). */
  invite(leaderSerial, targetSerial) {
    if (leaderSerial === targetSerial) return;
    const target = this.world.mobiles.get(targetSerial);
    if (!target?.client) return;
    let party = this.partyOf(leaderSerial);
    if (!party) {
      party = {
        id: leaderSerial >>> 0,
        leader: leaderSerial,
        members: [leaderSerial],
        pending: new Map(),
        canLoot: new Map(),
      };
      this.parties.add(party);
      this.byId.set(party.id, party);
      const leader = this.world.mobiles.get(leaderSerial);
      if (leader) leader._party = party;
    }
    if (party.members.includes(targetSerial)) return;
    // Expire stale invites — without this, a leader who repeat-invites a
    // never-responding target accumulates pending entries forever.
    // Bug-hunt #2 D: party.pending unbounded.
    const now = Date.now();
    for (const [k, info] of party.pending) {
      const stamp = typeof info === 'object' ? info?.invitedAt : null;
      if (stamp && now - stamp > 60_000) party.pending.delete(k);
    }
    // Duplicate-invite guard — popup spam protection.
    if (party.pending.has(targetSerial)) return;
    party.pending.set(targetSerial, { leader: leaderSerial, invitedAt: now });
    target.client.send(partyInvitation(leaderSerial));
  }

  accept(targetSerial, leaderSerial) {
    const party = this.partyOf(leaderSerial);
    if (!party) return;
    const info = party.pending.get(targetSerial);
    // `info` is either the legacy plain serial OR the new
    // { leader, invitedAt } object — accept both shapes.
    const inviteLeader = typeof info === 'object' ? info?.leader : info;
    if (inviteLeader !== leaderSerial) return;
    party.pending.delete(targetSerial);
    if (party.members.includes(targetSerial)) return;       // already a member
    // BUGFIX #50 (PHASE CH): leave whatever party the joiner was already
    // in. The previous code blindly pushed targetSerial onto members
    // and overwrote `_party` — leaving the joiner listed in their old
    // party (members[] never cleaned) while their UI showed only the
    // new one. Real ghost members the leader couldn't kick.
    const previousParty = this.partyOf(targetSerial);
    if (previousParty && previousParty !== party) {
      this.leave(targetSerial);
    }
    party.members.push(targetSerial);
    const target = this.world.mobiles.get(targetSerial);
    if (target) target._party = party;
    this._sendRoster(party);
  }

  decline(targetSerial, leaderSerial) {
    const party = this.partyOf(leaderSerial);
    if (!party) return;
    party.pending.delete(targetSerial);
    // BUGFIX #50 (PHASE CH): notify the leader that the invite was
    // refused so they can re-invite or carry on. Silent decline left
    // pickup-group leaders staring wondering why nothing was happening.
    const leader = this.world.mobiles.get(leaderSerial);
    const target = this.world.mobiles.get(targetSerial);
    if (leader?.client) {
      const name = target?.name ?? `Player 0x${(targetSerial >>> 0).toString(16)}`;
      leader.client.sendSystemMessage?.(`${name} has declined your party invitation.`);
    }
  }

  leave(memberSerial) {
    const party = this.partyOf(memberSerial);
    if (!party) return;
    party.members = party.members.filter((s) => s !== memberSerial);
    party.canLoot.delete(memberSerial >>> 0);
    const mem = this.world.mobiles.get(memberSerial);
    if (mem) mem._party = undefined;
    // Remove event to everyone (including the leaver) so clients can clear UI.
    const bytes = partyRemove(memberSerial, party.members);
    const leaver = this.world.mobiles.get(memberSerial);
    if (leaver?.client && !sendNodeUOPartySnapshot(leaver.client)) leaver.client.send(bytes);
    for (const serial of party.members) {
      const client = this.world.mobiles.get(serial)?.client;
      if (client && !sendNodeUOPartySnapshot(client)) client.send(bytes);
    }
    if (party.members.length < 2 || party.leader === memberSerial) {
      this.disband(party);
    }
  }

  disband(party) {
    for (const s of party.members) {
      const m = this.world.mobiles.get(s);
      if (m) m._party = undefined;
      if (m?.client && !sendNodeUOPartySnapshot(m.client)) m.client.send(partyRemove(s, []));
    }
    party.canLoot.clear();
    this.parties.delete(party);
    this.byId.delete(party.id);
  }

  setCanLoot(memberSerial, allow) {
    const party = this.partyOf(memberSerial);
    if (!party?.members.includes(memberSerial >>> 0)) return false;
    party.canLoot.set(memberSerial >>> 0, !!allow);
    this._sendRoster(party);
    return true;
  }

  tellAll(from, text) {
    const party = this.partyOf(from);
    if (!party) return;
    this._broadcast(party, partyMessage(from, text, true));
  }

  tellOne(from, toSerial, text) {
    const party = this.partyOf(from);
    if (!party?.members.includes(toSerial)) return;
    const target = this.world.mobiles.get(toSerial);
    if (target?.client) target.client.send(partyMessage(from, text, false));
  }
}
