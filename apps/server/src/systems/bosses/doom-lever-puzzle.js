// Doom Lever Puzzle — port of ServUO `Engines/Doom/LeverPuzzleController.cs`.
//
// At the entrance of the Doom Gauntlet sit 4 levers. Each lever has two
// positions (up / down). Players must guess the secret 4-bit combination
// (16 total). The controller picks a new code on each puzzle reset and
// chimes when a lever flips. When the 4 levers' positions match the
// secret, the puzzle ENDS, the player is rewarded with the secret bonus
// + the gauntlet entrance is unsealed.
//
// Wrong combo + 30s timeout: chained lightning fires across the puzzle
// region for `wrongPenaltyMs` ms (default 5s) dealing 5..15 damage per
// hit; controller then resets the levers to all-up and rolls a new code.
//
// API (one controller per Doom location — usually 1 instance):
//   ctrl.setLever(idx, position) — called by lever-item onUse
//   ctrl.reset()                 — admin reset
//   ctrl.status()                — debug summary

/** @typedef {import('../../world/world.js').World} World */

export class LeverPuzzleController {
  /**
   * @param {World} world
   * @param {{ map:number, cx:number, cy:number, cz:number, radius:number,
   *           timeoutMs?:number, wrongPenaltyMs?:number,
   *           onSolved?:(world:World, ctrl:LeverPuzzleController, solverSerial?:number)=>void }} cfg
   */
  constructor(world, cfg) {
    this.world = world;
    this.cfg = { timeoutMs: 30_000, wrongPenaltyMs: 5_000, ...cfg };
    /** Lever positions, 4 booleans (false=up, true=down). */
    this.levers = [false, false, false, false];
    /** Secret combination — re-rolled on every reset. */
    this.secret = this._rollSecret();
    /** Solved-state flag — true between solve and reset. */
    this.solved = false;
    /** Last interactor serial (for solve credit). */
    this._lastInteractor = 0;
    /** Timer for auto-reset / penalty. */
    this._penaltyTimer = null;
  }

  _rollSecret() {
    return [
      Math.random() < 0.5, Math.random() < 0.5,
      Math.random() < 0.5, Math.random() < 0.5,
    ];
  }

  /** Lever click — flips position and checks for solve. */
  setLever(idx, position, by = 0) {
    if (this.solved) return;
    if (idx < 0 || idx > 3) return;
    this.levers[idx] = !!position;
    this._lastInteractor = by >>> 0;
    if (this._matches()) {
      this._onSolved();
      return;
    }
    // Wrong-but-incomplete: arm the penalty timer so the player has
    // 30s to fix it. If the timer was already armed, leave it.
    if (!this._penaltyTimer) {
      this._penaltyTimer = setTimeout(() => this._onPenalty(),
        this.cfg.timeoutMs).unref?.();
    }
  }

  reset() {
    this.levers = [false, false, false, false];
    this.secret = this._rollSecret();
    this.solved = false;
    if (this._penaltyTimer) { clearTimeout(this._penaltyTimer); this._penaltyTimer = null; }
  }

  _matches() {
    return this.levers.every((v, i) => v === this.secret[i]);
  }

  _onSolved() {
    this.solved = true;
    if (this._penaltyTimer) { clearTimeout(this._penaltyTimer); this._penaltyTimer = null; }
    try { this.cfg.onSolved?.(this.world, this, this._lastInteractor); }
    catch (e) { console.error('[doom-lever] onSolved threw:', e); }
  }

  _onPenalty() {
    this._penaltyTimer = null;
    if (this.solved) return;
    // Lightning storm — pick every mobile inside the puzzle room and
    // deal 5..15 random damage. Auto-reset after the penalty window so
    // the players can try again.
    const startedAt = Date.now();
    const tick = () => {
      if (Date.now() - startedAt > this.cfg.wrongPenaltyMs) {
        this.reset();
        return;
      }
      for (const m of this.world.mobiles.values()) {
        if (m.map !== this.cfg.map) continue;
        if (Math.abs(m.x - this.cfg.cx) > this.cfg.radius) continue;
        if (Math.abs(m.y - this.cfg.cy) > this.cfg.radius) continue;
        const dmg = 5 + ((Math.random() * 11) | 0);
        m.hp = Math.max(0, (m.hp ?? 0) - dmg);
        m.client?.sendSystemMessage?.('Lightning crashes around you!');
      }
      setTimeout(tick, 1000).unref?.();
    };
    tick();
  }

  status() {
    return {
      levers: this.levers.slice(),
      solved: this.solved,
      penaltyArmed: this._penaltyTimer !== null,
    };
  }
}

const _registry = new Map();
export function registerLeverPuzzle(name, ctrl) {
  _registry.set(name, ctrl);
  return ctrl;
}
export function unregisterLeverPuzzle(name, expected = null) {
  if (expected && _registry.get(name) !== expected) return false;
  return _registry.delete(name);
}
export function getLeverPuzzle(name) { return _registry.get(name) ?? null; }
export function listLeverPuzzles() { return [..._registry.entries()]; }
