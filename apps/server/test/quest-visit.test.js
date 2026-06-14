import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerQuest, acceptQuest, notifyEvent, _clearForTest,
} from '../src/systems/quests/quests.js';

// _clearForTest may not exist — guard for it.
function reset() {
  // Minimal helper: redefine fresh state via private API or rely on
  // unique quest ids per test.
}

describe('quest notifyEvent + region visit', () => {
  beforeEach(() => reset());

  it('matches visit objectives by region field', () => {
    registerQuest({
      id: 'visit-test-1',
      name: 'Visit Khaldun',
      objectives: [{ kind: 'visit', region: 'khaldun-pit', count: 1 }],
      reward: { gold: 100 },
    });
    const player = { activeQuests: [] };
    acceptQuest(player, 'visit-test-1');
    expect(player.activeQuests[0].progress[0]).toBeFalsy();
    const reports = notifyEvent(player, { kind: 'visit', target: 'khaldun-pit' });
    expect(reports[0].completed).toBe(true);
    expect(player.activeQuests[0].progress[0]).toBe(1);
  });

  it('matches collect objectives by resource field', () => {
    registerQuest({
      id: 'collect-test-1',
      name: 'Gather Hides',
      objectives: [{ kind: 'collect', resource: 'cured-hide', count: 5 }],
      reward: { gold: 100 },
    });
    const player = { activeQuests: [] };
    acceptQuest(player, 'collect-test-1');
    notifyEvent(player, { kind: 'collect', target: 'cured-hide', amount: 3 });
    notifyEvent(player, { kind: 'collect', target: 'cured-hide', amount: 2 });
    expect(player.activeQuests[0].progress[0]).toBe(5);
  });

  it('ignores events with mismatched target', () => {
    registerQuest({
      id: 'visit-test-2',
      name: 'Visit Bedlam',
      objectives: [{ kind: 'visit', region: 'bedlam-prison', count: 1 }],
      reward: { gold: 100 },
    });
    const player = { activeQuests: [] };
    acceptQuest(player, 'visit-test-2');
    const reports = notifyEvent(player, { kind: 'visit', target: 'khaldun-pit' });
    expect(reports).toEqual([]);
    expect(player.activeQuests[0].progress[0]).toBeFalsy();
  });
});
