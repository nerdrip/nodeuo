import { describe, it, expect, beforeEach } from 'vitest';
import * as mlq from '../src/systems/quests/mlquests.js';

function makeMob() { return { serial: 1, name: 'Hero', skills: {} }; }

describe('mlquests', () => {
  beforeEach(() => mlq.clearAll());

  it('register + getQuest round-trip', () => {
    mlq.registerQuest({
      id: 'rat-cull', title: 'Cull rats',
      objectives: [{ type: 'slay', kind: 'rat', count: 3 }],
      rewards: [{ type: 'gold', amount: 100 }],
    });
    expect(mlq.getQuest('rat-cull')?.title).toBe('Cull rats');
  });

  it('refuses duplicate registration', () => {
    mlq.registerQuest({ id: 'q1', objectives: [{ type: 'slay', kind: 'rat', count: 1 }] });
    expect(() => mlq.registerQuest({ id: 'q1' })).toThrow();
  });

  it('allows an explicit authored quest to replace an extracted placeholder', () => {
    mlq.registerQuest({ id: 'escort', extracted: true, objectives: [] });
    mlq.replaceQuest({
      id: 'escort',
      title: 'Authored escort',
      objectives: [{ type: 'escort', toRegion: 'camp' }],
    });
    expect(mlq.getQuest('escort')).toMatchObject({
      title: 'Authored escort',
      extracted: false,
      objectives: [{ type: 'escort', toRegion: 'camp' }],
    });
  });

  it('offer + trackKill completes a slay quest', () => {
    mlq.registerQuest({
      id: 'kill3rats', objectives: [{ type: 'slay', kind: 'rat', count: 3 }],
      rewards: [{ type: 'gold', amount: 100 }],
    });
    const m = makeMob();
    expect(mlq.offer(m, 'kill3rats').ok).toBe(true);
    mlq.trackKill(m, 'rat');
    mlq.trackKill(m, 'rat');
    expect(m.mlQuests[0].completed).toBe(false);
    mlq.trackKill(m, 'rat');
    expect(m.mlQuests[0].completed).toBe(true);
  });

  it('turnIn awards gold + fame', () => {
    mlq.registerQuest({
      id: 'q2', objectives: [{ type: 'slay', kind: 'rat', count: 1 }],
      rewards: [{ type: 'gold', amount: 50 }, { type: 'fame', amount: 25 }],
    });
    const m = makeMob();
    mlq.offer(m, 'q2');
    mlq.trackKill(m, 'rat');
    expect(mlq.turnIn(m, 'q2').length).toBe(2);
    expect(m.gold).toBe(50);
    expect(m.fame).toBe(25);
    // second turn-in is a no-op
    expect(mlq.turnIn(m, 'q2').length).toBe(0);
  });

  it('escort completion via trackEscortArrive', () => {
    mlq.registerEscort({ id: 'escort-britain', npcKind: 'noble', fromRegion: 'Trinsic', toRegion: 'Britain' });
    const m = makeMob();
    mlq.offer(m, 'escort-britain');
    expect(m.mlQuests[0].completed).toBe(false);
    mlq.trackEscortArrive(m, 'Britain');
    expect(m.mlQuests[0].completed).toBe(true);
  });

  it('unique quest cannot be retaken after completion', () => {
    mlq.registerQuest({
      id: 'qOnce', objectives: [{ type: 'slay', kind: 'rat', count: 1 }],
      rewards: [], unique: true,
    });
    const m = makeMob();
    mlq.offer(m, 'qOnce');
    mlq.trackKill(m, 'rat');
    expect(mlq.offer(m, 'qOnce').reason).toBe('already-completed');
  });

  it('reports an uncompleted unique quest as active, not completed', () => {
    mlq.registerQuest({
      id: 'qUniqueActive', objectives: [{ type: 'slay', kind: 'rat', count: 2 }],
      rewards: [], unique: true,
    });
    const m = makeMob();
    mlq.offer(m, 'qUniqueActive');
    expect(mlq.offer(m, 'qUniqueActive').reason).toBe('already-active');
  });

  it('non-unique quest can be replayed after completion', () => {
    mlq.registerQuest({
      id: 'qRepeat', objectives: [{ type: 'slay', kind: 'rat', count: 1 }],
      rewards: [], unique: false,
    });
    const m = makeMob();
    mlq.offer(m, 'qRepeat');
    mlq.trackKill(m, 'rat');
    expect(m.mlQuests[0].completed).toBe(true);
    expect(mlq.offer(m, 'qRepeat').ok).toBe(true);
    expect(m.mlQuests[0].completed).toBe(false);
  });

  it('abandon drops the entry', () => {
    mlq.registerQuest({ id: 'qAb', objectives: [{ type: 'slay', kind: 'rat', count: 1 }] });
    const m = makeMob();
    mlq.offer(m, 'qAb');
    expect(mlq.abandon(m, 'qAb')).toBe(true);
    expect(m.mlQuests.length).toBe(0);
  });

  it('trackTalk completes talk objective', () => {
    mlq.registerQuest({
      id: 'qTalk',
      objectives: [{ type: 'talk', npcSerial: 999, keyword: 'rumor' }],
      rewards: [],
    });
    const m = makeMob();
    mlq.offer(m, 'qTalk');
    mlq.trackTalk(m, 999, 'rumor');
    expect(m.mlQuests[0].completed).toBe(true);
  });
});
