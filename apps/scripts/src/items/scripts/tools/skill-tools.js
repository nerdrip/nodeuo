// Item-scripts that bridge double-click on a skill tool to its existing
// chat command. Adds the missing onUse hook so a player can interact with
// the tool from the paperdoll/world without typing `[fish` etc. by hand.
//
// Each script just calls the matching command via api.commands.dispatch(),
// preserving every check (skill, target, cooldown) the command already
// implements. ServUO equivalents:
//   • Fishing pole  → Items/Skill Items/Harvest/FishingPole.cs
//   • Pickaxe       → Items/Skill Items/Harvest/Pickaxe.cs
//   • Shovel        → Items/Skill Items/Harvest/Shovel.cs
//   • Sextant       → Items/Skill Items/Misc/Sextant.cs
//   • Instruments   → Items/Skill Items/Musical/{Lute,Drum,…}.cs
//   • Soulstone     → Items/Consumables/SoulStone.cs

const SOULSTONE_ITEM_IDS = new Set([0x2A93, 0x2A94, 0x2AA1, 0x2AA2]);

function dispatchAs(api, user, line) {
  const dispatch = api.commands?.dispatch;
  if (typeof dispatch !== 'function') return false;
  const state = user?.client;
  if (!state) return false;
  return dispatch.call(api.commands, line, {
    sender: user, state, world: api.world, args: line.split(/\s+/).slice(1),
  });
}

export function buildFishingPoleScript(api) {
  return {
    name: 'fishing-pole',
    onUse(_w, _item, user) {
      if (!dispatchAs(api, user, 'fish')) {
        user?.client?.sendSystemMessage?.('You cannot fish here.');
      }
      return true;
    },
  };
}

export function buildPickaxeScript(api) {
  return {
    name: 'pickaxe',
    onUse(_w, _item, user) {
      if (!dispatchAs(api, user, 'mine')) {
        user?.client?.sendSystemMessage?.('You cannot mine here.');
      }
      return true;
    },
  };
}

export function buildShovelScript(api) {
  return {
    name: 'shovel',
    onUse(_w, _item, user) {
      // Treasure-map dig is gated on a marked map in pack — `[dig`
      // already validates and prompts. Fall back to mining if the
      // command is absent.
      if (!dispatchAs(api, user, 'dig') && !dispatchAs(api, user, 'mine')) {
        user?.client?.sendSystemMessage?.('Nothing to dig here.');
      }
      return true;
    },
  };
}

export function buildHatchetScript(api) {
  return {
    name: 'hatchet',
    onUse(_w, _item, user) {
      if (!dispatchAs(api, user, 'chop') && !dispatchAs(api, user, 'lumber')) {
        user?.client?.sendSystemMessage?.('You cannot harvest wood here.');
      }
      return true;
    },
  };
}

export function buildSextantScript(_api) {
  return {
    name: 'sextant',
    onUse(_w, _item, user) {
      // Render UO-style coordinates from the user's facet position.
      // The conversion mirrors ServUO Items/Misc/Sextant.cs ::Format —
      // hardcoded to Felucca/Trammel ranges for now (other facets are
      // approximate but readable). Center is (1323, 1624).
      const x = (user?.x | 0) - 1323;
      const y = (user?.y | 0) - 1624;
      const ns = y >= 0 ? 'S' : 'N';
      const ew = x >= 0 ? 'E' : 'W';
      const yLat = Math.floor(Math.abs(y) * 360 / 4096);
      const xLon = Math.floor(Math.abs(x) * 360 / 5120);
      user?.client?.sendSystemMessage?.(
        `Your current location is ${yLat}°${ns}, ${xLon}°${ew}.`,
      );
      return true;
    },
  };
}

export function buildInstrumentScript(_api) {
  return {
    name: 'instrument',
    onUse(_w, item, user) {
      // ServUO `BaseInstrument.OnDoubleClick` plays a sample sound and
      // prompts for a target if the user has Discordance / Provocation /
      // Peacemaking maxed-enough. We just play the sample and remind
      // the player which command to use — the bard skill commands
      // (`[provoke`, `[peace`, `[disco`) handle the actual targeting.
      const SOUND_BY_ITEM = {
        0x0E9C: 0x0044, 0x0E9D: 0x0045, 0x0E9E: 0x0052, 0x0E9F: 0x0053,
        0x0EB1: 0x004A, 0x0EB2: 0x004B, 0x0EB3: 0x004C, 0x0EB4: 0x004D,
      };
      const sample = SOUND_BY_ITEM[item?.itemId | 0] ?? 0x004C;
      try {
        user?.client?.send?.(_api?.protocol?.playSound?.({
          soundId: sample, volume: 0xFF, x: user.x, y: user.y, z: user.z,
        }));
      } catch { /* play-sound is best-effort */ }
      user?.client?.sendSystemMessage?.(
        'Use [provoke, [peace, or [disco to wield the instrument.',
      );
      return true;
    },
  };
}

export function buildSoulstoneScript(_api) {
  return {
    name: 'soulstone',
    onUse(_w, item, user) {
      // Soulstone double-click should show charge state. Save/load is
      // routed via the [ss-save / [ss-load chat commands so the target
      // cursor flow stays consistent with ServUO's gump.
      if (!user?.client) return true;
      if (!SOULSTONE_ITEM_IDS.has(item?.itemId | 0)) return false;
      const charge = item.soulstone;
      if (charge && (charge.value | 0) > 0) {
        user.client.sendSystemMessage(
          `Soulstone holds skill ${charge.skillId} at value ${charge.value}. ` +
          `Use [ss-load to drain it.`,
        );
      } else {
        user.client.sendSystemMessage(
          'The soulstone is empty. Use [ss-save <skillId> to store a skill.',
        );
      }
      return true;
    },
  };
}
