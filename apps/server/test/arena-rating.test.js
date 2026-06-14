import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordMatchResult, ratingOf, leaderboard, rotateSeason, currentSeasonId,
  _resetForTest,
} from '../src/systems/pvp/pvp-arena.js';

describe('PVP Arena rating + leaderboard', () => {
  beforeEach(() => _resetForTest());

  it('starts every player at 1200 ELO', () => {
    expect(ratingOf(1).rating).toBe(1200);
  });

  it('winner gains rating, loser loses', () => {
    const r = recordMatchResult(1, 2);
    expect(r.winnerRating).toBeGreaterThan(1200);
    expect(r.loserRating).toBeLessThan(1200);
    expect(ratingOf(1).wins).toBe(1);
    expect(ratingOf(2).losses).toBe(1);
  });

  it('symmetric ELO transfer for equal-rated players', () => {
    const r = recordMatchResult(1, 2);
    expect((r.winnerRating - 1200) + (r.loserRating - 1200)).toBe(0);
  });

  it('leaderboard ranks by rating', () => {
    recordMatchResult(1, 2);
    recordMatchResult(1, 3);
    recordMatchResult(3, 2);
    const board = leaderboard(3);
    expect(board[0].serial).toBe(1);          // 2 wins
    expect(board[0].wins).toBe(2);
  });

  it('rotateSeason decays toward 1200 and clears counters', () => {
    recordMatchResult(1, 2);
    recordMatchResult(1, 2);
    const before = ratingOf(1);
    expect(before.wins).toBe(2);
    rotateSeason('TEST-S2');
    const after = ratingOf(1);
    expect(after.season).toBe('TEST-S2');
    expect(after.wins).toBe(0);
    // Decayed halfway from the original delta toward 1200.
    expect(Math.abs(after.rating - 1200)).toBeLessThan(Math.abs(before.rating - 1200));
    expect(currentSeasonId()).toBe('TEST-S2');
  });
});
