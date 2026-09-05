import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerNodeUORoutes } from '../src/admin/nodeuo-routes.js';
import { PlatformOperations } from '../src/systems/platform-operations.js';

const temporaryDirectories = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('admin change approval enforcement', () => {
  it('consumes one independently approved request in the real rollout route', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-approval-route-'));
    temporaryDirectories.push(root); const scriptsDir = path.join(root, 'scripts'); fs.mkdirSync(scriptsDir);
    const platformOperations = new PlatformOperations({ saveDir: root, scriptsDir });
    platformOperations.updatePolicy({ approvalsRequired: true, requiredApprovers: 1, actor: 'owner' });
    const publish = vi.fn(() => ({ ok: true, revision: 5 }));
    const routes = [];
    registerNodeUORoutes(routes, { platformOperations, featureRollouts: { publish }, connections: new Set() });
    const route = routes.find((entry) => entry.method === 'POST' && entry.path === '/api/nodeuo/rollouts/publish');
    const request = { body: { expectedRevision: 4 }, session: { account: 'owner' } };
    expect(route.run(request)).toMatchObject({ ok: false, error: 'approved change request is required' });
    expect(publish).not.toHaveBeenCalled();

    const approval = platformOperations.requestApproval({
      kind: 'protocol.rollout.publish', resource: 'revision:4', summary: 'Publish reviewed rollout',
    }, 'owner');
    platformOperations.decideApproval(approval.approval.id, 'approve', 'reviewer');
    expect(route.run(request)).toMatchObject({ ok: true, revision: 5, renegotiationOffered: 0 });
    expect(publish).toHaveBeenCalledOnce();
    expect(route.run(request)).toMatchObject({ ok: false, error: 'approved change request is required' });
  });
});
