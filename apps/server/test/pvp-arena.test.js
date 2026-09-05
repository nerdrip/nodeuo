// PvP Arena queue + match + tournament tests.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  enrol1v1, enrol2v2, leave, tickPairing, recordKill, tickMatches,
  canArenaAttack, isInMatch, status,
  tournamentCreate, tournamentJoin, tournamentStart,
  _resetForTest,
} from '../src/systems/pvp/pvp-arena.js';
import { World } from '../src/world/world.js';
import { PartyRegistry } from '../src/party.js';

function makeFighter(world, name, x = 100, y = 100) {
  const mob = world.createMobile({
    name, body: 0x0190, x, y, z: 0, map: 1,
    hp: 100, hpMax: 100, mana: 50, manaMax: 50, stam: 50, stamMax: 50,
    client: { send: () => {}, sendSystemMessage: () => {} },
  });
  return mob;
}

describe('PvP Arena', () => {
  beforeEach(() => _resetForTest());

  it('enrol1v1 + tickPairing pairs two queued fighters into a 1v1 match', () => {
    const world = new World();
    const a = makeFighter(world, 'Alice', 10, 10);
    const b = makeFighter(world, 'Bob',   20, 20);

    expect(enrol1v1(a)).toBe(true);
    expect(enrol1v1(b)).toBe(true);
    // Duplicate enrol is a no-op.
    expect(enrol1v1(a)).toBe(false);

    const matches = tickPairing(world);
    expect(matches).toHaveLength(1);
    expect(matches[0].mode).toBe('1v1');
    expect(matches[0].teamA).toEqual([a.serial]);
    expect(matches[0].teamB).toEqual([b.serial]);
    expect(isInMatch(a)).toBe(true);
    expect(isInMatch(b)).toBe(true);
    // Combatants got teleported to the arena pads.
    expect(a.x).not.toBe(10);
    expect(b.x).not.toBe(20);
    // Match coords are inside the arena map.
    expect(a.map).toBe(1);
  });

  it('resolves party serials into real mobiles for a 2v2 match', () => {
    const world = new World();
    const parties = new PartyRegistry(world);
    world._partyRegistry = parties;
    const [a1, a2, b1, b2] = ['A1', 'A2', 'B1', 'B2'].map((name) => makeFighter(world, name));
    for (const fighter of [a1, a2, b1, b2]) {
      fighter.client = { send() {}, sendSystemMessage() {} };
    }
    parties.invite(a1.serial, a2.serial); parties.accept(a2.serial, a1.serial);
    parties.invite(b1.serial, b2.serial); parties.accept(b2.serial, b1.serial);
    const partyA = parties.partyOf(a1.serial);
    const partyB = parties.partyOf(b1.serial);

    expect(enrol2v2(partyA)).toBe(true);
    expect(enrol2v2(partyB)).toBe(true);
    const matches = tickPairing(world);

    expect(matches).toHaveLength(1);
    expect(matches[0].mode).toBe('2v2');
    expect(matches[0].teamA).toEqual([a1.serial, a2.serial]);
    expect(matches[0].teamB).toEqual([b1.serial, b2.serial]);
    expect([a1, a2, b1, b2].every((mob) => isInMatch(mob))).toBe(true);
  });

  it('canArenaAttack returns true only for opposing teams in same active match', () => {
    const world = new World();
    const a = makeFighter(world, 'A');
    const b = makeFighter(world, 'B');
    const c = makeFighter(world, 'C');   // not in any match
    enrol1v1(a); enrol1v1(b); tickPairing(world);

    expect(canArenaAttack(a, b)).toBe(true);
    expect(canArenaAttack(b, a)).toBe(true);
    expect(canArenaAttack(a, c)).toBe(false);
    expect(canArenaAttack(c, a)).toBe(false);
  });

  it('recordKill ends the match and restores positions', () => {
    const world = new World();
    const a = makeFighter(world, 'Alice', 50, 50);
    const b = makeFighter(world, 'Bob',   60, 60);
    enrol1v1(a); enrol1v1(b);
    tickPairing(world);

    // Snapshot pre-match coords (they got overwritten by teleport).
    expect(isInMatch(a)).toBe(true);
    const m = recordKill(world, a, b);
    expect(m).toBeTruthy();
    expect(m.ended).toBe(true);
    expect(m.winner).toBe('A');
    // Both fighters are no longer in-match.
    expect(isInMatch(a)).toBe(false);
    expect(isInMatch(b)).toBe(false);
    // Positions restored to pre-match (50,50 / 60,60).
    expect(a.x).toBe(50);
    expect(a.y).toBe(50);
    expect(b.x).toBe(60);
    expect(b.y).toBe(60);
  });

  it('tickMatches enforces the 5-min timeout', () => {
    const world = new World();
    const a = makeFighter(world, 'A');
    const b = makeFighter(world, 'B');
    enrol1v1(a); enrol1v1(b);
    tickPairing(world);

    const future = Date.now() + 6 * 60 * 1000;
    tickMatches(world, future);
    // Both teams equal size → draw.
    const s = status();
    expect(s.matches).toHaveLength(0);    // ended matches drop off the active list
  });

  it('leave removes a queued fighter before pair-up', () => {
    const world = new World();
    const a = makeFighter(world, 'A');
    enrol1v1(a);
    expect(status().queue1v1).toEqual([a.serial]);
    expect(leave(a)).toBe(true);
    expect(status().queue1v1).toEqual([]);
  });

  it('tournament: create → join (×4) → start brackets to round 1 with 2 matches', () => {
    const world = new World();
    const p1 = makeFighter(world, 'P1');
    const p2 = makeFighter(world, 'P2');
    const p3 = makeFighter(world, 'P3');
    const p4 = makeFighter(world, 'P4');

    const t = tournamentCreate('Spring Cup', p1);
    expect(t).toBeTruthy();
    expect(tournamentJoin('Spring Cup', p1).ok).toBe(true);
    expect(tournamentJoin('Spring Cup', p2).ok).toBe(true);
    expect(tournamentJoin('Spring Cup', p3).ok).toBe(true);
    expect(tournamentJoin('Spring Cup', p4).ok).toBe(true);
    // Duplicate join is rejected.
    expect(tournamentJoin('Spring Cup', p1).ok).toBe(false);

    const r = tournamentStart(world, 'Spring Cup');
    expect(r.ok).toBe(true);
    // 4 entrants → 2 round-1 matches, all four fighters are in-match.
    expect(isInMatch(p1)).toBe(true);
    expect(isInMatch(p2)).toBe(true);
    expect(isInMatch(p3)).toBe(true);
    expect(isInMatch(p4)).toBe(true);
    expect(status().matches.length).toBe(2);
  });

  it('tournament: full bracket with 2 entrants produces a champion', () => {
    const world = new World();
    const p1 = makeFighter(world, 'P1');
    const p2 = makeFighter(world, 'P2');
    tournamentCreate('Duel Cup', p1);
    tournamentJoin('Duel Cup', p1);
    tournamentJoin('Duel Cup', p2);
    const r = tournamentStart(world, 'Duel Cup');
    expect(r.ok).toBe(true);
    expect(status().matches.length).toBe(1);
    // p1 wins.
    recordKill(world, p1, p2);
    // Bracket resolved — no active matches, champion is p1.
    const s = status();
    expect(s.matches).toHaveLength(0);
    expect(s.tournaments[0].champion).toBe(p1.serial);
  });

  it('tournament rejects start with fewer than 2 entrants', () => {
    const p1 = makeFighter(new World(), 'P1');
    tournamentCreate('TooSmall', p1);
    tournamentJoin('TooSmall', p1);
    const r = tournamentStart(new World(), 'TooSmall');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not-enough-entrants');
  });
});
