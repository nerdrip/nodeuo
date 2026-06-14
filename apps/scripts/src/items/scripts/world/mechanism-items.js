// Mechanism items — Khaldun-style puzzle furniture.
//
// ServUO references:
//   Items/Misc/PuzzleChest.cs   → puzzle-chest
//   Items/Misc/RaisableItem.cs  → raisable-item
//   Items/Misc/RaiseSwitch.cs   → raise-switch
//
// All three are non-movable world props with onUse + onTarget hooks.
// Each follows the small-state pattern: a few stamped fields on the
// item, a per-mobile cooldown to avoid spam, and `_broadcast()` after
// any mutation so observers see the change.

import { moveItem } from '../../../_movement.js';
import { nearbyClients } from '../../../_spatial.js';
import { itemBySerial } from '../../../_entities.js';

/* ──────────────── puzzle-chest ──────────────── */
//
// 5-cylinder lockpicking puzzle. Each cylinder accepts a number 1..5.
// Players must guess the secret combination set on `item.combination`.
// On wrong guess the lid stays shut and the player takes 5..15 damage
// (cylinder shock) — ServUO uses the same penalty. On full match the
// chest opens (`item.door.isOpen = true`) and exposes its contents.
//
// `item.combination` is a 5-tuple of ints 1..5 stamped at create time
// (random per chest). `item.guesses` is a per-player record:
//   { [mobSerial]: { attempts: number, lastAt: number } }

const COOLDOWN_MS = 4_000;

export function buildPuzzleChest(api) {
  return {
    name: 'puzzle-chest',
    onCreate(_world, item) {
      item.movable = false;
      item.guesses = item.guesses ?? {};
      if (!Array.isArray(item.combination)) {
        item.combination = [
          1 + ((Math.random() * 5) | 0),
          1 + ((Math.random() * 5) | 0),
          1 + ((Math.random() * 5) | 0),
          1 + ((Math.random() * 5) | 0),
          1 + ((Math.random() * 5) | 0),
        ];
      }
    },
    onUse(world, item, user) {
      if (!user) return true;
      if (item.locked === false) {
        // Already cracked — re-open the contents.
        user.client?.sendSystemMessage?.('The chest is unlocked.');
        return false;       // let standard container handler take over
      }
      // Render a gump that lets the player pick 5 cylinder values. The
      // simplest server-driven shape is a system message + prompt: ask
      // the user for 5 digits via UnicodePrompt.
      const ser = (user.serial >>> 0).toString();
      const now = Date.now();
      const last = item.guesses[ser]?.lastAt ?? 0;
      if (now - last < COOLDOWN_MS) {
        user.client?.sendSystemMessage?.('You must wait before trying again.');
        return true;
      }
      const promptFn = api.handlers?.prompts?.request ?? api.prompts?.request;
      if (typeof promptFn !== 'function') {
        user.client?.sendSystemMessage?.('You see five cylinders. Use [puzzle <a> <b> <c> <d> <e>.');
        return true;
      }
      promptFn(user.client, 'Enter 5 digits 1..5, e.g. "13524":', (text) => {
        const digits = String(text ?? '').trim().split('').map((c) => c.charCodeAt(0) - 48);
        if (digits.length !== 5 || digits.some((d) => d < 1 || d > 5)) {
          user.client?.sendSystemMessage?.('Invalid combination — five digits 1..5 expected.');
          return;
        }
        const match = digits.every((d, i) => d === item.combination[i]);
        item.guesses[ser] = { attempts: (item.guesses[ser]?.attempts ?? 0) + 1, lastAt: Date.now() };
        if (match) {
          item.locked = false;
          user.client?.sendSystemMessage?.('You hear the cylinders click into place. The chest opens.');
          _broadcast(api, world, item);
        } else {
          // ServUO `PuzzleChest.OnCylindersWrong`: 5–15 damage + system
          // line "The cylinders shock you, painfully!"
          const dmg = 5 + ((Math.random() * 11) | 0);
          user.hp = Math.max(0, (user.hp ?? 0) - dmg);
          user.client?.sendSystemMessage?.('The cylinders shock you, painfully!');
        }
      });
      return true;
    },
  };
}

/* ──────────────── raisable-item ──────────────── */
//
// A heavy slab / pillar / floor tile that moves up Z when its paired
// raise-switch is flipped. Used in Khaldun and Doom for level-gating
// platforms (step on the slab, throw the switch, slab rises so you can
// walk to the new tile).
//
// item.raiseAmount  default Z delta when raised
// item.raisedZ      destination Z (filled on-the-fly)
// item.baseZ        original Z (stamped on first raise)
// item._raisedUntil epoch ms — auto-lower after `raiseDurationMs`
// item.raiseDurationMs  default 30s, 0 disables auto-lower

export function buildRaisableItem(api) {
  return {
    name: 'raisable-item',
    onCreate(_world, item) {
      item.movable = false;
      item.baseZ = item.baseZ ?? item.z;
      item.raiseAmount = item.raiseAmount ?? 5;
      item.raiseDurationMs = item.raiseDurationMs ?? 30_000;
      item._raised = false;
    },
    /** Called by raise-switch.onUse. */
    raise(world, item) {
      if (item._raised) return false;
      item._raised = true;
      moveItem(api, item, { z: (item.baseZ | 0) + (item.raiseAmount | 0) });
      _broadcast(api, world, item);
      if (item.raiseDurationMs > 0) {
        item._raisedUntil = Date.now() + item.raiseDurationMs;
        setTimeout(() => {
          if (!item._raised) return;
          item._raised = false;
          moveItem(api, item, { z: item.baseZ | 0 });
          _broadcast(api, world, item);
        }, item.raiseDurationMs).unref?.();
      }
      return true;
    },
  };
}

/* ──────────────── raise-switch ──────────────── */
//
// Flip-switch that calls `raise()` on the linked raisable-item. The link
// is stamped via `_raisableTargetSerial` (admin tool [link <switch> <item>).
// Also flips its own graphic via SWITCH_FLIP (same table as switch.js).

const SWITCH_FLIP_RAISE = new Map([
  [0x1093, 0x1094], [0x1094, 0x1093],
  [0x1090, 0x1091], [0x1091, 0x1090],
  [0x108C, 0x108D], [0x108D, 0x108C],
]);

export function buildRaiseSwitch(api) {
  return {
    name: 'raise-switch',
    onCreate(_world, item) { item.movable = false; },
    onUse(world, item, user) {
      const flip = SWITCH_FLIP_RAISE.get(item.itemId);
      if (flip != null) item.itemId = flip;
      _broadcast(api, world, item);
      const targetSerial = item._raisableTargetSerial >>> 0;
      const target = targetSerial ? itemBySerial({ world }, targetSerial) : null;
      if (target?.raise) {
        try { target.raise(world, target); }
        catch (e) {
          user?.client?.sendSystemMessage?.(`The switch jams: ${e.message}`);
        }
      } else if (target) {
        // Plain raisable-item — invoke the registered script's `raise`.
        const sys = api.systems?.itemScripts;
        const sc = sys?.get?.('raisable-item');
        if (sc?.raise) {
          try { sc.raise(world, target); } catch { /* defensive */ }
        }
      }
      try { user?.client?.send?.(api.protocol?.playSound?.({ soundId: 0x004A, x: item.x, y: item.y, z: item.z })); }
      catch { /* sound advisory */ }
      user?.client?.sendSystemMessage?.('You hear a heavy mechanism grind.');
      return true;
    },
  };
}

/* ──────────────── doom-lever ──────────────── */
//
// One of the four Doom Gauntlet entry levers. Each carries
// `item._leverIndex` (0..3) and `item._leverCtrl` (a controller key
// resolved from systems/bosses/doom-lever-puzzle.js). On use the lever
// flips its graphic and forwards the new position to the controller.

const LEVER_FLIP = new Map([
  [0x108C, 0x108D], [0x108D, 0x108C],
  [0x1090, 0x1091], [0x1091, 0x1090],
]);

export function buildDoomLever(api) {
  return {
    name: 'doom-lever',
    onCreate(_world, item) { item.movable = false; },
    onUse(world, item, user) {
      const flip = LEVER_FLIP.get(item.itemId);
      if (flip != null) item.itemId = flip;
      _broadcast(api, world, item);
      // Resolve controller — `_leverCtrl` is a key in
      // doom-lever-puzzle.js registry. `_leverIndex` is 0..3.
      const ctrlKey = item._leverCtrl ?? 'doom-entrance';
      const idx = item._leverIndex | 0;
      // The lever "down" position is the graphic following the FLIP map
      // — track via parity check on itemId: down = odd of the pair.
      const down = (item.itemId & 1) === 1;
      try {
        const mod = api.systems?.doomLeverPuzzle;
        const ctrl = mod?.getLeverPuzzle?.(ctrlKey);
        if (ctrl) ctrl.setLever(idx, down, user?.serial ?? 0);
      } catch (e) {
        console.error('[doom-lever] setLever threw:', e);
      }
      try { user?.client?.send?.(api.protocol?.playSound?.({ soundId: 0x004A, x: item.x, y: item.y, z: item.z })); }
      catch { /* sound advisory */ }
      return true;
    },
  };
}

/* ──────────────── helpers ──────────────── */
function _broadcast(api, world, item) {
  const wi = api.protocol?.worldItemSA?.({
    serial: item.serial, itemId: item.itemId, hue: item.hue,
    amount: item.amount ?? 1, x: item.x, y: item.y, z: item.z,
  });
  if (!wi) return;
  for (const m of nearbyClients(world, item)) m.client.send(wi);
}
