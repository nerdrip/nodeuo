// Banker NPC — listens for the word "bank" within range and opens the
// speaker's personal bank box. Mirrors ServUO `Banker.OnSpeech`. Uses
// the existing per-player bankbox map populated by `[bank` so a player
// who said "bank" once gets the same chest back.

import { spawnNPC } from './_spawn.js';
import { childrenOf } from '../../_inventory.js';
import { itemBySerial } from '../../_entities.js';
import { canCreateItem, createItem, destroyItemBySerial } from '../../_items.js';
import { allMobiles } from '../../_spatial.js';

const HEAR_RANGE = 12;

export default function register(api) {
  if (!api.commands || !api.protocol) return () => {};

  // The network speech dispatcher performs the range/listener checks and
  // appends intelligible lines to each NPC's bounded `_speechQueue`. The
  // banker behavior consumes that queue, so it never scans all players and
  // never patches a packet handler or global event chain.

  function ensureBankBox(world, mob) {
    if (!api.ctx.bankBoxes) api.ctx.bankBoxes = new Map();
    let serial = api.ctx.bankBoxes.get(mob.serial);
    let box = serial ? itemBySerial({ world }, serial) : null;
    if (!box) {
      box = createItem(api, world, {
        itemId: 0x09AB, hue: 0x0032,
        x: 0, y: 0, z: 0, map: mob.map,
        name: `${mob.name}'s bank box`,
        parent: mob.serial, layer: 0x1D, gumpId: 0x004A,
      });
      api.ctx.bankBoxes.set(mob.serial, box.serial);
    }
    return box;
  }

  function bankGold(box) {
    let total = 0;
    for (const item of childrenOf(api, box)) {
      if (item.itemId === 0x0EED) total += Math.max(0, item.amount ?? 1);
    }
    return total;
  }

  function debitBankGold(box, amount) {
    if (!Number.isSafeInteger(amount) || amount <= 0 || bankGold(box) < amount) return false;
    let remaining = amount;
    for (const item of [...childrenOf(api, box)]) {
      if (remaining === 0) break;
      if (item.itemId !== 0x0EED) continue;
      const take = Math.min(Math.max(0, item.amount ?? 1), remaining);
      item.amount = Math.max(0, (item.amount ?? 1) - take);
      remaining -= take;
      if (item.amount === 0) {
        try { destroyItemBySerial(api, item.serial); }
        catch { /* already removed */ }
      } else {
        api.markers?.markItemDirty?.(item);
      }
    }
    return remaining === 0;
  }

  function bankEntries(box) {
    const entries = [];
    for (const item of childrenOf(api, box)) {
      entries.push({
        serial: item.serial, itemId: item.itemId, amount: item.amount ?? 1,
        gridX: item.gridX ?? 0, gridY: item.gridY ?? 0,
        gridLocation: item.gridLocation ?? 0, hue: item.hue ?? 0,
      });
    }
    return entries;
  }

  // Banker behaviour — wanders only a tile or two, greets nearby
  // speakers when they utter "bank".
  api.ai?.registerBehavior?.({
    name: 'banker',
    initState() { return { lastGreetBySpeaker: new Map() }; },
    tick(ctx, mob, state) {
      // No movement — bankers stay at their counter.
      // Listen via `mob._heardSpeech` queue if any speech hook fills it.
      const queue = mob._heardSpeech;
      if (!queue || queue.length === 0) return;
      const now = ctx.now;
      // Audit #33 P2 #6 — ServUO `Banker.cs:314-460` honours four
      // keywords (`bank`, `balance`, `withdraw <n>`, `check <n>`) and
      // refuses every one of them when the speaker is criminally
      // flagged. Earlier impl only matched substring "bank" and let
      // criminals access their bank box freely.
      while (queue.length > 0) {
        const entry = queue.shift();
        if (!entry || !entry.text || !entry.speaker) continue;
        if (Math.abs(entry.speaker.x - mob.x) > HEAR_RANGE) continue;
        if (Math.abs(entry.speaker.y - mob.y) > HEAR_RANGE) continue;
        if (entry.speaker.map !== mob.map) continue;
        const text = String(entry.text).toLowerCase();
        const speaker = entry.speaker;
        let kind = null;
        let amount = 0;
        const withdrawM = text.match(/^withdraw\s+(\d+)\s*$/);
        const checkM    = text.match(/^check\s+(\d+)\s*$/);
        if (withdrawM)             { kind = 'withdraw'; amount = +withdrawM[1] | 0; }
        else if (checkM)           { kind = 'check';    amount = +checkM[1]    | 0; }
        else if (text === 'balance' || text === 'bank balance') kind = 'balance';
        else if (text.includes('bank')) kind = 'bank';
        if (!kind) continue;
        const speakerKey = speaker.serial >>> 0;
        const lastGreet = state.lastGreetBySpeaker.get(speakerKey) ?? -Infinity;
        if (now - lastGreet < 4_000) continue;
        state.lastGreetBySpeaker.set(speakerKey, now);
        // Keep a long-lived banker bounded even on a busy shard.
        if (state.lastGreetBySpeaker.size > 256) {
          const cutoff = now - 60_000;
          for (const [serial, at] of state.lastGreetBySpeaker) {
            if (at < cutoff) state.lastGreetBySpeaker.delete(serial);
          }
        }
        // Criminal lockout — applies to every keyword.
        if ((speaker.criminalUntil ?? 0) > Date.now()) {
          speaker.client?.sendSystemMessage?.('Thou art a criminal and cannot access thy bank box.');
          continue;
        }
        if (kind === 'bank') {
          const box = ensureBankBox(api.world, speaker);
          if (speaker.client) {
            speaker.client.send(api.protocol.displayContainer(box.serial, box.gumpId));
            speaker.client.send(api.protocol.containerContents(box.serial, bankEntries(box)));
            speaker.client.openContainers?.add?.(box.serial);
            speaker.client.sendSystemMessage?.(`${mob.name ?? 'The banker'} opens your bank box.`);
          }
          ctx.broadcastSpeech?.(mob, 'I will safeguard your wares.', 0x35);
          continue;
        }
        if (kind === 'balance') {
          // Sum gold in the speaker's bank box (item id 0x0EED).
          const box = ensureBankBox(api.world, speaker);
          const gold = bankGold(box);
          speaker.client?.sendSystemMessage?.(`Thy bank balance is ${gold} gold.`);
          continue;
        }
        if (kind === 'withdraw') {
          if (amount <= 0) {
            speaker.client?.sendSystemMessage?.('Withdraw how much?');
            continue;
          }
          if (!api.game?.inventory?.findBackpack?.(speaker)) {
            speaker.client?.sendSystemMessage?.('You have no backpack.');
            continue;
          }
          const box = ensureBankBox(api.world, speaker);
          // Validate the complete debit before touching a pile. The old path
          // silently converted a partial balance into a partial withdrawal.
          if (!debitBankGold(box, amount)) {
            speaker.client?.sendSystemMessage?.('Thou hast not the gold in thy account.');
            continue;
          }
          // Drop gold into the speaker's pack as a stack.
          api.game?.mobile?.giveItem?.(speaker, {
            itemId: 0x0EED,
            amount,
            name: 'gold',
            stackable: true,
          }, { randomGrid: true });
          speaker.client?.sendSystemMessage?.(`Withdrawn ${amount} gold.`);
          continue;
        }
        if (kind === 'check') {
          // Audit #40 P2 #16 — ServUO `Banker.cs OnSpeech` creates a
          // BankCheck (item 0x14F0) and drains `amount + 30gp fee`
          // from bank gold piles. Range 5000..1_000_000 inclusive.
          // Was: emitted a system msg with no item or gold movement.
          const FEE = 30;
          if (amount < 5000 || amount > 1_000_000) {
            speaker.client?.sendSystemMessage?.(
              'A check may only be written for an amount between 5000 and 1,000,000 gold.');
            continue;
          }
          const total = amount + FEE;
          const box = ensureBankBox(api.world, speaker);
          if (bankGold(box) < total) {
            speaker.client?.sendSystemMessage?.(
              `You need ${total} gold (including a 30 gold fee) in your bank box.`);
            continue;
          }
          if (!debitBankGold(box, total)) {
            speaker.client?.sendSystemMessage?.('The transaction could not be completed.');
            continue;
          }
          if (canCreateItem(api, api.world)) {
            const check = createItem(api, api.world, {
              itemId: 0x14F0,            // BankCheck graphic
              parent: box.serial,
              name: `A bank check for ${amount} gold`,
              x: 0, y: 0, z: 0, map: speaker.map,
              hue: 0,
            });
            check.bankCheckAmount = amount;
            check.value = amount;
            check.script = 'bank-check';
          }
          speaker.client?.sendSystemMessage?.(
            `A bank check for ${amount} gold has been placed in your bank box.`);
          continue;
        }
      }
    },
  });

  // Migrate bankers already present in a persisted world. Older saves kept
  // only `aiBehavior: banker`, displayed the literal name "Banker", and
  // lost the speech-listener metadata after restart. Name is presentation;
  // the separate role fields remain the authoritative service identity.
  for (const mob of allMobiles({ world: api.world })) {
    const roles = [mob.kind, mob.npcKind, mob.npcRole, mob.vendorKind,
      mob.behavior, mob.aiBehavior].map((v) => String(v ?? '').toLowerCase());
    if (!roles.includes('banker')) continue;
    mob.kind ??= 'banker';
    mob.npcKind ??= 'banker';
    mob.npcRole ??= 'banker';
    mob.title ||= 'the banker';
    if (/^(?:a |an |the )?banker$/i.test(String(mob.name ?? '').trim())) {
      mob.name = api.names?.pickForMob?.({ body: mob.body }) ?? 'Aldwin';
    }
    mob._listensToSpeech = true;
    mob._speechKeywords = ['bank', 'balance', 'withdraw', 'check'];
    if (!mob.aiBehavior) {
      try { api.ai?.attach?.(mob, 'banker'); mob.aiBehavior = 'banker'; }
      catch { /* registration still enables context-menu service routing */ }
    }
  }

  api.commands.register({
    name: 'banker',
    help: '[banker — admin: spawn a banker NPC at your feet.',
    access: 'Admin',
    run(ctx) {
      // BUGFIX #44 (PHASE CB): the previous body of this command did
      // `createMobile(api, api.world, ...)` but never broadcast `mobileIncoming`,
      // so the banker was invisible to every player until a re-stream.
      // It also spawned naked. `spawnNPC` centralises both fixes.
      const mob = spawnNPC(api, ctx.sender, {
        name: 'a banker', title: 'the banker', body: 0x0190, hue: 0x83EA,
        kind: 'banker', outfit: 'noble',
        keywords: ['bank', 'balance', 'withdraw', 'check'],
        behavior: 'banker',
      });
      ctx.state.sendSystemMessage(`${mob.name}, ${mob.title} (0x${mob.serial.toString(16)}) spawned at your feet.`);
    },
  });

  return () => {
    api.ai?.unregisterBehavior?.('banker');
    api.commands.unregister('banker');
  };
}
