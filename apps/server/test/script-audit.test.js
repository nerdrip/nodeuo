import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadScripts } from '../src/scripts.js';

function makeScriptDir(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uo-script-audit-'));
  fs.writeFileSync(path.join(dir, 'missing-api.js'), source);
  return dir;
}

describe('script API audit', () => {
  it('records missing API warnings without failing when failOnWarnings is false', async () => {
    const dir = makeScriptDir(`
      export default function(api) {
        api.log('test-script: engine API missing, skipping');
      }
    `);
    try {
      const runtime = await loadScripts(dir, {
        log() {},
        scriptAudit: { enabled: true, failOnWarnings: false },
      });
      expect(runtime.audit.warnings).toHaveLength(1);
      expect(runtime.audit.warnings[0]).toMatchObject({
        label: 'missing-api.js',
        message: 'test-script: engine API missing, skipping',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails startup when script audit is enabled and a core script silently skips', async () => {
    const dir = makeScriptDir(`
      export default function(api) {
        api.log('cmd/example: missing api deps; skipping');
      }
    `);
    try {
      await expect(loadScripts(dir, {
        log() {},
        scriptAudit: { enabled: true, failOnWarnings: true },
      })).rejects.toThrow(/Script API audit failed/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records missing nested API capabilities read by scripts', async () => {
    const dir = makeScriptDir(`
      export default function(api) {
        api.systems?.missingService?.open?.();
        api.game?.mobile?.giveItem?.({});
      }
    `);
    try {
      const runtime = await loadScripts(dir, {
        log() {},
        systems: {},
        game: { mobile: {} },
        scriptAudit: { enabled: true, failOnWarnings: false },
      });
      expect(runtime.audit.missingCapabilities).toEqual(expect.arrayContaining([
        { label: 'missing-api.js', path: 'api.systems.missingService' },
        { label: 'missing-api.js', path: 'api.game.mobile.giveItem' },
      ]));
      expect(runtime.audit.report().summary.missingCapabilities).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
