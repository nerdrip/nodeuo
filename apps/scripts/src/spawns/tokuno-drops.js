// Tokuno drop hook — Tokuno-tier mob deaths roll a chance at a
// currently-rotated minor artifact.
//
// ServUO sets the drop on `BaseCreature.OnDeath` for any mob with the
// `IsTokunoBoss` flag or the `OniLord` / `LadyOfTheSnow` / `YomotsuPriest`
// kinds. We mirror by filtering by `kind`. Drop chance is ~3% per kill
// (much lower than peerless; Tokuno is meant as a long-grind farm).

import { createItem, destroyItemBySerial } from '../_items.js';
import { findBackpack, packItems } from '../_inventory.js';
import { allMobiles } from '../_spatial.js';

const TOKUNO_KINDS = new Set([
  'oni-lord', 'oni',
  'lady-of-the-snow', 'lady-snow',
  'yomotsu-priest', 'yomotsu-elder', 'yomotsu-warrior',
  'ronin', 'samurai-ronin',
  'tsuki-wolf',
  'gaman',
  'rune-beetle',
]);

const DROP_CHANCE = 0.03;

export default function register(api) {
  if (!api.corpse?.addKillHook) return () => {};
  const tokuno = api.systems?.treasuresOfTokuno;
  const registry = api.systems?.itemRegistry;
  if (!tokuno || !registry) {
    api.log?.('tokuno-drops: Tokuno systems unavailable');
    return () => {};
  }

  api.corpse.addKillHook((_world, victim, killer) => {
    if (!victim || !TOKUNO_KINDS.has(victim.kind ?? '')) return;
    if (!killer?.client) return;
    if (Math.random() >= DROP_CHANCE) return;
    const tag = tokuno.rollArtifact();
    if (!tag) return;
    const def = registry.getItemByTag?.(tag);
    if (!def) return;
    try {
      const item = createItem(api, api.world, {
        itemId: def.itemId, hue: def.hue, name: def.name,
        x: victim.x, y: victim.y, z: victim.z, map: victim.map,
        movable: true, weight: def.weight ?? 5,
      });
      if (item) {
        item.tokunoArtifact = true;
        item.tagId = tag;
        // Shard-wide announce so other Tokuno hunters know one dropped.
        const pkt = api.protocol?.unicodeMessage?.({
          text: `${killer.name ?? 'A hero'} has discovered a ${def.name}!`,
          hue: 0x47E, font: 3, name: 'System',
        });
        if (pkt) for (const m of allMobiles(api)) {
          if (m.client) m.client.send(pkt);
        }
      }
    } catch (e) {
      api.log?.(`[tokuno-drops] artifact spawn failed: ${e.message}`);
    }
  });

  // Bind the turn-in path as a `[tokuno turnin` chat command so players
  // can convert 10 minor artifacts into a Major one without needing a
  // visible turn-in NPC.
  if (api.commands?.register) {
    api.commands.register({
      name: 'tokuno',
      help: '[tokuno status|turnin — Treasures of Tokuno rotation + turn-ins.',
      access: 'Player',
      run(ctx) {
        const sub = String(ctx.args[0] ?? '').toLowerCase();
        if (sub === 'status') {
          // Lazy-import the rotationInfo helper from the same module.
          const info = tokuno.rotationInfo();
          const days = Math.ceil(info.msUntilRotate / 86_400_000);
          ctx.state.sendSystemMessage?.(
            `Tokuno rotation slot ${info.slot} — rotates in ~${days} day(s).`,
          );
          ctx.state.sendSystemMessage?.(`Active artifacts (${info.active.length}):`);
          for (const t of info.active) ctx.state.sendSystemMessage?.(`  ${t}`);
          const myCount = tokuno.turninCount(ctx.state?.account ?? {});
          ctx.state.sendSystemMessage?.(`Your turn-in tally: ${myCount}/10`);
          return;
        }
        if (sub === 'turnin') {
          // Walk pack for tokuno-tagged items, count + consume up to 10.
          const pack = findBackpack(api, ctx.sender);
          if (!pack) { ctx.state.sendSystemMessage?.('No backpack.'); return; }
          const toTurn = [...packItems(api, ctx.sender)]
            .filter((it) => it.tokunoArtifact)
            .slice(0, 10);
          if (toTurn.length === 0) {
            ctx.state.sendSystemMessage?.('You have no Tokuno minor artifacts to turn in.');
            return;
          }
          for (const it of toTurn) {
            try { destroyItemBySerial(api, it.serial); }
            catch { /* ignore */ }
          }
          const acct = ctx.state?.account ?? { id: ctx.sender.serial };
          let total = null;
          for (let i = 0; i < toTurn.length; i++) {
            total = tokuno.recordTurnin(acct);
          }
          if (total?.major) {
            ctx.state.sendSystemMessage?.(
              '★ You have turned in 10 minor artifacts! A Major Artifact will be granted (see your local Special Move trainer).',
            );
          } else {
            ctx.state.sendSystemMessage?.(
              `Turned in ${toTurn.length} artifact(s). Total tally: ${total?.count ?? '?'}/10.`,
            );
          }
          return;
        }
        ctx.state.sendSystemMessage?.('Usage: [tokuno status|turnin');
      },
    });
  }

  return () => {
    try { api.commands?.unregister?.('tokuno'); } catch { /* ignore */ }
  };
}
