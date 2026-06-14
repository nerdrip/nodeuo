// Donation Vendor NPC — ServUO `Engines/Community Collections/...`
// stationed in Vesper Marketplace / Britain Library / Royal Britannian
// Court. Listens for "donate" within speech range and walks the player
// through the same `[donate` flow without forcing them to remember a
// command — the vendor speaks the open collections list and prompts for
// a target.
//
// Speech keywords:
//   "donate"       → list collections + prompt for target
//   "<collection>" → status of that specific collection
//   "top"          → top-10 donors for the most-recent listed collection
//
// Spawn: `[donation-vendor` admin command (Admin) — typically called by
// `[createworld` decorate pass to plant one in Britain Library + Vesper
// + Trinsic. For ad-hoc placement, drop at GM feet.

import { spawnNPC } from './_spawn.js';
import { itemBySerial } from '../../_entities.js';
import { destroyItemBySerial } from '../../_items.js';

const HEAR_RANGE = 6;

function distance(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export default function register(api) {
  if (!api.commands || !api.protocol || !api.targeting) return () => {};
  const collections = api.systems?.communityCollections;
  if (!collections) {
    api.log?.('donation-vendor: community collections system unavailable');
    return () => {};
  }

  api.ai?.registerBehavior?.({
    name: 'donation-vendor',
    initState() { return { lastSpeech: 0, focus: null }; },
    tick(ctx, mob, state) {
      const queue = mob._heardSpeech;
      if (!queue || queue.length === 0) return;
      const now = ctx.now;
      while (queue.length > 0) {
        const entry = queue.shift();
        if (!entry?.text || !entry.speaker) continue;
        if (entry.speaker.map !== mob.map) continue;
        if (distance(entry.speaker, mob) > HEAR_RANGE) continue;
        if (now - state.lastSpeech < 1_500) continue;
        const text = String(entry.text).toLowerCase().trim();
        const speaker = entry.speaker;

        if (text === 'donate' || text.includes('what can i donate')) {
          state.lastSpeech = now;
          const ids = collections.listCollections();
          if (ids.length === 0) {
            ctx.broadcastSpeech?.(mob, 'No collections are open today.', 0x35);
            continue;
          }
          ctx.broadcastSpeech?.(mob, 'We accept these gifts on behalf of Britannia:', 0x35);
          for (const id of ids) {
            const c = collections.collectionInfo(id);
            ctx.broadcastSpeech?.(mob, `  ${id} — ${c.label}`, 0x35);
          }
          state.focus = ids[0];
          ctx.broadcastSpeech?.(mob, 'Say "top" for the leaderboard, or target an item to give.', 0x35);
          continue;
        }
        if (text === 'top' && state.focus) {
          state.lastSpeech = now;
          const top = collections.topDonors(api.world, state.focus, 5);
          if (top.length === 0) {
            ctx.broadcastSpeech?.(mob, 'No one has given yet.', 0x35);
            continue;
          }
          ctx.broadcastSpeech?.(mob, `Top donors (${collections.collectionInfo(state.focus).label}):`, 0x35);
          top.forEach((d, i) => {
            ctx.broadcastSpeech?.(mob, `  ${i + 1}. ${d.name ?? d.serial.toString(16)} — ${d.points}`, 0x35);
          });
          continue;
        }
        // Collection-id status
        const collId = collections.listCollections().find((id) => text === id.toLowerCase());
        if (collId) {
          state.lastSpeech = now;
          state.focus = collId;
          const s = collections.status(api.world, collId);
          ctx.broadcastSpeech?.(mob,
            `${s.label}: total ${s.total}, awarded ${s.tiersAwarded}, next tier ${s.nextTier ?? 'max'}.`, 0x35);
          continue;
        }
        // Player asks the vendor to "take" item — open targeting on the
        // speaker's client. Vendors that get spammed with bad targets
        // back off via lastSpeech throttle (above).
        if (text === 'take this' || text === 'here') {
          state.lastSpeech = now;
          if (!state.focus) {
            ctx.broadcastSpeech?.(mob, 'Which collection? Say its name first.', 0x35);
            continue;
          }
          const focus = state.focus;
          ctx.broadcastSpeech?.(mob, 'Show me the item.', 0x35);
          if (speaker.client && api.targeting?.request) {
            api.targeting.request(speaker.client.netState ?? speaker.client, (picked) => {
              if (!picked) return;
              const item = itemBySerial(api, picked.serial >>> 0);
              if (!item) return;
              const r = collections.donate(api.world, focus, speaker, item);
              if (!r.ok) {
                speaker.client.sendSystemMessage?.(r.reason);
                return;
              }
              try { destroyItemBySerial(api, item.serial >>> 0); }
              catch { /* already donated */ }
              if (api.protocol?.removeEntity) {
                speaker.client.send?.(api.protocol.removeEntity(item.serial >>> 0));
              }
              speaker.client.sendSystemMessage?.(
                `+${r.points} points (total ${r.total})${r.crossed ? ` — tier ${r.crossed}!` : ''}.`,
              );
              ctx.broadcastSpeech?.(mob, 'Thank you for your generosity.', 0x35);
            });
          }
        }
      }
    },
  });

  api.commands.register({
    name: 'donation-vendor',
    help: '[donation-vendor — admin: spawn a donation vendor at your feet.',
    access: 'Admin',
    run(ctx) {
      const mob = spawnNPC(api, ctx.sender, {
        name: 'Donation Steward', body: 0x0190, hue: 0x83EA,
        kind: 'donation-vendor', outfit: 'noble',
        keywords: ['donate', 'collection', 'top'],
        behavior: 'donation-vendor',
      });
      ctx.state.sendSystemMessage(
        `Donation steward 0x${mob.serial.toString(16)} spawned at your feet.`,
      );
    },
  });

  return () => {
    api.ai?.unregisterBehavior?.('donation-vendor');
    api.commands.unregister('donation-vendor');
  };
}
