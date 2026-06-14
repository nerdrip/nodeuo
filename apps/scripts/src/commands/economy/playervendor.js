import { itemBySerial, mobileBySerial } from '../../_entities.js';
import { moveItem } from '../../_movement.js';
// [pv — Player Vendor admin commands. Mirrors the four ServUO
// PlayerVendor gumps (PlayerVendorOwnerGump / VendorRentalGump /
// VendorInventoryGump / ReclaimVendorGump) collapsed into a flat
// command surface so the existing chat → command pipeline can drive
// them without a custom client gump. A future client gump can replay
// the same verbs.
//
// Usage:
//   [pv place [shop name]            — hire a vendor at your feet
//   [pv list                          — list your active vendors
//   [pv stock <serial> <price>        — list an item you're holding
//   [pv pull <serial>                 — pull a listed item back
//   [pv deposit <amount>              — top up the vendor's bank
//   [pv withdraw <amount>             — withdraw earnings
//   [pv reclaim                       — dismiss + refund

export default function register(api) {
  if (!api.commands || !api.systems?.playerVendor) {
    api.log?.('cmd/pv: missing api.systems.playerVendor; skipping');
    return () => {};
  }
  const PV = api.systems.playerVendor;

  // [pv-buy <vendorHex> <itemHex> — buyer-side action issued by the
  // client PlayerVendorGump's Buy button. Validates owner-isn't-buyer +
  // gold present in pack + transfer.
  api.commands.register({
    name: 'pv-buy',
    help: '[pv-buy <vendorHex> <itemHex>',
    access: 'Player',
    run(ctx, args) {
      const buyer = ctx.sender;
      const vSerial = parseInt(args?.[0], 16) || 0;
      const iSerial = parseInt(args?.[1], 16) || 0;
      if (!vSerial || !iSerial) { ctx.state.sendSystemMessage('Usage: [pv-buy <vendorHex> <itemHex>'); return; }
      const vendor = mobileBySerial(api, vSerial);
      if (!vendor?.playerVendor) { ctx.state.sendSystemMessage('Not a player vendor.'); return; }
      const pack = api.game?.inventory?.findBackpack?.(buyer);
      if (!pack) {
        ctx.state.sendSystemMessage('You have no backpack.');
        return;
      }
      const r = PV.buyItem(api.world, vendor, buyer, iSerial);
      if (!r.ok) { ctx.state.sendSystemMessage(`Buy failed: ${r.reason}`); return; }
      // Transfer the item to the actual backpack.
      const gridX = 60 + ((Math.random() * 80) | 0);
      const gridY = 60 + ((Math.random() * 60) | 0);
      moveItem(api, r.item, { parent: pack.serial, x: gridX, y: gridY, z: 0 });
      r.item.gridX = gridX;
      r.item.gridY = gridY;
      r.item.gridLocation = 0;
      if (api.protocol?.containerContentUpdate) {
        ctx.state.send?.(api.protocol.containerContentUpdate(r.item, pack.serial));
      }
      ctx.state.sendSystemMessage(`Purchased ${r.entry.name} for ${r.entry.price}gp.`);
    },
  });

  // [pv-browse <vendorHex> — server replies with the full inventory
  // line by line so the client gump can render it without a special
  // 0xBF subop. Throttle 1×/sec/vendor to dampen rapid clicks.
  const _browseCooldown = new Map();
  api.commands.register({
    name: 'pv-browse',
    help: '[pv-browse <vendorHex>',
    access: 'Player',
    run(ctx, args) {
      const sender = ctx.sender;
      const vSerial = parseInt(args?.[0], 16) || 0;
      if (!vSerial) { ctx.state.sendSystemMessage('Usage: [pv-browse <vendorHex>'); return; }
      const lastBrowse = _browseCooldown.get(`${sender.serial}:${vSerial}`) ?? 0;
      const now = Date.now();
      if (now - lastBrowse < 1000) return;
      _browseCooldown.set(`${sender.serial}:${vSerial}`, now);
      const vendor = mobileBySerial(api, vSerial);
      const snap = PV.browseSnapshot?.(vendor);
      if (!snap) { ctx.state.sendSystemMessage('Not a player vendor.'); return; }
      ctx.state.sendSystemMessage(`=== ${snap.shopName} (${snap.ownerName}) ===`);
      for (const e of snap.items) {
        ctx.state.sendSystemMessage(`  [${e.serial.toString(16)}] ${e.name} x${e.amount} — ${e.price}gp`);
      }
      ctx.state.sendSystemMessage(`(${snap.items.length} item(s) on offer)`);
    },
  });

  api.commands.register({
    name: 'pv',
    help: '[pv place|list|stock|pull|deposit|withdraw|reclaim|gump|rent|inv …',
    access: 'Player',
    run(ctx, args) {
      const sub = (args?.[0] ?? '').toLowerCase();
      const sender = ctx.sender;
      if (!sender) return;

      switch (sub) {
        case 'gump':
        case 'browse-ui': {
          // Faza H.3 — open PlayerVendorGump overlay for a specific
          // vendor (args[1] = vendor hex serial). Triggers [pv-browse
          // server-side which emits the inventory lines the gump parses.
          const vSerial = parseInt(args[1], 16) || 0;
          if (!vSerial) {
            ctx.state.sendSystemMessage?.('Usage: [pv gump <vendorHex>');
            return;
          }
          // Pre-emit browse so gump has data immediately.
          ctx.state.sendSystemMessage?.(`@@OPEN_PLAYERVENDOR_GUMP@@${vSerial.toString(16)}`);
          // Replay pv-browse logic inline (gump self-installs to chat:system).
          const lastBrowse = _browseCooldown.get(`${sender.serial}:${vSerial}`) ?? 0;
          const now = Date.now();
          if (now - lastBrowse < 1000) return;
          _browseCooldown.set(`${sender.serial}:${vSerial}`, now);
          const vendor = mobileBySerial(api, vSerial);
          const snap = PV.browseSnapshot?.(vendor);
          if (!snap) return;
          ctx.state.sendSystemMessage(`PV === ${snap.shopName} (${snap.ownerName}) ===`);
          for (const e of snap.items) {
            ctx.state.sendSystemMessage(`PV [${e.serial.toString(16)}] ${e.name} x${e.amount} — ${e.price}gp`);
          }
          return;
        }
        case 'rent': {
          // Faza H.3 — open VendorRentalGump (shop name + deposit).
          ctx.state.sendSystemMessage?.('@@OPEN_VENDORRENTAL_GUMP@@');
          return;
        }
        case 'inv':
        case 'inventory': {
          // Faza H.3 — open VendorInventoryGump (owner management).
          ctx.state.sendSystemMessage?.('@@OPEN_VENDORINV_GUMP@@');
          return;
        }
        case 'place': {
          const shopName = args.slice(1).join(' ').trim() || `${sender.name}'s Shop`;
          const v = PV.placeVendor(api.world, sender, { shopName });
          if (!v) { ctx.state.sendSystemMessage('Could not place vendor.'); return; }
          ctx.state.sendSystemMessage(`Vendor "${shopName}" placed. Serial 0x${v.serial.toString(16)}.`);
          return;
        }
        case 'list': {
          const v = PV.findVendorByOwner(sender.serial);
          if (!v) { ctx.state.sendSystemMessage('You have no active vendor.'); return; }
          const pv = v.playerVendor;
          ctx.state.sendSystemMessage(`Vendor "${pv.shopName}" — bank ${pv.bankBalance | 0}gp, items ${pv.items.size}.`);
          for (const e of pv.items.values()) {
            ctx.state.sendSystemMessage(`  • [${e.serial.toString(16)}] ${e.name ?? '(item)'} ×${e.amount} — ${e.price}gp`);
          }
          return;
        }
        case 'stock': {
          const itemSerial = parseInt(args[1], 16) || 0;
          const price      = parseInt(args[2], 10) || 0;
          if (!itemSerial || price <= 0) {
            ctx.state.sendSystemMessage('Usage: [pv stock <hexSerial> <price>');
            return;
          }
          const item = itemBySerial(api, itemSerial);
          if (!item || item.parent !== sender.serial) {
            ctx.state.sendSystemMessage('You must hold the item in your pack.');
            return;
          }
          const v = PV.findVendorByOwner(sender.serial);
          if (!v) { ctx.state.sendSystemMessage('You have no active vendor.'); return; }
          PV.addStock(v, item, price, args.slice(3).join(' '), api.world);
          ctx.state.sendSystemMessage(`Listed ${item.name ?? 'item'} for ${price}gp.`);
          return;
        }
        case 'pull': {
          const itemSerial = parseInt(args[1], 16) || 0;
          const v = PV.findVendorByOwner(sender.serial);
          if (!v) { ctx.state.sendSystemMessage('You have no active vendor.'); return; }
          const pack = api.game?.inventory?.findBackpack?.(sender);
          if (!pack) {
            ctx.state.sendSystemMessage('You have no backpack.');
            return;
          }
          if (!PV.removeStock(v, itemSerial)) {
            ctx.state.sendSystemMessage('Item not on this vendor.');
            return;
          }
          const item = itemBySerial(api, itemSerial);
          if (item) {
            const gridX = 60 + ((Math.random() * 80) | 0);
            const gridY = 60 + ((Math.random() * 60) | 0);
            moveItem(api, item, { parent: pack.serial, x: gridX, y: gridY, z: 0 });
            item.gridX = gridX;
            item.gridY = gridY;
            item.gridLocation = 0;
            if (api.protocol?.containerContentUpdate) {
              ctx.state.send?.(api.protocol.containerContentUpdate(item, pack.serial));
            }
          }
          ctx.state.sendSystemMessage('Item returned to your pack.');
          return;
        }
        case 'deposit': {
          const amt = parseInt(args[1], 10) || 0;
          const v = PV.findVendorByOwner(sender.serial);
          if (!v) { ctx.state.sendSystemMessage('You have no active vendor.'); return; }
          if (amt <= 0) { ctx.state.sendSystemMessage('Usage: [pv deposit <amount>'); return; }
          // No real bank withdrawal yet — symbolic.
          PV.deposit(v, amt);
          ctx.state.sendSystemMessage(`Deposited ${amt}gp. Vendor balance: ${v.playerVendor.bankBalance | 0}gp.`);
          return;
        }
        case 'withdraw': {
          const amt = parseInt(args[1], 10) || 0;
          const v = PV.findVendorByOwner(sender.serial);
          if (!v) { ctx.state.sendSystemMessage('You have no active vendor.'); return; }
          const taken = PV.withdraw(v, amt);
          ctx.state.sendSystemMessage(`Withdrew ${taken}gp.`);
          return;
        }
        case 'reclaim': {
          const v = PV.findVendorByOwner(sender.serial);
          if (!v) { ctx.state.sendSystemMessage('You have no active vendor.'); return; }
          const r = PV.reclaim(api.world, v);
          ctx.state.sendSystemMessage(`Vendor dismissed. ${r?.items?.length ?? 0} item(s) and ${r?.refund ?? 0}gp returned.`);
          return;
        }
        default:
          ctx.state.sendSystemMessage('Usage: [pv place|list|stock|pull|deposit|withdraw|reclaim');
      }
    },
  });
  return () => {};
}
