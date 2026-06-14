import { createItem, destroyItemBySerial } from '../../../_items.js';
import { allItems } from '../../../_spatial.js';
import { itemBySerial } from '../../../_entities.js';
// Bank check — ServUO `Items/Consumables/BankCheck.cs`. Acts as a
// portable token for a fixed gold amount. Using one inside the bank
// box deposits its value into the account; using it outside cashes
// it into a gold pile in pack.

const GOLD_PILE_ID = 0x0EED;

export default function buildBankCheckScript(api) {
  return {
    name: 'bank-check',
    onUse(world, item, user) {
      const value = (item.value | 0);
      if (value <= 0) {
        user?.client?.sendSystemMessage?.('This check has no value.');
        return true;
      }
      // Detect bank-box context: ServUO checks parent chain for the
      // player's bank container. We mark bank boxes with `isBankBox=true`
      // when spawned. Walk up the parent chain to find one.
      let parentSerial = item.parent | 0;
      let inBank = false;
      let safety = 8;
      while (parentSerial && safety-- > 0) {
        const p = itemBySerial({ world }, parentSerial);
        if (!p) break;
        if (p.isBankBox) { inBank = true; break; }
        parentSerial = p.parent | 0;
      }
      if (inBank) {
        // Deposit into the bank — find any existing gold pile in the
        // same bank, otherwise create a new one.
        const bankSerial = parentSerial;
        let goldPile = null;
        for (const it of allItems({ world })) {
          if (it.parent !== bankSerial) continue;
          if ((it.itemId | 0) !== GOLD_PILE_ID) continue;
          goldPile = it; break;
        }
        if (goldPile) goldPile.amount = (goldPile.amount | 0) + value;
        else {
          createItem(api, world, {
            itemId: GOLD_PILE_ID,
            amount: value,
            parent: bankSerial,
            name: 'gold',
          });
        }
        destroyItemBySerial(api, item.serial);
        user?.client?.sendSystemMessage?.(`Deposited ${value} gold into your bank.`);
        return true;
      }
      // Outside the bank — convert to a gold pile in user's pack.
      const gold = api.game?.mobile?.giveItem?.(user, {
        itemId: GOLD_PILE_ID,
        amount: value,
        name: 'gold',
      }, { randomGrid: true });
      if (!gold) {
        user?.client?.sendSystemMessage?.('You have no backpack for the gold.');
        return true;
      }
      destroyItemBySerial(api, item.serial);
      user?.client?.sendSystemMessage?.(`You cash the check for ${value} gold.`);
      return true;
    },
  };
}
