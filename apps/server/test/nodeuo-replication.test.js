import { describe, expect, it } from 'vitest';
import { NodeUOFeature } from '@uo/nodeuo-protocol';
import { installNodeUOReplication } from '../src/systems/nodeuo-replication.js';
import { EntityDirty, InterestManager } from '../src/world/interest-management.js';

describe('NodeUO interest replication', () => {
  it('coalesces scripted position changes into visible negotiated deltas only', async () => {
    const entity = { serial: 2, body: 17, x: 14, y: 20, z: 1, map: 1, direction: 3 };
    const interest = new InterestManager();
    const world = { interest, mobiles: new Map([[entity.serial, entity]]), items: new Map() };
    const sent = [];
    const enhanced = {
      mobile: { serial: 1 }, ctx: { world }, _visibleMobiles: new Set([entity.serial]),
      _nodeUOWorld: { ready: true, baseline: 7, sequence: 4, acknowledged: 3, sent: 0 },
      nodeUOJsonTransport: true, nodeUOFeatures: new Map([[NodeUOFeature.WorldDelta, 1]]),
      supportsNodeUO: (capability) => capability === NodeUOFeature.WorldDelta,
      sendNodeUOMessage: (message) => { sent.push(message); return true; },
    };
    const classic = { mobile: { serial: 3 }, _visibleMobiles: new Set([entity.serial]),
      supportsNodeUO: () => false, send: () => { throw new Error('private delta reached classic client'); } };
    const replication = installNodeUOReplication({ world, connections: new Set([enhanced, classic]) });

    interest.mark(entity.serial, EntityDirty.Position, 'mobile');
    entity.x = 15;
    interest.mark(entity.serial, EntityDirty.Position, 'mobile');
    await new Promise((resolve) => setImmediate(resolve));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      feature: NodeUOFeature.WorldDelta,
      payload: { baseline: 7, entities: [{ serial: 2,
        components: { position: { x: 15, y: 20 } } }] },
    });
    expect(replication.diagnostics()).toMatchObject({
      pending: 0, scheduled: false, drains: 1, dirtyRows: 1,
      viewerRows: 2, classicSkipped: 1, jsonBatches: 1,
    });
    replication.close();
  });
});
