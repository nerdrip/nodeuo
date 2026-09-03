import { describe, it, expect } from 'vitest';
import {
  registerConversation, beginConversation, advanceConversation,
} from '../src/systems/quests/quest-conversation.js';

describe('quest-conversation', () => {
  registerConversation('orc-quest', {
    entry: 'greeting',
    nodes: [
      {
        id: 'greeting',
        text: 'What do you want?',
        choices: [
          { key: 'help', text: 'I want to help.', next: 'offer' },
          { key: 'leave', text: 'Nothing.', next: 'farewell' },
        ],
        keywords: ['job', 'work'],
      },
      // Keyword routes go to `${nodeId}:${keyword}`.
      { id: 'greeting:job', text: 'Yes, work!', nextDefault: 'offer' },
      { id: 'greeting:work', text: 'Same as job!', nextDefault: 'offer' },
      {
        id: 'offer',
        text: 'Slay 5 orcs and return.',
        terminal: true,
        onEnter(ctx) { ctx.playerState._questAccepted = true; },
      },
      { id: 'farewell', text: 'Goodbye.', terminal: true },
    ],
  });

  it('beginConversation returns entry node payload', () => {
    const ps = {};
    const node = beginConversation({
      playerState: ps, npc: { serial: 100 }, kind: 'orc-quest',
    });
    expect(node.id).toBe('greeting');
    expect(node.choices.length).toBe(2);
    expect(ps.questConvo[100].currentNode).toBe('greeting');
  });

  it('advance via explicit choice key', () => {
    const ps = {};
    beginConversation({ playerState: ps, npc: { serial: 200 }, kind: 'orc-quest' });
    const next = advanceConversation({ playerState: ps, npc: { serial: 200 }, input: 'help' });
    expect(next.id).toBe('offer');
    expect(next.terminal).toBe(true);
    expect(ps._questAccepted).toBe(true);
    // Terminal → session cleared.
    expect(ps.questConvo[200]).toBeUndefined();
  });

  it('advance via keyword match', () => {
    const ps = {};
    beginConversation({ playerState: ps, npc: { serial: 300 }, kind: 'orc-quest' });
    const next = advanceConversation({
      playerState: ps, npc: { serial: 300 }, input: 'do you have any work for me?',
    });
    expect(next.id).toBe('greeting:work');
  });

  it('returns null for unmatched input with no default', () => {
    const ps = {};
    beginConversation({ playerState: ps, npc: { serial: 400 }, kind: 'orc-quest' });
    const next = advanceConversation({
      playerState: ps, npc: { serial: 400 }, input: 'asdfgh',
    });
    expect(next).toBeNull();
  });

  it('supports transactional choice routing', () => {
    registerConversation('merchant-conversation', {
      entry: 'offer',
      nodes: [
        {
          id: 'offer',
          text: 'Buy?',
          choices: [{
            key: 'buy',
            text: 'Buy.',
            next: ({ playerState }) => playerState.gold >= 10 ? 'sold' : 'no-gold',
          }],
        },
        { id: 'sold', text: 'Sold.', terminal: true },
        { id: 'no-gold', text: 'Not enough gold.', terminal: true },
      ],
    });
    const npc = { serial: 500 };
    const rich = { gold: 10 };
    beginConversation({ playerState: rich, npc, kind: 'merchant-conversation' });
    expect(advanceConversation({ playerState: rich, npc, input: 'buy' }).id).toBe('sold');

    const poor = { gold: 0 };
    beginConversation({ playerState: poor, npc, kind: 'merchant-conversation' });
    expect(advanceConversation({ playerState: poor, npc, input: 'buy' }).id).toBe('no-gold');
  });
});
