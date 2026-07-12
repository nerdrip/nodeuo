// Helper for the optional KTX2/Basis toolchain.
//
// `ktx2.js` needs the Khronos `toktx` encoder. This file centralises:
//   - locating `toktx` in PATH, Settings, Program Files, or repo-local tools/
//   - a Windows installer path used by the Control Panel "Install KTX2 Tool"

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const LOCAL_TOOL_ROOT = join(REPO_ROOT, 'tools', 'ktx-software');
const CACHE_ROOT = join(REPO_ROOT, 'tools', '.cache', 'ktx-software');
const RELEASE_API = 'https://api.github.com/repos/KhronosGroup/KTX-Software/releases/latest';
const RELEASE_PAGE = 'https://github.com/KhronosGroup/KTX-Software/releases/latest';

export function findToktx(preferred = '') {
  const raw = String(preferred || process.env.KTX2_TOKTX || '').trim();
  const checked = [];

  const tryFile = (p) => {
    if (!p) return null;
    checked.push(p);
    if (existsSync(p)) return p;
    return null;
  };

  if (raw) {
    if (/[\\/]/.test(raw) || /\.exe$/i.test(raw)) {
      const direct = tryFile(resolve(raw));
      if (direct) return { command: direct, source: 'configured path', checked };
    } else if (canRun(raw)) {
      return { command: raw, source: 'configured command', checked };
    }
  }

  if (canRun('toktx')) return { command: 'toktx', source: 'PATH', checked };

  for (const dir of candidateRoots()) {
    const found = findFileDeep(dir, 'toktx.exe', 5, checked);
    if (found) return { command: found, source: dir, checked };
  }

  return { command: null, source: null, checked };
}

export function ktx2InstallHint() {
  return [
    '[ktx2] toktx is not available.',
    '[ktx2] In Control Panel use TOOLS -> Install KTX2 Tool, or set Settings -> KTX2 toktx.',
    `[ktx2] Manual download: ${RELEASE_PAGE}`,
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.check) {
    const found = findToktx(args.toktx);
    if (!found.command) {
      console.error(ktx2InstallHint());
      process.exit(2);
    }
    printVersion(found.command, found.source);
    return;
  }
  if (args.install) {
    await installToktx();
    return;
  }
  console.log('usage: node packages/extractor/ktx2-tool.js --check | --install');
}

async function installToktx() {
  const existing = findToktx();
  if (existing.command) {
    printVersion(existing.command, existing.source);
    console.log('[ktx2-tool] already installed');
    return;
  }

  if (process.platform !== 'win32') {
    console.error('[ktx2-tool] automatic install is Windows-only for now.');
    console.error(`[ktx2-tool] Download KTX-Software from ${RELEASE_PAGE}`);
    process.exit(2);
  }

  mkdirSync(CACHE_ROOT, { recursive: true });
  mkdirSync(LOCAL_TOOL_ROOT, { recursive: true });

  console.log('[ktx2-tool] fetching latest Khronos KTX-Software release metadata...');
  const release = await fetchJson(RELEASE_API);
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const asset = release.assets?.find((a) => new RegExp(`Windows-${arch}\\.exe$`, 'i').test(a.name));
  if (!asset?.browser_download_url) {
    console.error(`[ktx2-tool] no Windows-${arch} installer found in ${release.html_url || RELEASE_PAGE}`);
    process.exit(2);
  }

  const installerPath = join(CACHE_ROOT, asset.name);
  if (!existsSync(installerPath)) {
    console.log(`[ktx2-tool] downloading ${asset.name}...`);
    await downloadFile(asset.browser_download_url, installerPath);
  } else {
    console.log(`[ktx2-tool] using cached installer: ${installerPath}`);
  }

  console.log(`[ktx2-tool] running installer into ${LOCAL_TOOL_ROOT}`);
  console.log('[ktx2-tool] Windows may ask for confirmation/elevation.');
  const install = spawnSync(installerPath, ['/S', `/D=${LOCAL_TOOL_ROOT}`], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    windowsHide: false,
  });
  if (install.error || install.status !== 0) {
    console.error(`[ktx2-tool] installer failed (exit ${install.status ?? install.signal ?? '?'})`);
    console.error(`[ktx2-tool] You can run manually: "${installerPath}"`);
    process.exit(install.status || 1);
  }

  const found = findToktx();
  if (!found.command) {
    console.error('[ktx2-tool] installer finished, but toktx.exe was not found.');
    console.error(`[ktx2-tool] If it installed elsewhere, set Settings -> KTX2 toktx to the toktx.exe path.`);
    process.exit(2);
  }

  printVersion(found.command, found.source);
  console.log('[ktx2-tool] ready');
}

function printVersion(command, source) {
  const r = spawnSync(command, ['--version'], { encoding: 'utf8' });
  const version = `${r.stdout || ''}${r.stderr || ''}`.trim().split(/\r?\n/)[0] || 'version unavailable';
  console.log(`[ktx2-tool] toktx: ${command}`);
  console.log(`[ktx2-tool] source: ${source}`);
  console.log(`[ktx2-tool] ${version}`);
}

function canRun(command) {
  const r = spawnSync(command, ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

function candidateRoots() {
  const roots = [
    LOCAL_TOOL_ROOT,
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'KTX-Software'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Khronos Group', 'KTX-Software'),
    process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'KTX-Software'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'KTX-Software'),
  ].filter(Boolean);
  return [...new Set(roots)];
}

function findFileDeep(root, fileName, depth, checked) {
  if (!root || depth < 0 || !existsSync(root)) return null;
  checked?.push(root);
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return full;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === '.' || entry.name === '..') continue;
    const found = findFileDeep(join(root, entry.name), fileName, depth - 1, checked);
    if (found) return found;
  }
  return null;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'uo-node-control-panel' } });
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  return res.json();
}

async function downloadFile(url, path) {
  const res = await fetch(url, { headers: { 'User-Agent': 'uo-node-control-panel' } });
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  writeFileSync(path, bytes);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    out[k] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error('[ktx2-tool] failed');
    console.error(error?.stack || error?.message || error);
    process.exit(1);
  });
}
