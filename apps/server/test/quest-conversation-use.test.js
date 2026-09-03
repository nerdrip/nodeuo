import { describe, expect, it, vi } from 'vitest';
import { World } from '../src/world/world.js';
import { Stage } from '../src/net/net-state.js';
import { contextMenus } from '../src/net/handlers.js';
import * as conversations from '../src/systems/quests/quest-conversation.js';
import registerServUOP1QuestParity from '../../scripts/src/quests/servuo-p1-quest-parity.js';

describe('mobile use starts native quest conversations', () => {
  it('opens a registered conversation instead of an NPC paperdoll', () => {
    const world = new World();
    const player = world.createMobile({ name: 'Player', body: 0x190, x: 10, y: 10, z: 0, map: 1 });
    const npc = world.createMobile({ name: 'Quest NPC', kind: '__use-quest-npc', body: 0x190, x: 11, y: 10, z: 0, map: 1 });
    npc.kind = '__use-quest-npc';
    conversations.registerConversation(npc.kind, {
      entry: 'hello', nodes: [{ id: 'hello', text: 'A reachable quest dialogue.', choices: [] }],
    });
    const state = {
      id: 91, stage: Stage.InWorld, mobile: player,
      ctx: { world, systems: { questConversation: conversations } },
      send: vi.fn(), sendSystemMessage: vi.fn(),
    };
    player.client = state;
    contextMenus.use(state, npc.serial);
    expect(state.sendSystemMessage).toHaveBeenCalledWith('A reachable quest dialogue.');
    expect(state.questConvo[npc.serial]).toMatchObject({ kind: npc.kind, currentNode: 'hello' });
  });

  it('completes the Impresario purchase only when payment succeeds', () => {
    registerServUOP1QuestParity({ systems: { questConversation: conversations } });
    const npc = { serial: 92 };

    const richPlayer = { gold: 10, mlQuests: [{ id: 'collector', progress: {} }] };
    const richState = { mobile: richPlayer };
    conversations.beginConversation({ playerState: richState, npc, kind: 'impresario' });
    expect(conversations.advanceConversation({ playerState: richState, npc, input: 'accept' })).toMatchObject({
      id: 'GetSheetMusicConversation',
      terminal: true,
    });
    expect(richPlayer.gold).toBe(0);
    expect(richPlayer.collectorSheetMusic).toBe(true);
    expect(richPlayer.mlQuests[0].progress['talk:sheet music']).toBe(true);

    const poorPlayer = { gold: 0 };
    const poorState = { mobile: poorPlayer };
    conversations.beginConversation({ playerState: poorState, npc, kind: 'impresario' });
    expect(conversations.advanceConversation({ playerState: poorState, npc, input: 'accept' })).toMatchObject({
      id: 'NoGoldForSheetMusicConversation',
      terminal: true,
    });
    expect(poorPlayer.collectorSheetMusic).toBeUndefined();
  });
});
