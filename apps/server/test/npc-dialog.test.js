import { describe, expect, it, vi } from 'vitest';
import { NodeUOFeature, NodeUONpcDialogMessage } from '@uo/nodeuo-protocol';
import { World } from '../src/world/world.js';
import { Stage } from '../src/net/net-state.js';
import { contextMenus, handleNodeUOFeatureRequest, vendors } from '../src/net/handlers.js';
import * as conversations from '../src/systems/quests/quest-conversation.js';

function decodeNpcDialog(message) {
  expect(message.feature).toBe(NodeUOFeature.NpcDialog);
  return {
    kind: message.payload.eventKind,
    requestId: message.payload.requestId,
    payload: message.payload.data,
  };
}

function reply(state, requestId, actionId) {
  return handleNodeUOFeatureRequest(state, { feature: NodeUOFeature.NpcDialog,
    payload: { operation: 'select', requestId, data: { actionId } } });
}

function makeState(world, player) {
  const state = {
    id: 501,
    stage: Stage.InWorld,
    mobile: player,
    ctx: { world, systems: { questConversation: conversations } },
    send: vi.fn(),
    nodeUOJsonTransport: true,
    nodeUOFeatures: new Map([[NodeUOFeature.NpcDialog, 1]]),
    sendNodeUOMessage: vi.fn(() => true),
    sendSystemMessage: vi.fn(),
    supportsNodeUO: (feature) => feature === NodeUOFeature.NpcDialog,
  };
  player.client = state;
  return state;
}

describe('NodeUO visual-novel NPC dialog', () => {
  it('turns a scripted quest conversation into server-authoritative choices', () => {
    const world = new World();
    const player = world.createMobile({ name: 'Player', body: 0x190, x: 10, y: 10, z: 0, map: 1 });
    const npc = world.createMobile({ name: 'Elena', body: 0x191, x: 11, y: 10, z: 0, map: 1 });
    npc.kind = '__nodeuo-vn-quest';
    npc.vocation = 'quest-giver';
    conversations.registerConversation(npc.kind, {
      entry: 'offer',
      nodes: [
        { id: 'offer', text: 'Will you help?', choices: [{ key: 'accept', text: 'I will.', next: 'done' }] },
        { id: 'done', text: 'Then our path is clear.', expression: 'pleased', rewards: [{ type: 'gold', label: '200 gold' }], terminal: true },
      ],
    });
    const state = makeState(world, player);

    contextMenus.use(state, npc.serial);

    expect(state.sendSystemMessage).not.toHaveBeenCalled();
    const opened = decodeNpcDialog(state.sendNodeUOMessage.mock.calls[0][0]);
    expect(opened.kind).toBe(NodeUONpcDialogMessage.Open);
    expect(opened.payload).toMatchObject({
      npcSerial: npc.serial,
      name: 'Elena',
      dialogue: { nodeId: 'offer', text: 'Will you help?', terminal: false },
    });
    const accept = opened.payload.actions.find((action) => action.label === 'I will.');
    expect(accept).toMatchObject({ kind: 'talk' });
    expect(opened.payload.actions.some((action) => action.label === 'Open paperdoll')).toBe(true);

    reply(state, opened.requestId, accept.id);

    const advanced = decodeNpcDialog(state.sendNodeUOMessage.mock.calls.at(-1)[0]);
    expect(advanced.kind).toBe(NodeUONpcDialogMessage.Open);
    expect(advanced.requestId).toBe(opened.requestId);
    expect(advanced.payload.dialogue).toMatchObject({
      nodeId: 'done', text: 'Then our path is clear.', expression: 'pleased', terminal: true,
    });
    expect(advanced.payload.history).toHaveLength(2);
    expect(advanced.payload.dialogue.rewards).toEqual([{ type: 'gold', label: '200 gold' }]);
    expect(state.questConvo?.[npc.serial]).toBeUndefined();

    // The choice belonged to the previous rendered node and is one-shot.
    const sendsBeforeReplay = state.sendNodeUOMessage.mock.calls.length;
    reply(state, opened.requestId, accept.id);
    expect(state.sendNodeUOMessage).toHaveBeenCalledTimes(sendsBeforeReplay);
  });

  it('keeps ordinary NPC use when the capability was not negotiated', () => {
    const world = new World();
    const player = world.createMobile({ name: 'Player', body: 0x190, x: 10, y: 10, z: 0, map: 1 });
    const npc = world.createMobile({ name: 'Classic NPC', body: 0x190, x: 11, y: 10, z: 0, map: 1 });
    npc.vocation = 'townsfolk';
    const state = makeState(world, player);
    state.supportsNodeUO = () => false;

    contextMenus.use(state, npc.serial);

    expect(state.send).toHaveBeenCalledTimes(2);
    expect(state.send.mock.calls[0][0][0]).toBe(0x78); // equipment/mobile refresh
    expect(state.send.mock.calls[1][0][0]).toBe(0x88); // classic paperdoll
  });

  it('merges vendor and scripted context actions, then dispatches them authoritatively', () => {
    const world = new World();
    const player = world.createMobile({ name: 'Player', body: 0x190, x: 10, y: 10, z: 0, map: 1 });
    const npc = world.createMobile({ name: 'Trader', body: 0x190, x: 11, y: 10, z: 0, map: 1 });
    npc.role = 'vendor';
    const customAction = vi.fn();
    const state = makeState(world, player);
    state.ctx.contextMenuProvider = () => [{
      responseId: 77, cliloc: 3006109, nodeUOLabel: 'Ask for local news', nodeUOKind: 'talk', onPick: customAction,
    }];
    vendors.register({
      vendorSerial: npc.serial,
      listStock: () => [{ serial: 0x50000001, itemId: 0x0EED, hue: 0, amount: 10, price: 5, description: 'Gold' }],
      listSellable: () => [],
    });
    try {
      contextMenus.use(state, npc.serial);
      const opened = decodeNpcDialog(state.sendNodeUOMessage.mock.calls.at(-1)[0]);
      expect(opened.payload.actions.map((action) => action.label)).toEqual(expect.arrayContaining([
        'Buy', 'Sell', 'Ask for local news', 'Open paperdoll',
      ]));

      const news = opened.payload.actions.find((action) => action.label === 'Ask for local news');
      reply(state, opened.requestId, news.id);
      expect(customAction).toHaveBeenCalledOnce();
      expect(decodeNpcDialog(state.sendNodeUOMessage.mock.calls.at(-1)[0]).kind).toBe(NodeUONpcDialogMessage.Close);

      contextMenus.use(state, npc.serial);
      const reopened = decodeNpcDialog(state.sendNodeUOMessage.mock.calls.at(-1)[0]);
      const buy = reopened.payload.actions.find((action) => action.label === 'Buy');
      reply(state, reopened.requestId, buy.id);
      expect(state.send.mock.calls.slice(-2).map(([packet]) => packet[0])).toEqual([0x3C, 0x74]);
    } finally {
      vendors.unregister(npc.serial);
    }
  });

  it('closes an expired or out-of-range action without running it', () => {
    const world = new World();
    const player = world.createMobile({ name: 'Player', body: 0x190, x: 10, y: 10, z: 0, map: 1 });
    const npc = world.createMobile({ name: 'Guide', body: 0x190, x: 11, y: 10, z: 0, map: 1 });
    const state = makeState(world, player);

    contextMenus.use(state, npc.serial);
    const opened = decodeNpcDialog(state.sendNodeUOMessage.mock.calls.at(-1)[0]);
    const paperdoll = opened.payload.actions.find((action) => action.label === 'Open paperdoll');
    player.x = 100;
    reply(state, opened.requestId, paperdoll.id);

    expect(decodeNpcDialog(state.sendNodeUOMessage.mock.calls.at(-1)[0])).toMatchObject({
      kind: NodeUONpcDialogMessage.Close, requestId: opened.requestId,
    });
    expect(state.send.mock.calls.some(([packet]) => packet[0] === 0x88)).toBe(false);
  });

  it('routes the bank choice through the existing guarded bank command', () => {
    const world = new World();
    const player = world.createMobile({ name: 'Player', body: 0x190, x: 10, y: 10, z: 0, map: 1 });
    const npc = world.createMobile({ name: 'Banker', body: 0x190, x: 11, y: 10, z: 0, map: 1 });
    npc.role = 'banker';
    const state = makeState(world, player);
    state.ctx.commands = { dispatch: vi.fn() };

    contextMenus.use(state, npc.serial);
    const opened = decodeNpcDialog(state.sendNodeUOMessage.mock.calls.at(-1)[0]);
    const bank = opened.payload.actions.find((action) => action.label === 'Open bank box');
    reply(state, opened.requestId, bank.id);

    expect(state.ctx.commands.dispatch).toHaveBeenCalledWith('bank', expect.objectContaining({
      sender: player, state, world,
    }));
  });
});
