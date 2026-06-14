// Khaldun Puzzle Traps — moveable-tile puzzles + raisable item lever
// switches that gate access to the Doom-tier loot chests inside
// Khaldun. Mirrors ServUO `Items/Misc/Khaldun/`:
//
//   PuzzleChest      — a chest where each lock has 5 colored gems and a
//                      cipher; player guesses 5 colors in order, gets
//                      visual feedback (right/wrong/right-wrong-place).
//   RaisableItem     — an item that can be raised by N units with the
//                      Carpentry skill (pulleys + counterweights).
//   RaiseSwitch      — pulls the linked RaisableItem up by 1 unit per use.
//   StealthSwitch    — only triggers if the player has Hidden+Stealth.
//
// API:
//   khaldun.makePuzzle(world, gems, solution)
//   khaldun.tryGuess(puzzle, guess)        → { correct, hits, misplaced }
//   khaldun.linkRaisable(switchItem, raisableItem)
//   khaldun.raise(raisable, amount=1)
//   khaldun.usingSwitch(mob, switchItem)

import { effectiveSkill } from '../../combat-formulas.js';

const GEM_COLORS = Object.freeze(['red','blue','green','yellow','purple','black','white']);

/** Build a puzzle. If `solution` not given, randomize. */
export function makePuzzle(world, opts = {}) {
  const slots = opts.slots ?? 5;
  const colors = opts.colorPool ?? GEM_COLORS;
  const sol = opts.solution ?? Array.from({ length: slots }, () =>
    colors[Math.floor(Math.random() * colors.length)]);
  return world.createItem({
    itemId: 0x09A8,                     // OSI metal chest graphic
    name: 'puzzle chest',
    container: true,
    locked: true,
    puzzle: {
      slots, solution: sol, attempts: 0, solved: false, available: colors,
    },
  });
}

/**
 * Try a guess against the puzzle. Returns:
 *   { correct: bool, hits, misplaced }
 *
 * `hits` = colors in right position; `misplaced` = right color in wrong slot.
 * On full match, marks the puzzle solved and unlocks the chest.
 */
export function tryGuess(puzzleItem, guess) {
  const p = puzzleItem?.puzzle;
  if (!p) return { correct: false, hits: 0, misplaced: 0 };
  if (!Array.isArray(guess) || guess.length !== p.slots) {
    return { correct: false, hits: 0, misplaced: 0, error: 'wrong-length' };
  }
  let hits = 0, misplaced = 0;
  const used = Array(p.slots).fill(false);
  for (let i = 0; i < p.slots; i++) {
    if (guess[i] === p.solution[i]) { hits++; used[i] = true; }
  }
  for (let i = 0; i < p.slots; i++) {
    if (guess[i] === p.solution[i]) continue;
    for (let j = 0; j < p.slots; j++) {
      if (!used[j] && guess[i] === p.solution[j]) {
        misplaced++;
        used[j] = true;
        break;
      }
    }
  }
  p.attempts++;
  if (hits === p.slots) {
    p.solved = true;
    puzzleItem.locked = false;
  }
  return { correct: hits === p.slots, hits, misplaced };
}

// ====================================================================
// Raisable items + switches.

const _raisableLinks = new Map();       // switchSerial → raisableSerial

export function linkRaisable(switchItem, raisableItem) {
  if (!switchItem || !raisableItem) return false;
  _raisableLinks.set(switchItem.serial, raisableItem.serial);
  raisableItem.raisable ??= { z0: raisableItem.z, raisedBy: 0, maxRaise: 16 };
  return true;
}

export function raise(raisableItem, amount = 1) {
  const r = raisableItem?.raisable;
  if (!r) return false;
  const next = r.raisedBy + amount;
  if (next > r.maxRaise) return false;
  r.raisedBy = next;
  raisableItem.z = r.z0 + r.raisedBy;
  return true;
}

export function lower(raisableItem, amount = 1) {
  const r = raisableItem?.raisable;
  if (!r) return false;
  r.raisedBy = Math.max(0, r.raisedBy - amount);
  raisableItem.z = r.z0 + r.raisedBy;
  return true;
}

/**
 * Use a raise-switch. Looks up the linked raisable, calls `raise()`. If
 * the switch is `stealthOnly`, gates on the user being hidden + having
 * Stealth skill.
 */
export function usingSwitch(world, mob, switchItem, opts = {}) {
  const linked = _raisableLinks.get(switchItem?.serial);
  if (!linked) return { ok: false, reason: 'no-link' };
  const raisable = world.items?.get?.(linked);
  if (!raisable) return { ok: false, reason: 'missing-raisable' };
  if (switchItem?.stealthOnly) {
    if (!mob?.hidden) return { ok: false, reason: 'must-hide' };
    const stealthSkill = effectiveSkill(mob, 48);     // Stealth
    if (stealthSkill < 80) return { ok: false, reason: 'low-stealth' };
  }
  if (!raise(raisable, opts.amount ?? 1)) {
    return { ok: false, reason: 'max-height' };
  }
  return { ok: true, raisable };
}

export const KHALDUN_CONST = Object.freeze({ GEM_COLORS });
