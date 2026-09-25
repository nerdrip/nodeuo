import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const saveDir = mkdtempSync(join(tmpdir(), 'nodeuo-startup-'));
const startedAt = Date.now();
let output = '';
let ready = false;
let timedOut = false;
let controlRequest = null;
let controlStatus = null;
let controlError = null;
const controlToken = randomBytes(32).toString('hex');

const childEnv = {
  ...process.env,
  UO_HOST: '127.0.0.1',
  // An ephemeral listener is both faster and collision-free in CI. The
  // production validator keeps rejecting port 0 unless this explicit test
  // capability is present.
  UO_PORT: '0',
  UO_ALLOW_EPHEMERAL_PORT: '1',
  UO_SAVE_DIR: saveDir,
  UO_SAVE_INTERVAL_MS: '0',
  UO_SCRIPT_WATCH: '0',
  UO_SCRIPT_AUDIT: '1',
  UO_SCRIPT_AUDIT_FAIL: '1',
  UO_CONTROL_TOKEN: controlToken,
};
// Empty secret variables are intentionally invalid in production. Remove
// them from the child environment instead of weakening the validator.
delete childEnv.UO_TCP_PORT;
delete childEnv.UO_ADMIN_PORT;
delete childEnv.UO_ADMIN_PASS;

const child = spawn(process.execPath, ['apps/server/src/main.js'], {
  cwd: resolve('.'),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: childEnv,
});

const capture = (chunk) => {
  const text = chunk.toString('utf8');
  output += text;
  process.stdout.write(text);
  if (!ready && /\[uo-node\] ready in /.test(output)) {
    ready = true;
    const port = Number(/\[uo-node\] listening on ws:\/\/[^\s:]+:(\d+)/.exec(output)?.[1]);
    if (!port) {
      controlError = 'ready log did not include the listening port';
      child.kill('SIGTERM');
      return;
    }
    controlRequest = fetch(`http://127.0.0.1:${port}/internal/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${controlToken}` },
      signal: AbortSignal.timeout(10_000),
    }).then((response) => { controlStatus = response.status; })
      .catch((error) => {
        controlError = String(error);
        child.kill('SIGTERM');
      });
  }
};
child.stdout.on('data', capture);
child.stderr.on('data', capture);

const timeout = setTimeout(() => {
  timedOut = true;
  child.kill('SIGKILL');
}, 90_000);

const result = await new Promise((done) => {
  child.once('error', (error) => done({ error: String(error), code: null, signal: null }));
  child.once('exit', (code, signal) => done({ code, signal }));
});
clearTimeout(timeout);
if (controlRequest) await controlRequest;

const duplicateLines = output.split(/\r?\n/).filter((line) => /duplicate registration/i.test(line));
const failedScripts = output.split(/\r?\n/).filter((line) => /scripts ready:.*\b[1-9]\d* failed\b/i.test(line));
const auditFailures = output.split(/\r?\n/).filter((line) => /Script API audit failed/i.test(line));
const registrationWarnings = output.split(/\r?\n/).filter((line) => (
  /recipe .* (?:already belongs|invalid ingredient|invalid output)/i.test(line)
));
const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  startupMs: Date.now() - startedAt,
  ready,
  timedOut,
  exit: result,
  control: {
    status: controlStatus,
    error: controlError,
    finalSaveWritten: /\[uo-node\] final save written/.test(output),
    databaseExists: existsSync(join(saveDir, 'world.sqlite')),
  },
  duplicateRegistrations: duplicateLines,
  failedScripts,
  auditFailures,
  registrationWarnings,
};
mkdirSync(resolve('artifacts'), { recursive: true });
writeFileSync(resolve('artifacts/server-startup-smoke.json'), JSON.stringify(report, null, 2));
try {
  assert.equal(timedOut, false, 'server startup timed out');
  assert.equal(ready, true, 'server never reached ready state');
  assert.equal(controlError, null, 'graceful shutdown request failed');
  assert.equal(controlStatus, 202, 'local control route did not accept shutdown');
  assert.equal(result.code, 0, 'server did not exit cleanly');
  assert.equal(report.control.finalSaveWritten, true, 'final world save was not logged');
  assert.equal(report.control.databaseExists, true, 'world.sqlite was not written');
  assert.deepEqual(duplicateLines, [], 'duplicate command registrations detected');
  assert.deepEqual(failedScripts, [], 'one or more scripts failed to initialise');
  assert.deepEqual(auditFailures, [], 'script API audit failed');
  assert.deepEqual(registrationWarnings, [], 'crafting catalogue registration warnings detected');
  console.log(`[audit:server-startup] ok ${report.startupMs}ms, graceful control shutdown saved world, zero duplicates/failures/warnings`);
} finally {
  rmSync(saveDir, { recursive: true, force: true });
}
