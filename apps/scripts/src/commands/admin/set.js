import { allMobiles } from '../../_spatial.js';
import { itemBySerial, mobileBySerial } from '../../_entities.js';
// FAZA HF — `[set <field> <value>` GM property editor.
//
// ServUO `Scripts/Commands/Properties.cs` is the swiss-army GM tool:
// target an entity, type `[set Hits 9999`, watch the mob become
// invincible. We restrict the editable surface to a vetted whitelist
// so a typo can't replace `world.mobiles` with the string "true".

const ALLOWED_FIELDS = new Set([
  // Numeric stats
  'hp', 'hpMax', 'mana', 'manaMax', 'stam', 'stamMax',
  'str', 'dex', 'int', 'gold', 'karma', 'fame',
  // Identity
  'name', 'body', 'hue',
  // Flags
  'invulnerable', 'paragon', 'frozen', 'hidden', 'newbied', 'insured',
  // Item-specific
  'amount', 'itemId', 'movable', 'locked', 'lockDifficulty', 'durability', 'durabilityMax',
  'weight', 'slayer', 'magicSpell', 'magicCharges',
  // Decoration / decay opt-outs
  //   `isDecoration` — placed by `[createworld`; persistence skips, decay
  //                    skips. Set true to make a hand-spawned item permanent
  //                    AND keep the world.json save tiny.
  //   `_noDecay`     — keep a movable ground item even though it WOULD be
  //                    eligible for decay. Quest rewards / GM marks / event
  //                    drops live here.
  'isDecoration', '_noDecay',
  // Orientation
  //   `direction`    — mobile facing (0..7).
  //   `decoFacing`   — informational facing string on a decoration item
  //                    ('south' / 'east' / 'north' / 'west'). For doors,
  //                    use `[doorface` instead — it auto-swaps the
  //                    closed/open art ids and broadcasts the visual.
  'direction', 'decoFacing',
  // Pet
  'controlMaster', 'team', 'tameable', 'bonded',
  // Position (use `[go` for self)
  'x', 'y', 'z', 'map',
]);

function coerceValue(field, raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  // Hex / decimal / float.
  const n = parseInt(raw, 0);
  if (Number.isFinite(n) && /^-?\d+|^0x/.test(raw)) return n;
  const f = parseFloat(raw);
  if (Number.isFinite(f) && /^-?\d/.test(raw)) return f;
  return raw; // string
}

export default function register(api) {
  if (!api.commands || !api.targeting) return () => {};

  api.commands.register({
    name: 'set',
    help: '[set <field> <value> — target an entity to set a property.',
    access: 'GM',
    run(ctx) {
      const field = ctx.args[0];
      const raw = ctx.args.slice(1).join(' ');
      if (!field || !raw) {
        ctx.state.sendSystemMessage('Usage: [set <field> <value> [target]');
        return;
      }
      if (!ALLOWED_FIELDS.has(field)) {
        ctx.state.sendSystemMessage(
          `Field "${field}" not in the editable whitelist. Available: ${[...ALLOWED_FIELDS].join(', ')}.`,
        );
        return;
      }
      const value = coerceValue(field, raw);
      ctx.state.sendSystemMessage(`Set ${field} on what?`);
      api.targeting.request(ctx.state, (picked) => {
        if (!picked?.serial) return;
        const ent = mobileBySerial(api, picked.serial >>> 0)
                 ?? itemBySerial(api, picked.serial >>> 0);
        if (!ent) {
          ctx.state.sendSystemMessage('Bad target.');
          return;
        }
        const before = ent[field];
        ent[field] = value;
        ctx.state.sendSystemMessage(
          `Set ${ent.name ?? '?'}.${field}: ${before} → ${value}.`,
        );
        api.log?.(`[set] ${ctx.sender.name}: ${ent.serial.toString(16)}.${field} = ${JSON.stringify(value)}`);
        // Broadcast a visible change so observers don't have to relog.
        // Only fires for fields that affect what clients see / can do
        // (hue, itemId, amount, movable, body, hidden). Pure runtime
        // flags like `_noDecay` skip this path entirely.
        broadcastEntityRefresh(api, ent, field);
      }, { kind: 0 });
    },
  });

  return () => api.commands.unregister('set');
}

/** Visual fields that need a wire frame after `[set` mutates them.
 *  Matches the semantics of the per-edit broadcasts in `[edititem`. */
const VISUAL_ITEM_FIELDS = new Set(['hue', 'itemId', 'amount', 'movable']);
const VISUAL_MOBILE_FIELDS = new Set(['hue', 'body', 'direction', 'hidden']);

/** Walk the parent chain of an item to its owning Mobile. Bounded
 *  to 8 hops. Needed because items nested in bags (item → bag →
 *  backpack → mob) carry only the immediate-container serial as
 *  `parent`, so `mobileBySerial({ world }, parent)` returns null and the
 *  refresh broadcast silently drops the wearer's repaint signal. */
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

function broadcastEntityRefresh(api, ent, field) {
  const isItem  = ent.itemId  != null;
  const isMob   = ent.body    != null && !isItem;
  const world   = api.world;
  if (!world || !api.protocol) return;
  if (isItem && VISUAL_ITEM_FIELDS.has(field)) {
    if (ent.parent != null) {
      // Three placement modes:
      //   worn (parent == mob && layer > 0) → 0x2E equipUpdate
      //   in pack (parent chain ends at mob)→ 0x25 containerContentUpdate
      //   detached parent (corruption)      → drop
      const directMob = mobileBySerial({ world }, ent.parent >>> 0);
      const isWorn = directMob && (ent.layer | 0) > 0;
      if (isWorn && api.protocol.equipUpdate) {
        const pkt = api.protocol.equipUpdate({
          serial: ent.serial, itemId: ent.itemId,
          layer: ent.layer | 0, parent: directMob.serial,
          hue: ent.hue ?? 0,
        });
        for (const m of allMobiles({ world })) {
          if (!m.client || m.map !== directMob.map) continue;
          if (Math.abs((m.x | 0) - (directMob.x | 0)) > 18) continue;
          if (Math.abs((m.y | 0) - (directMob.y | 0)) > 18) continue;
          m.client.send(pkt);
        }
        return;
      }
      const owner = findOwnerMobile(world, ent);
      if (owner?.client && api.protocol.containerContentUpdate) {
        owner.client.send(api.protocol.containerContentUpdate(ent, ent.parent));
      }
      return;
    }
    if (!api.protocol.worldItemSA) return;
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
    return;
  }
  if (isMob && VISUAL_MOBILE_FIELDS.has(field)) {
    if (!api.protocol.mobileUpdate) return;
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

export const _SET_ALLOWED_FIELDS_FOR_TEST = ALLOWED_FIELDS;
