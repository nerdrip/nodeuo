import { destroyItemBySerial } from '../../../_items.js';
import { mobileBySerial } from '../../../_entities.js';

const SPELL_NAME_TO_ID = {
  clumsy: 1,
  feeblemind: 3,
  weaken: 8,
  heal: 4,
  'magic-arrow': 5,
  fireball: 18,
  'greater-heal': 29,
  lightning: 30,
  'mana-drain': 31,
  explosion: 43,
  flamestrike: 51,
  'flame-strike': 51,
};
const SELF_CAST_SPELLS = new Set([4, 29, 13, 14]);
// PHASE FB / FP — Magic Wand. ServUO `Items/Wands/BaseWand.cs` carries
// a stored spell + N charges. Player double-clicks the wand to cast
// the bound spell (no mana / reagent cost). Charges decrement; wand
// crumbles to dust at 0.
//
// FP: hookup actual cast via `api.commands.dispatch('cast', ...)`.
// We mark `user._wandCast = true` for one tick so cast.js skips
// mana/reagent gates.


export default function buildMagicWandScript(api) {
  function consume(world, item, user) {
    item.magicCharges = Math.max(0, (item.magicCharges | 0) - 1);
    if (item.magicCharges <= 0) {
      user?.client?.sendSystemMessage?.('The wand crumbles to dust.');
      destroyItemBySerial({ world }, item.serial);
      return true;
    }
    return false;
  }

  return {
    name: 'magic-wand',
    onUse(world, item, user) {
      item.magicCharges ??= item.defaultCharges ?? item.charges ?? 30;
      const spell = item.magicSpell;
      const spellId = item.wandSpell ?? SPELL_NAME_TO_ID[String(spell ?? '').toLowerCase()];
      const charges = item.magicCharges | 0;
      if ((!spell && !spellId && !item.wandIdentify) || charges <= 0) {
        user?.client?.sendSystemMessage?.('The wand is inert.');
        return true;
      }
      const spellSystem = api.systems?.spells;
      if (spellId && spellSystem?.castSpell) {
        const castAt = (target) => {
          try {
            spellSystem.castSpell({
              caster: user,
              spellId,
              world,
              target: target ?? user,
              scroll: true,
              instant: true,
            });
            consume(world, item, user);
          } catch (e) {
            api.log?.(`magic-wand cast failed: ${e.message}`);
            user?.client?.sendSystemMessage?.('The wand fizzles.');
          }
        };
        if (!SELF_CAST_SPELLS.has(spellId) && api.targeting?.request && user?.client) {
          user.client.sendSystemMessage?.(`Aim the ${item.name ?? 'wand'}.`);
          api.targeting.request(user.client, (picked) => {
            if (!picked) return;
            const target = picked.serial ? mobileBySerial({ world }, picked.serial >>> 0) : null;
            if (!target) {
              user.client?.sendSystemMessage?.('Invalid target.');
              return;
            }
            castAt(target);
          });
          return true;
        }
        castAt(user);
        return true;
      }
      user?.client?.sendSystemMessage?.(
        `The wand pulses with the spell of ${spell}. (${charges - 1} charges remaining)`,
      );
      // BUGFIX #122 (PHASE HH): the previous `dispatch('cast', ctx, [spell])`
      // call was off-by-one — CommandRegistry.dispatch takes a single
      // `line` string and parses tokens from it, not (name, ctx, args).
      // The third arg silently dropped, the dispatch saw the bare
      // command "cast" with no spell name, and the wand quietly fizzled
      // every time. Pass the full line as ServUO does.
      if (api?.commands?.dispatch && user) {
        user._wandCast = true;
        try {
          // Build a minimal state proxy: cast.js reads state.mobile,
          // state.sendSystemMessage, state.send, state.account.
          const state = {
            mobile: user,
            account: user._account ?? { accessLevel: 'Player' },
            sendSystemMessage: (s) => user.client?.sendSystemMessage?.(s),
            send: (b) => user.client?.send?.(b),
          };
          api.commands.dispatch(`cast ${spell}`, {
            sender: user, state, world,
          });
        } catch (e) { api.log?.(`magic-wand cast failed: ${e.message}`); }
        finally { delete user._wandCast; }
      }
      consume(world, item, user);
      return true;
    },
  };
}
