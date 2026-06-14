// Tiny guild registry — a guild is just a name + a member set. Good enough for
// server-side chat relay; full guild management (abbreviations, war, alliances)
// is out of v1 scope.

import { guildMessage } from '@uo/protocol';

/**
 * @typedef {Object} Guild
 * @property {string} name
 * @property {Set<number>} members
 */

export class GuildRegistry {
  /**
   * @param {import('../world/world.js').World} world
   */
  constructor(world) {
    this.world = world;
    /** @type {Map<string, Guild>} */
    this.byName = new Map();
  }

  getOrCreate(name) {
    let g = this.byName.get(name);
    if (!g) {
      g = { name, members: new Set() };
      this.byName.set(name, g);
    }
    return g;
  }

  guildOf(mobileSerial) {
    const mob = this.world.mobiles.get(mobileSerial);
    return mob?._guild ?? null;
  }

  join(mobileSerial, guildName) {
    const mob = this.world.mobiles.get(mobileSerial);
    if (!mob) return;
    // Bug-hunt #7 B10: leave the previous guild first so the player isn't
    // recorded in two guilds' member sets (which made them receive guild
    // chat from both and `leave()` cleaned only the current pointer).
    if (mob._guild) this.leave(mobileSerial);
    const g = this.getOrCreate(guildName);
    g.members.add(mobileSerial);
    mob._guild = g;
  }

  leave(mobileSerial) {
    const g = this.guildOf(mobileSerial);
    if (!g) return;
    g.members.delete(mobileSerial);
    const mob = this.world.mobiles.get(mobileSerial);
    if (mob) mob._guild = undefined;
    if (g.members.size === 0) this.byName.delete(g.name);
  }

  /** Broadcast a chat line to every member of the speaker's guild. */
  chat(speakerSerial, text) {
    const g = this.guildOf(speakerSerial);
    if (!g) return;
    const speaker = this.world.mobiles.get(speakerSerial);
    if (!speaker) return;
    const bytes = guildMessage({ name: speaker.name, text });
    for (const s of g.members) {
      const m = this.world.mobiles.get(s);
      if (m?.client) m.client.send(bytes);
    }
  }
}
