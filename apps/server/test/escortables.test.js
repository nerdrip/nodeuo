import { beforeEach, describe, expect, it } from 'vitest';
import * as mlq from '../src/systems/quests/mlquests.js';
import registerEscortables from '../../scripts/src/quests/escortables.js';

describe('escortable quest catalog', () => {
  beforeEach(() => mlq.clearAll());

  it('registers the canonical EscortToDugan quest with its item reward', () => {
    registerEscortables({ mlQuests: mlq, log: () => {} });

    const q = mlq.getQuest('escort-to-dugan');
    expect(q).toMatchObject({
      id: 'escort-to-dugan',
      title: 'The Lost Brightwhistle',
      giverKind: 'neville-brightwhistle',
      objectives: [
        {
          type: 'escort',
          fromRegion: 'underworld-goblin-halls',
          toRegion: 'npc-encampment',
        },
      ],
    });
    expect(q.rewards).toEqual([
      { type: 'fame', amount: 500 },
      { type: 'item', itemType: 'talisman-of-goblin-slaying', amount: 1 },
    ]);
  });
});
