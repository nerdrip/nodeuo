import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import process from 'node:process';

let cachedPnpmCli;

function findPnpmCli() {
  if (cachedPnpmCli !== undefined) return cachedPnpmCli;

  const roots = new Set([
    dirname(process.execPath),
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean),
  ]);
  const relatives = [
    join('node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    join('node_modules', 'corepack', 'dist', 'pnpm.js'),
  ];

  for (const root of roots) {
    for (const relative of relatives) {
      const candidate = join(root, relative);
      if (existsSync(candidate)) {
        cachedPnpmCli = candidate;
        return candidate;
      }
    }
  }

  cachedPnpmCli = null;
  return null;
}

/** Build a cross-platform pnpm child-process invocation without shell:true. */
export function pnpmProcess(args) {
  const cli = findPnpmCli();
  if (cli) return { bin: process.execPath, args: [cli, ...args] };
  if (process.platform === 'win32') {
    // cmd.exe is required only for a PATH-provided pnpm.cmd fallback. Arguments
    // originate from the audit definitions, never from untrusted input.
    return {
      bin: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm', ...args],
    };
  }
  return { bin: 'pnpm', args };
}
