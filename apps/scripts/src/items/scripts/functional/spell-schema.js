import { itemBySerial, mobileBySerial } from '../../../_entities.js';
import { consumeOne } from '../_shared/consume.js';

function castDeps(api) {
  return {
    damage: (world, target, amount, options) => api.combat?.damage?.(world, target, amount, options),
    statusEffects: api.statusEffects,
    animate: (world, mobile, action, options) => api.combat?.animate?.(world, mobile, action, options),
    playSoundNear: (world, mobile, sound) => api.combat?.playSoundNear?.(world, mobile, sound),
    broadcastSpellWords: () => {},
  };
}

const CODEX_ART_ID = 0x0FF0;

function normalizeCodexArt(api, item, user = null) {
  if (!item || (item.artId | 0) === CODEX_ART_ID) return;
  item.artId = CODEX_ART_ID;
  item.itemId = CODEX_ART_ID;
  if (user?.client && item.parent != null && api.protocol?.containerContentUpdate) {
    user.client.send(api.protocol.containerContentUpdate(item, item.parent));
  }
}

export function buildSpellSchemaCodexScript(api) {
  return {
    name: 'spell-schema-codex',
    onCreate(_world, item) {
      normalizeCodexArt(api, item);
    },
    onUse(_world, item, user) {
      if (!user?.client) return true;
      // Identity-owned migration for Codices created before they received a
      // dedicated graphic. This deliberately checks the script/definition
      // path, never the old 0x0EFA artwork shared with Magery spellbooks.
      normalizeCodexArt(api, item, user);
      if (!api.game?.inventory?.isInPack?.(item, user)) {
        user.client.sendSystemMessage?.('Place the Arcane Schema Codex in your backpack first.');
        return true;
      }
      if (!api.spellComposer?.open?.(user.client, { sourceSerial: item.serial })) {
        if (user.client.notifyNodeUORequirement) {
          user.client.notifyNodeUORequirement('spell.composer', {
            label: 'The visual spell-schema editor',
            fallback: 'Standard spellbooks and spell casting remain available.',
          });
        } else {
          user.client.sendSystemMessage?.(
            'The spell-schema editor requires the NodeUO client. Standard spellbooks remain available.',
          );
        }
      }
      return true;
    },
  };
}

export function buildCustomSpellScrollScript(api) {
  return {
    name: 'custom-spell-scroll',
    onUse(world, item, user) {
      if (!user?.client || !api.game?.inventory?.isInPack?.(item, user)) {
        user?.client?.sendSystemMessage?.('Place the schema scroll in your backpack first.');
        return true;
      }
      const draft = api.spellComposer?.getPublished?.(item.customSpellId);
      const spell = draft && api.systems?.spells?.getSpell?.(draft.spellId);
      if (!draft || !spell) {
        user.client.sendSystemMessage?.('The schema on this scroll is no longer available.');
        return true;
      }
      const profile = api.spellComposer?.profile?.(user);
      if (profile && !profile.admin && profile.level < (draft.requiredRank ?? 1)) {
        user.client.sendSystemMessage?.(
          `This schema requires spellcraft rank ${draft.requiredRank}; you are ${profile.rank}.`,
        );
        return true;
      }

      const invoke = (target) => {
        const access = user.client.account?.accessLevel;
        const isAdmin = access === 'Admin' || access === 'Administrator';
        const now = Date.now();
        if (!isAdmin && (user._castReadyAt ?? 0) > now) {
          user.client.sendSystemMessage?.('You must wait before invoking another schema.');
          return;
        }
        const result = api.systems.spells.castSpell({
          caster: user, spellId: draft.spellId, world, target,
          scroll: true, instant: true, deps: castDeps(api),
          accessLevel: access,
        });
        if (!result?.ok) {
          const messages = {
            'low-skill': 'You do not have the skill to read this schema.',
            'out-of-range': 'That target is too far away.',
            'no-los': 'That target cannot be seen.',
            'region-blocks-spell': 'This schema cannot be invoked here.',
            'spellcraft-rank': 'Your spellcraft rank is too low to invoke this schema.',
          };
          user.client.sendSystemMessage?.(messages[result?.reason] ?? 'The schema refuses to activate.');
          return;
        }
        if (!isAdmin) user._castReadyAt = now + Math.max(250, draft.cooldownMs | 0);
        consumeOne(api, world, item, user);
      };

      if (!spell.requiresTarget) {
        invoke(user);
        return true;
      }
      if (!api.targeting?.request) {
        user.client.sendSystemMessage?.('Targeting is currently unavailable.');
        return true;
      }
      user.client.sendSystemMessage?.('Select a target for the schema spell.');
      api.targeting.request(user.client, (picked) => {
        if (!picked || !itemBySerial(api, item.serial)) return;
        if (spell.targetKind === 'location') invoke(picked);
        else {
          const target = mobileBySerial(api, picked.serial >>> 0);
          if (target) invoke(target);
          else user.client.sendSystemMessage?.('That is not a valid mobile target.');
        }
      }, { kind: spell.targetKind === 'location' ? 1 : 0 });
      return true;
    },
  };
}

export function buildSpellcraftKnowledgeScript(api) {
  return {
    name: 'spellcraft-knowledge',
    onUse(world, item, user) {
      if (!user?.client || !api.game?.inventory?.isInPack?.(item, user)) {
        user?.client?.sendSystemMessage?.('Place the arcane knowledge in your backpack first.');
        return true;
      }
      const before = api.spellComposer?.profile?.(user);
      if (!before || before.admin) {
        user.client.sendSystemMessage?.(before?.admin
          ? 'Administrators already understand every spellcraft schema.'
          : 'Arcane research is currently unavailable.');
        return true;
      }
      const result = api.spellComposer.learn(
        user, item.spellcraftUnlock ?? null, item.spellcraftXp ?? 0,
      );
      if (!result?.ok) {
        user.client.sendSystemMessage?.('There is nothing new to learn from this fragment.');
        return true;
      }
      consumeOne(api, world, item, user);
      const discovery = result.discovered ? ' You discovered a new spellcraft block.' : '';
      const rank = result.leveledUp ? ` Your rank advances to ${result.profile.rank}.` : '';
      user.client.sendSystemMessage?.(
        `You gain ${result.xpGained} arcane research.${discovery}${rank}`,
      );
      return true;
    },
  };
}
