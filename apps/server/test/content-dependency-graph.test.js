import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContentDependencyGraph } from '../src/systems/content-dependency-graph.js';

const created = [];
afterEach(() => {
  for (const directory of created.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('content dependency graph', () => {
  it('finds imports, assets, unresolved edges and reverse impact', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-graph-')); created.push(root);
    const scripts = path.join(root, 'scripts'); const assets = path.join(root, 'assets');
    fs.mkdirSync(path.join(scripts, 'domain'), { recursive: true }); fs.mkdirSync(assets);
    fs.writeFileSync(path.join(assets, 'icon.png'), 'x');
    fs.writeFileSync(path.join(scripts, 'shared.js'), 'export const value = 1;');
    fs.writeFileSync(path.join(scripts, 'domain', 'entry.js'), "import { value } from '../shared.js'; import './missing.js'; export const icon = 'icon.png'; void value;");
    const graph = new ContentDependencyGraph({ scriptsDir: scripts, assetsDir: assets });
    const snapshot = graph.snapshot({ includeGraph: true });
    expect(snapshot.counts.scripts).toBe(2);
    expect(snapshot.unresolved).toHaveLength(1);
    expect(snapshot.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'asset:icon.png', present: true }),
    ]));
    expect(graph.impact('shared.js')).toMatchObject({ ok: true, blastRadius: 1 });
  });
});
