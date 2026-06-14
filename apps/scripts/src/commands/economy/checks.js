import { createItem, destroyItemBySerial } from '../../_items.js';
import { allItems } from '../../_spatial.js';
import { itemBySerial } from '../../_entities.js';
// [checks <amount> — write a bank check from your bank balance.
//
// ServUO `Gumps/BankerGump.cs` "Check" button: split a chunk of bank
// gold into a portable BankCheck item that holds the requested amount.
// Min amount = 5,000gp, max single check = 1,000,000gp (ServUO caps).
//
// Requires that the player has previously opened their bank (`[bank`)
// near a banker — the bank box must exist on the player.

const BANK_CHECK_ID = 0x14F0;
const GOLD_PILE_ID  = 0x0EED;
const MIN_CHECK = 5_000;
const MAX_CHECK = 1_000_000;

export default function (api) {
  const { commands, world } = api;

  commands.register({
    name: 'checks',
    help: '[checks <amount> — write a bank check (min 5000, max 1,000,000gp).',
    access: 'Player',
    run: (ctx) => {
      const state = ctx.state;
      const mob = state?.mobile;
      if (!mob) return;
      const amount = parseInt(ctx.args[0] ?? '', 10);
      if (!Number.isFinite(amount) || amount < MIN_CHECK || amount > MAX_CHECK) {
        state.sendSystemMessage?.(`Check amount must be between ${MIN_CHECK} and ${MAX_CHECK} gold.`);
        return;
      }
      // Find the player's bank box (created by `[bank`).
      const serial = api.ctx.bankBoxes?.get?.(mob.serial);
      const bank = serial ? itemBySerial({ world }, serial) : null;
      if (!bank) {
        state.sendSystemMessage?.('Open your bank with [bank near a banker first.');
        return;
      }
      // Sum gold piles in the bank box.
      let balance = 0;
      const piles = [];
      for (const it of allItems({ world })) {
        if (it.parent !== bank.serial) continue;
        if ((it.itemId | 0) !== GOLD_PILE_ID) continue;
        balance += (it.amount | 0);
        piles.push(it);
      }
      if (balance < amount) {
        state.sendSystemMessage?.(`Insufficient balance: ${balance}/${amount}gp.`);
        return;
      }
      // Drain piles in order.
      let need = amount;
      for (const p of piles) {
        if (need <= 0) break;
        const take = Math.min(p.amount | 0, need);
        p.amount = (p.amount | 0) - take;
        need -= take;
        if ((p.amount | 0) <= 0) destroyItemBySerial(api, p.serial);
      }
      // Mint a check.
      createItem(api, world, {
        itemId: BANK_CHECK_ID,
        parent: bank.serial,
        value: amount,
        script: 'bank-check',
        name: `A bank check for ${amount}gp`,
      });
      state.sendSystemMessage?.(`A check for ${amount}gp lies in your bank.`);
    },
  });

  return () => commands.unregister('checks');
}
