import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const saveDir = mkdtempSync(join(tmpdir(), 'nodeuo-startup-'));
const startedAt = Date.now();
let output = '';
let ready = false;
let timedOut = false;

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
    child.kill('SIGTERM');
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
  assert.deepEqual(duplicateLines, [], 'duplicate command registrations detected');
  assert.deepEqual(failedScripts, [], 'one or more scripts failed to initialise');
  assert.deepEqual(auditFailures, [], 'script API audit failed');
  assert.deepEqual(registrationWarnings, [], 'crafting catalogue registration warnings detected');
  console.log(`[audit:server-startup] ok ${report.startupMs}ms, zero duplicates/failures/warnings`);
} finally {
  rmSync(saveDir, { recursive: true, force: true });
}
