// PartyInviteGump — accept/decline incoming party invitation.
// Mirrors ClassicUO Game/UI/Gumps/PartyInviteGump.cs.
//
// Triggered by 0xBF subop 0x06 sub-action 0x07 (Invite) — partyManager
// emits 'party:invite'; the scene pops this gump.

import { showMessageBox } from './message-box-gump.js';
import { net } from '../../net/net-client.js';
import { buildPartyAccept, buildPartyDecline } from '../../net/outgoing.js';

/**
 * Show the invite dialog. Resolves true on accept, false on decline.
 * Sends the party reply packet on the user's choice.
 *
 * @param {{leaderSerial:number, leaderName?:string}} info
 */
export async function showPartyInvite(info) {
  const name = info.leaderName ?? `serial ${info.leaderSerial.toString(16)}`;
  const accepted = await showMessageBox(
    `You have been invited to join ${name}'s party. Accept?`,
    { ok: 'Accept', cancel: 'Decline' },
  );
  try {
    if (accepted) net.send(buildPartyAccept(info.leaderSerial));
    else net.send(buildPartyDecline(info.leaderSerial));
  } catch { /* socket gone */ }
  return accepted;
}
