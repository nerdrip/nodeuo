import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { World } from '../src/world/world.js';
import { AIScheduler } from '../src/world/ai.js';
import { AIBehaviorGraphRegistry, validateAIGraph } from '../src/world/ai-graphs.js';

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const world = new World();
  const ai = new AIScheduler(world, {
    mobileMovingPacket: () => new Uint8Array(), unicodeSpeechPacket: () => new Uint8Array(),
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-ai-'));
  dirs.push(dir);
  return { world, ai, registry: new AIBehaviorGraphRegistry(ai, dir), dir };
}

const graph = {
  id: 'hunter', name: 'Hunter', start: 'start', nodes: [
    { id: 'start', type: 'start', next: 'find' },
    { id: 'find', type: 'acquire-player', next: 'wait', fail: 'end', params: { range: 12 } },
    { id: 'wait', type: 'wait', next: 'end', params: { ms: 50 } },
    { id: 'end', type: 'end' },
  ],
};

describe('visual AI behavior graphs', () => {
  it('rejects dangling edges and unknown executable node types', () => {
    expect(validateAIGraph({ id: 'bad', start: 'x', nodes: [{ id: 'x', type: 'eval-js', next: 'missing' }] })).toMatchObject({ ok: false });
  });

  it('persists, hot-registers and attaches a data-only graph', () => {
    const { world, ai, registry, dir } = setup();
    expect(registry.save(graph).ok).toBe(true);
    expect(fs.existsSync(path.join(dir, 'ai-graphs.json'))).toBe(true);
    expect(ai.behaviors.has('graph:hunter')).toBe(true);
    const npc = world.createMobile({ name: 'hunter', x: 100, y: 100, map: 1 });
    const player = world.createMobile({ name: 'player', x: 102, y: 100, map: 1 });
    player.client = { send() {} };
    expect(registry.attach(npc, 'hunter')).toBe(true);
    ai._tickAll();
    expect(ai.bindings.get(npc.serial).state.targetSerial).toBe(player.serial);
  });

  it('loads validated graphs after restart', () => {
    const first = setup(); first.registry.save(graph);
    const secondAi = new AIScheduler(first.world, {
      mobileMovingPacket: () => new Uint8Array(), unicodeSpeechPacket: () => new Uint8Array(),
    });
    const restored = new AIBehaviorGraphRegistry(secondAi, first.dir);
    expect(restored.load()).toBe(1);
    expect(restored.get('hunter')?.name).toBe('Hunter');
  });
});
