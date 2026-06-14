// ServUO `BaseEscortable` context entries:
// `AcceptEscortEntry`, `AbandonEscortEntry`, `AskDestinationEntry`,
// plus its `DeleteTimer` timeout, adapted to chat commands for the web client.

import { resolveMobileArg } from '../commands/_targeting-helpers.js';
import { allMobiles } from '../_spatial.js';

function escortQuestFor(api, npc) {
  const quests = api.mlQuests?.listQuests?.() ?? [];
  return quests.find((q) => q.objectives?.some?.((o) => o.type === 'escort')
    && (!q.giverKind || q.giverKind === npc.kind || q.giverKind === npc.npcKind || q.giverKind === npc.vendorKind));
}

function escortObjective(def) {
  return def?.objectives?.find?.((o) => o.type === 'escort') ?? null;
}

function attachEscortAI(api, npc) {
  npc.petCommand = 'follow';
  npc._listensToSpeech = true;
  npc._speechKeywords = ['all', 'destination', 'where', 'abandon'];
  try { api.ai?.attach?.(npc, 'pet', { command: 'follow' }); } catch { /* behavior may load later */ }
}

function acceptEscort(api, player, npc, say) {
  const def = escortQuestFor(api, npc);
  const obj = escortObjective(def);
  if (!def || !obj) {
    say('That NPC has no escort destination.');
    return;
  }
  const offered = api.mlQuests?.offer?.(player, def.id);
  if (!offered?.ok && offered?.reason !== 'already-active') {
    say(`Cannot accept escort: ${offered?.reason ?? 'unknown'}.`);
    return;
  }
  npc.controlMaster = player.serial;
  npc.escortMasterSerial = player.serial;
  npc.escortQuestId = def.id;
  npc.escortDestination = obj.toRegion;
  npc.escortAcceptedAt = Date.now();
  npc.escortExpiresAt = Date.now() + (30 * 60 * 1000);
  npc.servuoClasses ??= ['BaseEscortable', 'AcceptEscortEntry', 'AbandonEscortEntry', 'AskDestinationEntry', 'DeleteTimer'];
  attachEscortAI(api, npc);
  say(`${npc.name ?? 'The escort'} will follow you to ${obj.toRegion}.`);
}

function abandonEscort(api, player, npc, say) {
  if ((npc.escortMasterSerial >>> 0) !== (player.serial >>> 0)) {
    say('That escort is not following you.');
    return;
  }
  if (npc.escortQuestId) api.mlQuests?.abandon?.(player, npc.escortQuestId);
  npc.controlMaster = 0;
  npc.escortMasterSerial = 0;
  npc.escortQuestId = null;
  npc.escortDestination = null;
  npc.escortExpiresAt = 0;
  npc.petCommand = 'stay';
  try { api.ai?.attach?.(npc, 'wander'); } catch { /* optional */ }
  say(`${npc.name ?? 'The escort'} stops following you.`);
}

function destinationEscort(_api, _player, npc, say) {
  const dest = npc.escortDestination;
  say(dest ? `${npc.name ?? 'The escort'} wants to go to ${dest}.` : 'That escort has no active destination.');
}

export default function register(api) {
  if (!api.commands || !api.mlQuests) return () => {};

  for (const mob of allMobiles(api)) {
    if (mob.escortMasterSerial && mob.escortQuestId) attachEscortAI(api, mob);
  }

  api.commands.register({
    name: 'escort',
    help: '[escort accept|abandon|destination [npcSerial]',
    access: 'Player',
    run(ctx, args) {
      const action = String(args?.[0] ?? 'destination').toLowerCase();
      resolveMobileArg(api, ctx, 1, (npc) => {
        if (!npc) return;
        const say = (msg) => ctx.state?.sendSystemMessage?.(msg);
        if (action === 'accept') acceptEscort(api, ctx.sender, npc, say);
        else if (action === 'abandon') abandonEscort(api, ctx.sender, npc, say);
        else destinationEscort(api, ctx.sender, npc, say);
      }, { promptText: 'Target the escort NPC.' });
    },
  });

  return () => api.commands.unregister('escort');
}
