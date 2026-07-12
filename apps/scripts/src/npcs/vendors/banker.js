// Banker NPC — listens for the word "bank" within range and opens the
// speaker's personal bank box. Mirrors ServUO `Banker.OnSpeech`. Uses
// the existing per-player bankbox map populated by `[bank` so a player
// who said "bank" once gets the same chest back.

import { spawnNPC } from './_spawn.js';
import { childrenOf } from '../../_inventory.js';
import { itemBySerial } from '../../_entities.js';
import { canCreateItem, createItem, destroyItemBySerial } from '../../_items.js';

const HEAR_RANGE = 12;

export default function register(api) {
  if (!api.commands || !api.protocol) return () => {};

  // Hook player speech via the unicode handler. The simplest route is to
  // patch `api.handlers[0xAD]` — but we don't want to break the existing
  // chain, so we wrap. Speech handlers in ServUO scan all NPCs in range
  // and let each react; we approximate by listening to a global "speech"
  // event we attach via the protocol layer here.
  //
  // A clean alternative is to register a behaviour on each banker NPC
  // and have it tick every 250ms scanning for nearby speakers — but
  // there's no convenient inbound speech buffer. For MVP we expose a
  // command `[banker spawn` that creates a banker, and the banker
  // greets when `bank` is spoken via a hook on the world's chat
  // broadcast (set up in main.js if needed).

  function ensureBankBox(world, mob) {
    if (!api.ctx.bankBoxes) api.ctx.bankBoxes = new Map();
    let serial = api.ctx.bankBoxes.get(mob.serial);
    let box = serial ? itemBySerial({ world }, serial) : null;
    if (!box) {
      box = createItem(api, world, {
        itemId: 0x09AB, hue: 0x0032,
        x: 0, y: 0, z: 0, map: mob.map,
        name: `${mob.name}'s bank box`,
        parent: mob.serial, layer: 0x1D, gumpId: 0x003C,
      });
      api.ctx.bankBoxes.set(mob.serial, box.serial);
    }
    return box;
  }

  // Banker behaviour — wanders only a tile or two, greets nearby
  // speakers when they utter "bank".
  api.ai?.registerBehavior?.({
    name: 'banker',
    initState() { return { lastGreet: 0 }; },
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
        if (now - state.lastGreet < 4_000) continue;
        state.lastGreet = now;
        // Criminal lockout — applies to every keyword.
        if ((speaker.criminalUntil ?? 0) > Date.now()) {
          speaker.client?.sendSystemMessage?.('Thou art a criminal and cannot access thy bank box.');
          continue;
        }
        if (kind === 'bank') {
          const box = ensureBankBox(api.world, speaker);
          if (speaker.client) {
            speaker.client.send(api.protocol.displayContainer(box.serial, box.gumpId));
            speaker.client.send(api.protocol.containerContents(box.serial, []));
            speaker.client.sendSystemMessage?.(`${mob.name ?? 'The banker'} opens your bank box.`);
          }
          ctx.broadcastSpeech?.(mob, 'I will safeguard your wares.', 0x35);
          continue;
        }
        if (kind === 'balance') {
          // Sum gold in the speaker's bank box (item id 0x0EED).
          const box = ensureBankBox(api.world, speaker);
          let gold = 0;
          for (const it of childrenOf(api, box)) {
            if (it.itemId !== 0x0EED) continue;
            gold += (it.amount ?? 1);
          }
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
          // Walk gold piles, draining `amount`.
          let remaining = amount;
          for (const it of [...childrenOf(api, box)]) {
            if (remaining <= 0) break;
            if (it.itemId !== 0x0EED) continue;
            const take = Math.min(it.amount ?? 0, remaining);
            it.amount -= take;
            remaining -= take;
            if (it.amount <= 0) {
              try { destroyItemBySerial(api, it.serial); }
              catch { /* already withdrawn */ }
            }
          }
          if (remaining === amount) {
            speaker.client?.sendSystemMessage?.('Thou hast not the gold in thy account.');
            continue;
          }
          const taken = amount - remaining;
          // Drop gold into the speaker's pack as a stack.
          api.game?.mobile?.giveItem?.(speaker, {
            itemId: 0x0EED,
            amount: taken,
            name: 'gold',
            stackable: true,
          }, { randomGrid: true });
          speaker.client?.sendSystemMessage?.(`Withdrawn ${taken} gold.`);
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
          let bal = 0;
          for (const it of childrenOf(api, box)) {
            if (it.itemId !== 0x0EED) continue;
            bal += (it.amount ?? 1);
          }
          if (bal < total) {
            speaker.client?.sendSystemMessage?.(
              `You need ${total} gold (including a 30 gold fee) in your bank box.`);
            continue;
          }
          let remaining = total;
          for (const it of [...childrenOf(api, box)]) {
            if (remaining <= 0) break;
            if (it.itemId !== 0x0EED) continue;
            const take = Math.min(it.amount ?? 0, remaining);
            it.amount -= take;
            remaining -= take;
            if (it.amount <= 0) {
              try { destroyItemBySerial(api, it.serial); }
              catch { /* already withdrawn */ }
            }
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

  api.commands.register({
    name: 'banker',
    help: '[banker — admin: spawn a banker NPC at your feet.',
    access: 'Admin',
    run(ctx) {
      // BUGFIX #44 (FAZA CB): the previous body of this command did
      // `createMobile(api, api.world, ...)` but never broadcast `mobileIncoming`,
      // so the banker was invisible to every player until a re-stream.
      // It also spawned naked. `spawnNPC` centralises both fixes.
      const mob = spawnNPC(api, ctx.sender, {
        name: 'Banker', body: 0x0190, hue: 0x83EA,
        kind: 'banker', outfit: 'noble',
        keywords: ['bank'],
        behavior: 'banker',
      });
      ctx.state.sendSystemMessage(`Banker 0x${mob.serial.toString(16)} spawned at your feet.`);
    },
  });

  return () => {
    api.ai?.unregisterBehavior?.('banker');
    api.commands.unregister('banker');
  };
}
