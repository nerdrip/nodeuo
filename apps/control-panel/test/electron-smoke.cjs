const { spawnSync } = require('node:child_process');
const path = require('node:path');

const electron = require('electron');
const appRoot = path.resolve(__dirname, '..');
const childEnv = { ...process.env, UO_CONTROL_PANEL_SMOKE: '1' };
delete childEnv.ELECTRON_RUN_AS_NODE;
const result = spawnSync(electron, ['.'], {
  cwd: appRoot,
  env: childEnv,
  encoding: 'utf8',
  windowsHide: true,
  timeout: 30_000,
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) {
  console.error(`[control-panel-smoke] launch failed: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
