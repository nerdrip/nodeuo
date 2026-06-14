import { allMobiles } from '../../_spatial.js';
import { itemBySerial, mobileBySerial } from '../../_entities.js';
// `[itemgump` — GM item-property editor with a gump.
//
// Mirrors the experience of ServUO `[props` plus our `[set` whitelist:
// target an item (or mobile) and open a gump with editable fields.
// Apply commits the changes and broadcasts visual refresh; Cancel
// closes without saving. Stays in-sync with the chat `[set` command's
// allowed-fields whitelist so the surface stays safe.

const ALLOWED_FIELDS = [
  // Identity / visual
  { key: 'name',     label: 'Name',         kind: 'string' },
  { key: 'hue',      label: 'Hue',          kind: 'hex'    },
  { key: 'itemId',   label: 'Item id',      kind: 'hex'    },
  { key: 'amount',   label: 'Amount',       kind: 'int'    },
  // Flags
  { key: 'movable',  label: 'Movable',      kind: 'bool'   },
  { key: 'newbied',  label: 'Newbied',      kind: 'bool'   },
  { key: 'blessed',  label: 'Blessed',      kind: 'bool'   },
  { key: 'locked',   label: 'Locked',       kind: 'bool'   },
  // Combat / craft
  { key: 'durability',     label: 'Durability',     kind: 'int' },
  { key: 'durabilityMax',  label: 'Dur. max',       kind: 'int' },
  { key: 'weight',         label: 'Weight',         kind: 'int' },
  { key: 'slayer',         label: 'Slayer',         kind: 'string' },
  // Position (read-only display unless GM wants to teleport item)
  { key: 'x',        label: 'X',            kind: 'int' },
  { key: 'y',        label: 'Y',            kind: 'int' },
  { key: 'z',        label: 'Z',            kind: 'int' },
];

const MOBILE_FIELDS = [
  { key: 'name',     label: 'Name',         kind: 'string' },
  { key: 'hue',      label: 'Hue',          kind: 'hex'    },
  { key: 'body',     label: 'Body',         kind: 'hex'    },
  { key: 'hp',       label: 'HP',           kind: 'int'    },
  { key: 'hpMax',    label: 'HP max',       kind: 'int'    },
  { key: 'mana',     label: 'Mana',         kind: 'int'    },
  { key: 'manaMax',  label: 'Mana max',     kind: 'int'    },
  { key: 'stam',     label: 'Stam',         kind: 'int'    },
  { key: 'stamMax',  label: 'Stam max',     kind: 'int'    },
  { key: 'str',      label: 'Str',          kind: 'int'    },
  { key: 'dex',      label: 'Dex',          kind: 'int'    },
  { key: 'int',      label: 'Int',          kind: 'int'    },
  { key: 'gold',     label: 'Gold',         kind: 'int'    },
  { key: 'karma',    label: 'Karma',        kind: 'int'    },
  { key: 'fame',     label: 'Fame',         kind: 'int'    },
  { key: 'frozen',   label: 'Frozen',       kind: 'bool'   },
  { key: 'hidden',   label: 'Hidden',       kind: 'bool'   },
  { key: 'invulnerable', label: 'Invul',    kind: 'bool'   },
];

const VISUAL_ITEM_FIELDS = new Set(['hue', 'itemId', 'amount', 'movable']);
const VISUAL_MOB_FIELDS  = new Set(['hue', 'body', 'direction', 'hidden']);

function fmtValue(v, kind) {
  if (v === undefined || v === null) return '';
  if (kind === 'bool') return v ? 'true' : 'false';
  if (kind === 'hex' && typeof v === 'number') return '0x' + (v >>> 0).toString(16);
  return String(v);
}

function parseValue(raw, kind) {
  const t = String(raw ?? '').trim();
  if (t === '') return null;
  if (kind === 'bool') return /^(true|1|yes|on)$/i.test(t);
  if (kind === 'hex') return /^0x/i.test(t) ? parseInt(t.slice(2), 16) : parseInt(t, 16);
  if (kind === 'int') return parseInt(t, 10);
  return t;
}

function buildLayout(entity, fields) {
  const isItem = entity.itemId != null;
  const header = `${isItem ? 'Item' : 'Mobile'} 0x${entity.serial.toString(16)}`;
  const lines = [];
  lines.push('{ resizepic 0 0 5054 520 ' + (80 + fields.length * 26 + 40) + ' }');
  lines.push('{ text 16 12 1153 0 }');                  // header
  lines.push('{ text 16 36 70 1 }');                    // hint
  // textEntries: id 0..fields.length-1
  const texts = [header, 'Edit fields below — Apply commits.'];
  fields.forEach((f, i) => {
    const y = 70 + i * 26;
    texts.push(f.label + ':');
    const labelIdx = texts.length - 1;
    lines.push(`{ text 16 ${y + 2} 1153 ${labelIdx} }`);
    texts.push(fmtValue(entity[f.key], f.kind));
    const valIdx = texts.length - 1;
    lines.push(`{ textentry 130 ${y} 280 22 70 ${i} ${valIdx} }`);
    // "Pick" button on the hue row — opens the client's color picker.
    // buttonId = 100 + i so we can route back to the correct field.
    if (f.key === 'hue') {
      lines.push(`{ button 420 ${y} 4023 4024 1 0 ${100 + i} }`);
      texts.push('Pick');
      lines.push(`{ text 446 ${y + 2} 70 ${texts.length - 1} }`);
    }
  });
  const btnY = 80 + fields.length * 26;
  lines.push(`{ button 16  ${btnY} 4023 4024 1 0 1 }`);  // Apply, buttonId=1
  lines.push(`{ text   46  ${btnY} 70 ${texts.push('Apply') - 1} }`);
  lines.push(`{ button 130 ${btnY} 4017 4018 1 0 2 }`);  // Cancel, buttonId=2
  lines.push(`{ text   160 ${btnY} 70 ${texts.push('Cancel') - 1} }`);
  return { layout: lines.join(''), texts };
}

// Outbound 0x95 DyeData — opens the client's color-picker-gump for
// the given dye-tub graphic. We use the gump-dialog serial as the
// "item" handle so the inbound 0x95 response routes back through
// `ctx._huePickers[dialogId]`. Standard cloth-dye-tub itemId is 0x0FAB.
function sendHuePicker(api, state, dialogId, graphic, callback) {
  const ctx = state.ctx ?? api.ctx;
  if (!ctx) return false;
  if (!ctx._huePickers) ctx._huePickers = new Map();
  ctx._huePickers.set(dialogId, {
    serial: state.mobile?.serial >>> 0,
    callback,
    expiresAt: Date.now() + 60_000,
  });
  // Build 0x95 outbound: op + u32 dialogId + u16 pad + u16 graphic = 9 bytes.
  const buf = new Uint8Array(9);
  buf[0] = 0x95;
  buf[1] = (dialogId >>> 24) & 0xff;
  buf[2] = (dialogId >>> 16) & 0xff;
  buf[3] = (dialogId >>>  8) & 0xff;
  buf[4] =  dialogId         & 0xff;
  buf[5] = 0; buf[6] = 0;                  // padding
  buf[7] = (graphic >>> 8) & 0xff;
  buf[8] =  graphic        & 0xff;
  try { state.send?.(buf); return true; }
  catch { return false; }
}

/** Walk the parent chain of an item until we hit a Mobile. Returns the
 *  owning mobile (`mobileBySerial({ world }, ...)`) or null if the chain dead-
 *  ends at another item / itself. Bounded to 8 hops to avoid pathological
 *  loops from corrupted saves. Needed because items nested in bags (item
 *  → bag → backpack → mob) report `parent` as the immediate container
 *  serial, NOT the wearer's serial. `mobileBySerial({ world }, parent)` then
 *  returns null and the broadcast silently no-ops — which is why the
 *  user saw "no command changes item color" for anything in a pack. */
function findOwnerMobile(world, item) {
  let cur = item;
  for (let i = 0; i < 8; i++) {
    const p = cur?.parent;
    if (p == null) return null;
    const mob = mobileBySerial({ world }, p >>> 0);
    if (mob) return mob;
    const next = itemBySerial({ world }, p >>> 0);
    if (!next || next === cur) return null;
    cur = next;
  }
  return null;
}

function broadcastEntityRefresh(api, ent, fields, state = null) {
  const world = api.world;
  if (!world || !api.protocol) return;
  const isItem  = ent.itemId  != null;
  const isMob   = ent.body    != null && !isItem;
  // The NetState IS the "client" handle — it owns `.send(pkt)` and is
  // what `mob.client` references back to. There is no `state.client`
  // field (an earlier draft of this helper assumed there was, which made
  // the gm-echo branch a no-op — Marcin: "still nic"). Use the state
  // directly so the GM running [itemgump always sees their own change.
  const gmClient = state && typeof state.send === 'function' ? state : null;
  for (const f of fields) {
    if (isItem && VISUAL_ITEM_FIELDS.has(f.key)) {
      // Three placement modes — ground / worn / contained — each needs
      // a different wire packet for the client to actually repaint:
      //   ground  (parent == null)        → 0xF3 worldItemSA
      //   worn    (parent == mob, layer>0)→ 0x2E equipUpdate
      //   in pack (parent walks to mob)   → 0x25 containerContentUpdate
      const isWorn      = ent.parent != null
        && mobileBySerial({ world }, ent.parent >>> 0)
        && (ent.layer | 0) > 0;
      const owner       = ent.parent != null ? findOwnerMobile(world, ent) : null;

      if (isWorn && api.protocol.equipUpdate) {
        const wearer = mobileBySerial({ world }, ent.parent >>> 0);
        const pkt = api.protocol.equipUpdate({
          serial: ent.serial, itemId: ent.itemId,
          layer: ent.layer | 0, parent: wearer.serial,
          hue: ent.hue ?? 0,
        });
        for (const m of allMobiles({ world })) {
          if (!m.client || m.map !== wearer.map) continue;
          if (Math.abs((m.x | 0) - (wearer.x | 0)) > 18) continue;
          if (Math.abs((m.y | 0) - (wearer.y | 0)) > 18) continue;
          m.client.send(pkt);
        }
        continue;
      }

      if (ent.parent != null) {
        // Item is parented somewhere — either a container or a mobile
        // (worn but no equipUpdate available, defensive fallback). Push
        // a containerContentUpdate so the open container gump on the
        // owning player's client refreshes. Walk the chain to find the
        // wearer so the packet reaches them even for nested bags.
        if (api.protocol.containerContentUpdate) {
          const upd = api.protocol.containerContentUpdate(ent, ent.parent);
          if (owner?.client) owner.client.send(upd);
          // Also echo to the GM if they're not the owner — Marcin's
          // bug repro: `[itemgump` on an item in another player's pack
          // (or on a snooped container) committed the hue change on
          // the server side but the GM's open snoop gump never saw a
          // 0x25 because only `owner.client` got the packet. Now the
          // GM running the command sees the update they just applied.
          if (gmClient && gmClient !== owner?.client) gmClient.send(upd);
        }
        // Also update the parent gump's world-item record so any GM
        // who opens the bag later (without re-entering [itemgump) gets
        // the right hue without needing a [resync. Ground items handle
        // this via 0xF3 below — contained items need the explicit poke
        // because their world.items entry only mirrors what 0x25 carries.
        continue;
      }

      // Ground item — broadcast to nearby viewers.
      if (!api.protocol.worldItemSA) continue;
      const pkt = api.protocol.worldItemSA({
        serial: ent.serial, itemId: ent.itemId, hue: ent.hue ?? 0,
        amount: ent.amount ?? 1,
        x: ent.x | 0, y: ent.y | 0, z: ent.z | 0,
        flags: (ent.movable ?? true) ? 0x20 : 0x00,
      });
      for (const m of allMobiles({ world })) {
        if (!m.client || m.map !== ent.map) continue;
        if (Math.abs((m.x | 0) - (ent.x | 0)) > 18) continue;
        if (Math.abs((m.y | 0) - (ent.y | 0)) > 18) continue;
        m.client.send(pkt);
      }
    } else if (isMob && VISUAL_MOB_FIELDS.has(f.key) && api.protocol.mobileUpdate) {
      const pkt = api.protocol.mobileUpdate({
        serial: ent.serial, body: ent.body, hue: ent.hue ?? 0,
        flags: ent.flags ?? 0,
        x: ent.x | 0, y: ent.y | 0, z: ent.z | 0,
        direction: ent.direction ?? 0,
      });
      for (const m of allMobiles({ world })) {
        if (!m.client || m.map !== ent.map) continue;
        if (Math.abs((m.x | 0) - (ent.x | 0)) > 18) continue;
        if (Math.abs((m.y | 0) - (ent.y | 0)) > 18) continue;
        m.client.send(pkt);
      }
    }
  }
}

// Apply typed-text edits from a gump response onto the entity. Returns
// the list of fields that actually changed (so broadcastEntityRefresh
// can skip no-ops). Shared by the Apply path and the Pick-hue-then-
// reopen path so a user's mid-edit typing isn't lost when they click
// "Pick" to swap the hue.
function applyResponseEdits(api, ent, fields, resp, state = null) {
  const dirty = [];
  for (const entry of resp.textEntries ?? []) {
    const f = fields[entry.entryId | 0];
    if (!f) continue;
    const parsed = parseValue(entry.text, f.kind);
    if (parsed === null) continue;
    const before = ent[f.key];
    const same = before === parsed
      || (typeof before === 'number' && typeof parsed === 'number' && before === parsed)
      || (typeof before === 'boolean' && before === !!parsed)
      || String(before ?? '') === String(parsed);
    if (same) continue;
    ent[f.key] = parsed;
    dirty.push(f);
  }
  if (dirty.length) broadcastEntityRefresh(api, ent, dirty, state);
  return dirty;
}

function openEditor(api, state, ent) {
  const fields = ent.body != null && ent.itemId == null ? MOBILE_FIELDS : ALLOWED_FIELDS;
  const { layout, texts } = buildLayout(ent, fields);
  api.gumps.send(state, { layout, texts, x: 100, y: 80 }, (resp) => {
    const btn = resp.buttonId | 0;
    // Pick buttons live at buttonId 100 + fieldIdx. Open the client's
    // color picker for that field and re-open the editor with the
    // chosen hue pre-applied.
    if (btn >= 100 && btn < 200) {
      const fieldIdx = btn - 100;
      const f = fields[fieldIdx];
      if (!f || f.key !== 'hue') return;
      // First commit any other field edits the user typed before
      // pressing Pick, so they don't lose them when the editor reopens.
      applyResponseEdits(api, ent, fields, resp, state);
      const dialogId = (Date.now() & 0xffffffff) ^ (ent.serial | 0);
      const opened = sendHuePicker(api, state, dialogId, ent.itemId | 0x0FAB, (hue) => {
        ent.hue = hue & 0x3FFF;
        broadcastEntityRefresh(api, ent, [f], state);
        state.sendSystemMessage?.(`Hue set to 0x${ent.hue.toString(16)}.`);
        // Reopen so user can keep editing other fields.
        openEditor(api, state, ent);
      });
      if (!opened) state.sendSystemMessage?.('Color picker unavailable on this client.');
      return;
    }
    if (btn !== 1) return;             // Cancel / close
    // Reuse the shared edit helper so hue-pick + Apply paths stay
    // consistent. Returns the list of fields actually written.
    const dirtyFields = applyResponseEdits(api, ent, fields, resp, state);
    if (dirtyFields.length > 0) {
      state.sendSystemMessage(`Updated ${dirtyFields.length} field${dirtyFields.length === 1 ? '' : 's'}.`);
    }
    // No "No changes" message — was confusing for users who applied
    // a hue via the picker (already committed mid-session) and then
    // hit Apply with nothing else changed. Silence is the success path.
  });
}

export default function register(api) {
  if (!api.commands || !api.targeting || !api.gumps) return () => {};

  api.commands.register({
    name: 'itemgump',
    help: '[itemgump — target an item or mobile to open the property editor.',
    access: 'GM',
    run(ctx) {
      const state = ctx.state;
      state.sendSystemMessage('Target an item or mobile to edit.');
      api.targeting.request(state, (picked) => {
        if (!picked?.serial) {
          state.sendSystemMessage('Cancelled.');
          return;
        }
        const s = picked.serial >>> 0;
        const ent = mobileBySerial(api, s) ?? itemBySerial(api, s);
        if (!ent) {
          state.sendSystemMessage('Bad target.');
          return;
        }
        openEditor(api, state, ent);
      }, { kind: 0 });
    },
  });

  return () => api.commands.unregister('itemgump');
}
