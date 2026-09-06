import { itemBySerial, mobileBySerial } from '../../../_entities.js';
import { destroyItemBySerial } from '../../../_items.js';
import { allMobiles } from '../../../_spatial.js';
import { consumeOne } from '../_shared/consume.js';

function castDeps(api) {
  return {
    damage: (world, target, amount, options) => api.combat?.damage?.(world, target, amount, options),
    statusEffects: api.statusEffects,
    animate: (world, mobile, action, options) => api.combat?.animate?.(world, mobile, action, options),
    playSoundNear: (world, mobile, sound) => api.combat?.playSoundNear?.(world, mobile, sound),
    broadcastSpellWords: () => {},
    gameHour: () => api.dayNight?.hourOfDay?.(),
  };
}

const CODEX_ART_ID = 0x0FF0;

function accountOf(user) {
  return String(user?.accountName ?? user?.client?.accountName
    ?? user?.client?.account?.username ?? '').trim().toLowerCase();
}

function discoveryMessage(user, result) {
  const discovery = result.discovered ? ' You discovered a new spellcraft block.' : '';
  const rank = result.leveledUp ? ` Your rank advances to ${result.profile.rank}.` : '';
  user?.client?.sendSystemMessage?.(
    `You gain ${result.xpGained} arcane research.${discovery}${rank}`,
  );
}

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
      item.newbied = true;
      item.blessed = true;
      item.accountBound = true;
    },
    onUse(_world, item, user) {
      if (!user?.client) return true;
      // Identity-owned migration for Codices created before they received a
      // dedicated graphic. This deliberately checks the script/definition
      // path, never the old 0x0EFA artwork shared with Magery spellbooks.
      normalizeCodexArt(api, item, user);
      const account = accountOf(user);
      if (item.boundAccount && account && item.boundAccount !== account) {
        user.client.sendSystemMessage?.('This Arcane Schema Codex is bound to another account.');
        return true;
      }
      if (account && !item.boundAccount) item.boundAccount = account;
      item.newbied = true;
      item.blessed = true;
      item.accountBound = true;
      // The Codex is the durable library. Rehydrate discoveries onto the
      // character before opening so a restored/migrated Codex retains every
      // physical block previously inserted into it.
      for (const discovery of item.schemaDiscoveries ?? []) {
        api.spellComposer?.learn?.(user, discovery, 0);
      }
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
    onDrop(world, item, dropped, user) {
      if (!dropped?.spellcraftUnlock || dropped.category !== 'spellcraft-knowledge') {
        user?.client?.sendSystemMessage?.('Only an Arcane Schema block can be stored in this Codex.');
        return { handled: true, consumeHeld: false };
      }
      const account = accountOf(user);
      if (item.boundAccount && account && item.boundAccount !== account) {
        user?.client?.sendSystemMessage?.('This Arcane Schema Codex is bound to another account.');
        return { handled: true, consumeHeld: false };
      }
      if (account && !item.boundAccount) item.boundAccount = account;
      const before = api.spellComposer?.profile?.(user);
      if (!before || before.admin) {
        user?.client?.sendSystemMessage?.(before?.admin
          ? 'Administrators already understand every spellcraft schema.'
          : 'Arcane research is currently unavailable.');
        return { handled: true, consumeHeld: false };
      }
      const result = api.spellComposer.learn(
        user, dropped.spellcraftUnlock, dropped.spellcraftXp ?? 0,
      );
      if (!result?.ok) {
        user?.client?.sendSystemMessage?.('That block is already recorded in this Codex.');
        return { handled: true, consumeHeld: false };
      }
      item.schemaDiscoveries = [...new Set([
        ...(Array.isArray(item.schemaDiscoveries) ? item.schemaDiscoveries : []),
        dropped.spellcraftUnlock,
      ])];
      destroyItemBySerial({ ...api, world }, dropped.serial);
      discoveryMessage(user, result);
      return true;
    },
  };
}

const PEDESTAL_MAX_CHARGE = 1_000_000;
const PEDESTAL_TARGET_RANGE = 12;

function pedestalOwner(world, item) {
  const ownerAccount = String(item.schemaOwnerAccount ?? '').toLowerCase();
  if (!ownerAccount) return null;
  return [...allMobiles({ world })].find((mobile) => (
    accountOf(mobile) === ownerAccount
      || accountOf({ client: mobile.client }) === ownerAccount
  )) ?? null;
}

export function buildSpellSchemaPedestalScript(api) {
  return {
    name: 'spell-schema-pedestal',
    hasTick: true,
    onCreate(_world, item) {
      item.schemaCharge ??= 0;
      item.schemaActive ??= false;
    },
    onDrop(world, item, dropped, user) {
      const account = accountOf(user);
      if (item.schemaOwnerAccount && account && item.schemaOwnerAccount !== account) {
        user?.client?.sendSystemMessage?.('This Arcane Schema Pedestal answers to another account.');
        return { handled: true, consumeHeld: false };
      }
      if (account && !item.schemaOwnerAccount) item.schemaOwnerAccount = account;

      if (dropped?.customSpellId || dropped?.script === 'custom-spell-scroll') {
        const draft = api.spellComposer?.getPublished?.(dropped.customSpellId);
        if (!draft) {
          user?.client?.sendSystemMessage?.('That scroll does not contain a published schema.');
          return { handled: true, consumeHeld: false };
        }
        item.schemaSpellId = draft.spellId;
        item.schemaSpellName = draft.name;
        item.schemaTargetSerial = 0;
        item.schemaActive = false;
        item.schemaNextRunAt = 0;
        destroyItemBySerial({ ...api, world }, dropped.serial);
        user?.client?.sendSystemMessage?.(
          `${draft.name} is installed. Double-click the pedestal to choose its target.`,
        );
        return true;
      }

      const ruby = dropped?.definitionId === 'ruby' || (dropped?.itemId | 0) === 4217;
      if (ruby) {
        if ((item.schemaCharge ?? 0) >= PEDESTAL_MAX_CHARGE) {
          user?.client?.sendSystemMessage?.('The pedestal is already fully charged.');
          return { handled: true, consumeHeld: false };
        }
        const added = Math.max(1, dropped.amount | 0) * 100;
        item.schemaCharge = Math.min(PEDESTAL_MAX_CHARGE, (item.schemaCharge ?? 0) + added);
        destroyItemBySerial({ ...api, world }, dropped.serial);
        user?.client?.sendSystemMessage?.(
          `The rubies dissolve into the pedestal. Charge: ${item.schemaCharge}/${PEDESTAL_MAX_CHARGE} mana.`,
        );
        return true;
      }

      user?.client?.sendSystemMessage?.('The pedestal accepts Schema scrolls and rubies.');
      return { handled: true, consumeHeld: false };
    },
    onUse(world, item, user) {
      const account = accountOf(user);
      if (item.schemaOwnerAccount && account && item.schemaOwnerAccount !== account) {
        user?.client?.sendSystemMessage?.('This Arcane Schema Pedestal answers to another account.');
        return true;
      }
      if (account && !item.schemaOwnerAccount) item.schemaOwnerAccount = account;
      const draft = api.spellComposer?.getPublished?.(item.schemaSpellId);
      if (!draft) {
        user?.client?.sendSystemMessage?.(
          `Arcane Schema Pedestal: no program installed; charge ${item.schemaCharge ?? 0}.`,
        );
        return true;
      }
      if (item.schemaTargetSerial) {
        item.schemaActive = !item.schemaActive;
        user?.client?.sendSystemMessage?.(
          `${draft.name}: ${item.schemaActive ? 'running' : 'paused'}; charge ${item.schemaCharge ?? 0}.`,
        );
        return true;
      }
      if (!api.targeting?.request) {
        user?.client?.sendSystemMessage?.('Targeting is currently unavailable.');
        return true;
      }
      user?.client?.sendSystemMessage?.('Choose a nearby mobile or world decoration for this schema.');
      api.targeting.request(user.client, (picked) => {
        const serial = picked?.serial >>> 0;
        const target = mobileBySerial({ ...api, world }, serial) ?? itemBySerial({ ...api, world }, serial);
        if (!target || target.parent != null || target.map !== item.map
            || Math.max(Math.abs(target.x - item.x), Math.abs(target.y - item.y)) > PEDESTAL_TARGET_RANGE) {
          user.client?.sendSystemMessage?.(`Choose a world target within ${PEDESTAL_TARGET_RANGE} tiles.`);
          return;
        }
        const hasTransform = draft.graph?.nodes?.some((node) => node.type === 'transform');
        if (hasTransform && !itemBySerial({ ...api, world }, serial)) {
          user.client?.sendSystemMessage?.('A transmutation schema must target a world decoration.');
          return;
        }
        item.schemaTargetSerial = serial;
        item.schemaActive = true;
        item.schemaNextRunAt = 0;
        user.client?.sendSystemMessage?.(`${draft.name} is now running from the pedestal.`);
      }, { kind: 0 });
      return true;
    },
    onTick(world, item) {
      if (!item.schemaActive || !item.schemaSpellId) return;
      const now = Date.now();
      if ((item.schemaNextRunAt ?? 0) > now) return;
      const draft = api.spellComposer?.getPublished?.(item.schemaSpellId);
      if (!draft) { item.schemaActive = false; return; }
      const cost = Math.max(1, draft.mana | 0);
      if ((item.schemaCharge ?? 0) < cost) return;
      const caster = pedestalOwner(world, item);
      if (!caster || (caster.hp ?? 0) <= 0) return;
      const target = mobileBySerial({ ...api, world }, item.schemaTargetSerial)
        ?? itemBySerial({ ...api, world }, item.schemaTargetSerial);
      if (!target || target.parent != null) { item.schemaActive = false; return; }
      const result = api.spellComposer?.executePublished?.(draft.spellId, {
        world, caster, target, deps: castDeps(api),
        gameHour: api.dayNight?.hourOfDay?.(),
      });
      if (!result?.ok) return;
      item.schemaCharge -= cost;
      item.schemaNextRunAt = now + Math.max(1_000,
        (draft.castTimeMs | 0) + (draft.cooldownMs | 0));
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
          // A Schema scroll stores the authored program, not the energy that
          // executes it. Unlike an ordinary spell scroll it must still pay
          // the graph's mana and casting time; the rubies/reagents were the
          // separate, up-front material cost of writing the program.
          scroll: false, schemaScroll: true, instant: false, deps: castDeps(api),
          accessLevel: access,
        });
        if (!result?.ok) {
          const messages = {
            'low-skill': 'You do not have the skill to read this schema.',
            'low-mana': 'You do not have enough mana to power this schema.',
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
      discoveryMessage(user, result);
      return true;
    },
  };
}
