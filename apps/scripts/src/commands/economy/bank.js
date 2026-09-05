import { allMobiles, allItems } from '../../_spatial.js';
import { itemBySerial } from '../../_entities.js';
import { createItem } from '../../_items.js';
// [bank — spawn a personal bankbox item at the player's feet and open it.
//
// A bankbox is just a container whose serial is remembered per player. For v1
// we stash the mapping on `api.ctx` so the same box re-opens across logins
// within a server session (but not persisted to disk explicitly).

export default function (api) {
  const { commands, world, protocol } = api;

  function findMobileNear(center, predicate, range, self = null) {
    const found = api.game?.findMobileNear?.(center, predicate, { range, self });
    if (found) return found;
    const iter = api.query?.mobilesNear?.(center, range, self) ?? allMobiles({ world });
    for (const other of iter) {
      if (other === self) continue;
      if (other.map !== center.map) continue;
      if (Math.abs(other.x - center.x) > range || Math.abs(other.y - center.y) > range) continue;
      if (predicate(other)) return other;
    }
    return null;
  }

  commands.register({
    name: 'bank',
    help: 'Open your personal bank box.',
    access: 'Player',
    run: (ctx) => {
      const state = ctx.state;
      if (!state?.mobile) return;
      // Audit #40 P3 #17 — ServUO has no `[bank` shortcut; bank access
      // only works near a Banker NPC. Without the proximity + criminal
      // gates the slash command bypassed every check the speech path
      // (audit #33) enforces, including the "criminals cannot bank"
      // rule. GM/Admin keep the unrestricted bypass.
      const mob = state.mobile;
      const staff = !mob.client?.account
                 || mob.client.account.accessLevel === 'GM'
                 || mob.client.account.accessLevel === 'Admin';
      if (!staff) {
        if ((mob.criminalUntil ?? 0) > Date.now()) {
          state.sendSystemMessage?.('Thou\'rt a criminal and cannot bank.');
          return;
        }
        // Audit #42 P3 #39 — ServUO bankers respond within ~10 tiles.
        const nearBanker = !!findMobileNear(
          mob,
          (other) => [other.kind, other.role, other.npcRole, other.vendorKind,
            other.behavior, other.aiBehavior]
            .some((value) => String(value ?? '').toLowerCase() === 'banker'),
          10,
          mob,
        );
        if (!nearBanker) {
          state.sendSystemMessage?.('You must be near a banker to use the bank.');
          return;
        }
      }
      if (!api.ctx.bankBoxes) api.ctx.bankBoxes = new Map();
      let serial = api.ctx.bankBoxes.get(state.mobile.serial);
      let box = serial ? itemBySerial({ world }, serial) : null;
      if (!box) {
        box = createItem(api, world, {
          itemId: 0x09AB,   // metal chest graphic
          hue: 0x0032,
          x: 0, y: 0, z: 0, map: state.mobile.map,
          name: `${state.mobile.name}'s bank box`,
          parent: state.mobile.serial, // held "on" the mobile (paperdoll layer)
          // @ts-expect-error — layer added in wave D
          layer: 0x1D,
          gumpId: 0x004A,    // canonical bank-box art
        });
        api.ctx.bankBoxes.set(state.mobile.serial, box.serial);
      }
      // Open it.
      // Migrate boxes created by the old command and keep the real contents.
      // Sending [] made a non-empty account look empty until another delta.
      if ((box.gumpId | 0) === 0x003C) box.gumpId = 0x004A;
      const entries = [];
      for (const it of allItems({ world })) {
        if ((it.parent >>> 0) !== (box.serial >>> 0)) continue;
        entries.push({
          serial: it.serial, itemId: it.itemId, amount: it.amount ?? 1,
          gridX: it.gridX ?? 0, gridY: it.gridY ?? 0,
          gridLocation: it.gridLocation ?? 0, hue: it.hue ?? 0,
        });
      }
      state.send(protocol.displayContainer(box.serial, box.gumpId));
      state.send(protocol.containerContents(box.serial, entries));
      state.openContainers?.add?.(box.serial);
      // Phase H.1.4 — also push the BankerGump sentinel with the live
      // balance so the client overlay shows the bank's gold total and
      // exposes the check-writer button.
      let balance = 0;
      const GOLD_PILE_ID = 0x0EED;
      const children = api.game?.inventory?.childrenOf?.(box) ?? allItems({ world });
      for (const it of children) {
        if ((it.parent >>> 0) !== (box.serial >>> 0)) continue;
        if ((it.itemId | 0) !== GOLD_PILE_ID) continue;
        balance += (it.amount | 0);
      }
      state.sendSystemMessage?.(`@@OPEN_BANKER_GUMP@@${balance}`);
    },
  });

  return () => commands.unregister('bank');
}
