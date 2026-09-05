import { describe, expect, it } from 'vitest';
import {
  appendReplayEvent, createSpecializedState, GAME_SYSTEM_CARDS,
  publicSpecializedState, removeSpecializedParticipant, runSpecializedCommand, specializedCommands,
} from '../src/systems/game-system-specialized.js';

const random = () => 0;
const mobile = (serial, name) => ({ serial, name });
const run = (systemId, state, actor, command, payload = {}) => runSpecializedCommand({
  systemId, state, mobile: actor, command, payload, random, now: 1_000, world: {},
});

describe('specialized game-system engines', () => {
  it('runs a private, turn-based collectible card match', () => {
    const id = 'collectible-card-game';
    const state = createSpecializedState(id);
    const alice = mobile(1, 'Alice'), bob = mobile(2, 'Bob');
    expect(run(id, state, alice, 'set-deck', { cards: ['strike'] })).toMatchObject({ ok: false });
    expect(run(id, state, alice, 'set-deck', {
      cards: ['strike', 'strike', 'strike', 'strike', 'guard', 'guard', 'bolt', 'mend', 'insight', 'riposte'],
    })).toMatchObject({ ok: true, stageIndex: 0 });
    expect(run(id, state, alice, 'ready')).toMatchObject({ ok: true });
    expect(run(id, state, bob, 'ready')).toMatchObject({ ok: true });
    expect(state.round).toBe(1);
    const actor = state.turn === '1' ? alice : bob;
    const opponent = actor === alice ? bob : alice;
    const player = state.players[String(actor.serial)];
    const playable = player.hand.findIndex((cardId) => GAME_SYSTEM_CARDS[cardId].cost <= player.mana);
    expect(run(id, state, actor, 'play-card', { handIndex: playable, targetSerial: opponent.serial })).toMatchObject({ ok: true });
    expect(run(id, state, actor, 'end-turn')).toMatchObject({ ok: true });
    const publicState = publicSpecializedState(id, state, alice);
    expect(publicState.player.hand).toBeInstanceOf(Array);
    expect(publicState.opponents[0]).not.toHaveProperty('hand');
  });

  it('runs deckbuilding routes, rest stops and authoritative encounters', () => {
    const id = 'deckbuilding-expeditions', state = createSpecializedState(id), actor = mobile(3, 'Delver');
    expect(run(id, state, actor, 'choose-route', { route: 'rest' })).toMatchObject({ ok: true, contribution: 3 });
    expect(run(id, state, actor, 'choose-route', { route: 'elite' })).toMatchObject({ ok: true });
    const current = state.runs['3'];
    const playable = current.encounter.hand.findIndex((cardId) => GAME_SYSTEM_CARDS[cardId].cost <= current.energy);
    expect(run(id, state, actor, 'play-card', { handIndex: playable })).toMatchObject({ ok: true });
    expect(current.health).toBeGreaterThan(0);
  });

  it('composes and performs bounded music projects', () => {
    const id = 'music-studio', state = createSpecializedState(id), actor = mobile(4, 'Bard');
    expect(run(id, state, actor, 'set-tempo', { tempo: 140 })).toMatchObject({ ok: true });
    expect(run(id, state, actor, 'set-instrument', { track: 0, instrument: 'harp' })).toMatchObject({ ok: true, stageIndex: 1 });
    for (let beat = 0; beat < 8; beat++) {
      expect(run(id, state, actor, 'add-note', { track: 0, beat, pitch: 60 + beat, length: 1 })).toMatchObject({ ok: true });
    }
    expect(run(id, state, actor, 'perform')).toMatchObject({ ok: true, contribution: 11 });
    expect(state.projects['4']).toMatchObject({ tempo: 140, performances: 1 });
  });

  it('creates, bounds and publishes a mosaic canvas', () => {
    const id = 'painting-and-mosaics', state = createSpecializedState(id), actor = mobile(5, 'Painter');
    expect(run(id, state, actor, 'resize', { width: 999, height: 2 })).toMatchObject({ ok: true });
    expect(state.canvases['5']).toMatchObject({ width: 32, height: 4 });
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      expect(run(id, state, actor, 'paint', { x, y, color: 3 })).toMatchObject({ ok: true });
    }
    expect(run(id, state, actor, 'publish')).toMatchObject({ ok: true, contribution: 16 });
    expect(run(id, state, actor, 'publish')).toMatchObject({ ok: false, error: expect.stringContaining('Change') });
  });

  it('validates reachability before publishing player-authored adventures', () => {
    const id = 'player-authored-adventures', state = createSpecializedState(id), actor = mobile(6, 'Author');
    expect(run(id, state, actor, 'add-node', { id: 'start', kind: 'story', title: 'Start' })).toMatchObject({ ok: true });
    expect(run(id, state, actor, 'add-node', { id: 'ending', kind: 'ending', title: 'End' })).toMatchObject({ ok: true });
    expect(run(id, state, actor, 'publish')).toMatchObject({ ok: false, error: expect.stringContaining('unreachable') });
    expect(run(id, state, actor, 'connect', { from: 'start', to: 'ending' })).toMatchObject({ ok: true });
    expect(run(id, state, actor, 'validate')).toMatchObject({ ok: true, advanceToStage: 2 });
    expect(run(id, state, actor, 'publish')).toMatchObject({ ok: true, contribution: 8 });
    expect(run(id, state, actor, 'publish')).toMatchObject({ ok: false, error: expect.stringContaining('Change') });
  });

  it('keeps replay timelines bounded and viewer state independent', () => {
    const id = 'chronicle-replays', state = createSpecializedState(id);
    for (let index = 0; index < 2_100; index++) appendReplayEvent(state, { at: index, event: 'combat:damage', amount: 1 });
    expect(state.timeline).toHaveLength(2_048);
    const viewer = mobile(7, 'Viewer');
    expect(run(id, state, viewer, 'select-event', { cursor: 2_000 })).toMatchObject({ ok: true, advanceToStage: 1 });
    expect(run(id, state, viewer, 'seek', { cursor: 2_000 })).toMatchObject({ ok: true });
    expect(run(id, state, viewer, 'speed', { speed: 4 })).toMatchObject({ ok: true });
    expect(run(id, state, viewer, 'bookmark', { label: 'Finale' })).toMatchObject({ ok: true });
    expect(publicSpecializedState(id, state, viewer)).toMatchObject({
      viewer: { cursor: 2_000, speed: 4, bookmarks: [{ cursor: 2_000, label: 'Finale' }] },
      timeline: expect.any(Array),
    });
    expect(publicSpecializedState(id, state, viewer).timeline).toHaveLength(256);
    expect(run(id, state, viewer, 'publish')).toMatchObject({ ok: true, completed: true });
    expect(state.viewers['7'].publishedAt).toBe(1_000);
  });

  it('removes private state and safely resets a card match when a player leaves', () => {
    const id = 'collectible-card-game', state = createSpecializedState(id);
    const alice = mobile(1, 'Alice'), bob = mobile(2, 'Bob');
    run(id, state, alice, 'ready'); run(id, state, bob, 'ready');
    expect(state.turn).not.toBe('');

    expect(removeSpecializedParticipant(id, state, alice)).toBe(true);
    expect(state.players['1']).toBeUndefined();
    expect(state.turn).toBe('');
    expect(state.players['2']).toMatchObject({ ready: false, hand: [], deck: [] });
  });

  it('exposes commands for every specialized engine and keeps all state JSON-safe', () => {
    for (const id of ['collectible-card-game', 'deckbuilding-expeditions', 'music-studio',
      'painting-and-mosaics', 'player-authored-adventures', 'chronicle-replays']) {
      expect(specializedCommands(id).length).toBeGreaterThan(1);
      expect(() => JSON.stringify(createSpecializedState(id))).not.toThrow();
    }
  });
});
