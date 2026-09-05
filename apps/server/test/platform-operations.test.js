import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PlatformOperations } from '../src/systems/platform-operations.js';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function service(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-platform-'));
  temporaryDirectories.push(root);
  const scriptsDir = path.join(root, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(scriptsDir, 'contract.js'), [
    "runtime.emit('city.invasion', { phase: 1 });",
    "runtime.on('city.invasion', (event) => event);",
  ].join('\n'));
  return { root, scriptsDir, platform: new PlatformOperations({ saveDir: root, scriptsDir, ...options }) };
}

describe('durable platform operations', () => {
  it('persists moderation timelines and independently approved change requests', () => {
    const { root, scriptsDir, platform } = service();
    const created = platform.createModerationCase({ reporter: 'alice', category: 'bug', summary: 'Broken gate' });
    expect(created).toMatchObject({ ok: true, case: { status: 'open', reporter: 'alice' } });
    expect(platform.updateModerationCase(created.case.id, {
      status: 'investigating', owner: 'gm', expectedRevision: 1,
    }, 'gm')).toMatchObject({ ok: true, case: { revision: 2, owner: 'gm' } });

    platform.updatePolicy({ approvalsRequired: true, requiredApprovers: 1, actor: 'owner' });
    const requested = platform.requestApproval({
      kind: 'content.release.activate', resource: 'release:summer', summary: 'Publish Summer release',
    }, 'owner');
    expect(platform.decideApproval(requested.approval.id, 'approve', 'owner')).toMatchObject({ ok: false });
    expect(platform.decideApproval(requested.approval.id, 'approve', 'reviewer')).toMatchObject({
      ok: true, approval: { status: 'approved' },
    });
    expect(platform.authorizeApproval('', {
      kind: 'content.release.activate', resource: 'release:summer', actor: 'owner',
    })).toMatchObject({ ok: true, approval: { status: 'consumed' } });

    const reloaded = new PlatformOperations({ saveDir: root, scriptsDir });
    expect(reloaded.listModerationCases().cases[0]).toMatchObject({ id: created.case.id, status: 'investigating' });
    expect(reloaded.listApprovals().approvals[0]).toMatchObject({ status: 'consumed', consumedBy: 'owner' });
  });

  it('keeps preview mutations isolated and resolves real event contracts', () => {
    const { platform } = service();
    const preview = platform.startPreview({ actor: 'gm', resources: ['script:contract.js'], baseline: { revision: 4 } });
    const sessionId = preview.session.sessionId;
    expect(platform.mutatePreview(sessionId, [{
      resource: 'script:contract.js', operation: 'merge', value: { enabled: true },
    }], 'gm')).toMatchObject({ ok: true, session: { isolated: true, externalEffects: false, revision: 2 } });
    expect(platform.simulatePreview(sessionId, 'city.invasion', { phase: 2 }, 'intruder'))
      .toMatchObject({ ok: false, error: 'preview session owner mismatch' });
    expect(platform.simulatePreview(sessionId, 'city.invasion', { phase: 2 }, 'gm')).toMatchObject({
      ok: true, result: { event: 'city.invasion', externalEffects: false, deterministic: true,
        matchedConsumers: ['contract.js'] },
    });
    expect(platform.eventContracts().contracts).toContainEqual({
      id: 'city.invasion', producers: ['contract.js'], consumers: ['contract.js'], status: 'connected',
    });
    expect(platform.endPreview(sessionId, 'gm')).toMatchObject({ ok: true, ended: true });
  });

  it('authors revision-safe phased live events', () => {
    const emitted = []; const { platform } = service({ emitEvent: (name, payload) => emitted.push([name, payload]) });
    const created = platform.upsertLiveEvent({ id: 'weekend-invasion', title: 'Weekend invasion', phases: [
      { id: 'warning', label: 'Warning' }, { id: 'assault', label: 'Assault' },
    ] }, 'gm');
    expect(created).toMatchObject({ ok: true, event: { revision: 1, status: 'draft', currentPhase: 'warning' } });
    expect(platform.transitionLiveEvent('weekend-invasion', {
      status: 'active', phase: 'assault', expectedRevision: 1,
    }, 'gm')).toMatchObject({ ok: true, event: { revision: 2, status: 'active', currentPhase: 'assault' } });
    expect(emitted.map(([name]) => name)).toEqual(['live-event:updated', 'live-event:transition']);
    expect(platform.transitionLiveEvent('weekend-invasion', { status: 'completed', expectedRevision: 1 }, 'gm'))
      .toMatchObject({ ok: false, conflict: true, revision: 2 });
  });
});
