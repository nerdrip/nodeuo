import { describe, it, expect, beforeEach } from 'vitest';
import {
  joinFaction, nominateCandidate, castVote, tickElection,
  electionState, depositFactionGold, withdrawFactionGold, financeState,
  _resetFactionPolitics,
} from '../src/systems/pvp/factions.js';

const FACTION = 'truebrits';

function mkMember(serial, kills = 20) {
  const m = { serial };
  joinFaction(m, FACTION);
  // joinFaction zeroes factionKills by design — set the test kill
  // count AFTER joining so nomination gates can be exercised.
  m.factionKills = kills;
  return m;
}

describe('Faction Election', () => {
  beforeEach(() => _resetFactionPolitics());

  it('refuses nomination outside nominate phase', () => {
    const m = mkMember(1);
    const r = nominateCandidate(FACTION, m);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('wrong-phase');
  });

  it('accepts nomination once phase opens', () => {
    const m = mkMember(1);
    // Force phase change.
    tickElection(FACTION, Date.now() + 5 * 7 * 24 * 60 * 60 * 1000);
    const r = nominateCandidate(FACTION, m);
    expect(r.ok).toBe(true);
  });

  it('refuses nomination from member with too few kills', () => {
    const m = mkMember(1, 3);
    tickElection(FACTION, Date.now() + 5 * 7 * 24 * 60 * 60 * 1000);
    const r = nominateCandidate(FACTION, m);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('low-kills');
  });

  it('phase advances nominate → ballot → idle on tick', () => {
    const m = mkMember(1);
    const start = Date.now();
    tickElection(FACTION, start + 5 * 7 * 24 * 60 * 60 * 1000);
    nominateCandidate(FACTION, m);
    // Advance past nominate window.
    tickElection(FACTION, start + 6 * 7 * 24 * 60 * 60 * 1000);
    expect(electionState(FACTION).phase).toBe('ballot');
  });

  it('casts vote during ballot', () => {
    const cand = mkMember(1);
    const voter = mkMember(2);
    const start = Date.now();
    tickElection(FACTION, start + 5 * 7 * 24 * 60 * 60 * 1000);
    nominateCandidate(FACTION, cand);
    tickElection(FACTION, start + 6 * 7 * 24 * 60 * 60 * 1000);
    const r = castVote(FACTION, voter, 1);
    expect(r.ok).toBe(true);
    const r2 = castVote(FACTION, voter, 1);
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe('already-voted');
  });
});

describe('Faction Finance', () => {
  beforeEach(() => _resetFactionPolitics());

  it('deposit + withdraw flow gated on commander', () => {
    depositFactionGold(FACTION, 5000);
    expect(financeState(FACTION).gold).toBe(5000);
    const m = mkMember(99);
    const r = withdrawFactionGold(FACTION, m, 1000);
    expect(r.ok).toBe(false);                       // not commander
    expect(r.reason).toBe('not-commander');
  });

  it('refuses withdraw over balance', () => {
    depositFactionGold(FACTION, 100);
    // Forge commander.
    const m = mkMember(1);
    const start = Date.now();
    tickElection(FACTION, start + 5 * 7 * 24 * 60 * 60 * 1000);
    nominateCandidate(FACTION, m);
    tickElection(FACTION, start + 6 * 7 * 24 * 60 * 60 * 1000);
    castVote(FACTION, m, 1);
    tickElection(FACTION, start + 7 * 7 * 24 * 60 * 60 * 1000);
    expect(electionState(FACTION).commanderSerial).toBe(1);
    const r = withdrawFactionGold(FACTION, m, 9999);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('insufficient');
  });
});
