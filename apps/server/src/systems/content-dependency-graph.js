import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.json']);
const ASSET_PATTERN = /['"`]([^'"`\n]{1,300}\.(?:png|webp|avif|ktx2|json|bin|dat|mul|uop|wav|ogg|mp3|flac))['"`]/gi;
const IMPORT_PATTERN = /(?:import|export)\s+(?:[^'"`]*?\s+from\s+)?['"`]([^'"`]+)['"`]|import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;

function slash(value) { return String(value).replace(/\\/g, '/'); }

function walk(root, maxFiles) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const directory = stack.pop();
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(absolute);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(absolute);
      if (out.length >= maxFiles) break;
    }
  }
  return out;
}

function resolveImport(root, from, specifier) {
  if (!specifier.startsWith('.')) return `package:${specifier}`;
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, `${base}.json`, path.join(base, 'index.js')]) {
    if (!candidate.startsWith(`${root}${path.sep}`) && candidate !== root) continue;
    try { if (fs.statSync(candidate).isFile()) return `script:${slash(path.relative(root, candidate))}`; } catch { /* next */ }
  }
  return `unresolved:${slash(path.relative(root, base))}`;
}

function addEdge(edges, reverse, from, to, kind) {
  const key = `${to}\0${kind}`;
  let outgoing = edges.get(from);
  if (!outgoing) { outgoing = new Map(); edges.set(from, outgoing); }
  outgoing.set(key, { to, kind });
  let incoming = reverse.get(to);
  if (!incoming) { incoming = new Set(); reverse.set(to, incoming); }
  incoming.add(from);
}

function findCycles(edges, max = 128) {
  const cycles = [];
  const visiting = new Set(); const visited = new Set(); const stack = [];
  const visit = (node) => {
    if (cycles.length >= max || visited.has(node)) return;
    if (visiting.has(node)) {
      const index = stack.indexOf(node);
      cycles.push([...stack.slice(Math.max(0, index)), node]);
      return;
    }
    visiting.add(node); stack.push(node);
    for (const edge of edges.get(node)?.values?.() ?? []) {
      if (edge.to.startsWith('script:')) visit(edge.to);
    }
    stack.pop(); visiting.delete(node); visited.add(node);
  };
  for (const node of edges.keys()) visit(node);
  return cycles;
}

export class ContentDependencyGraph {
  constructor({ scriptsDir, assetsDir, maxFiles = 20_000, maxSourceBytes = 2 * 1024 * 1024 } = {}) {
    this.scriptsDir = path.resolve(scriptsDir);
    this.assetsDir = assetsDir ? path.resolve(assetsDir) : null;
    this.maxFiles = Math.max(100, Math.min(100_000, Number(maxFiles) | 0));
    this.maxSourceBytes = Math.max(64 * 1024, Math.min(8 * 1024 * 1024, Number(maxSourceBytes) | 0));
    this.cache = null;
    this.invalidatedAt = Date.now();
  }

  invalidate(reason = 'content-changed') {
    this.cache = null;
    this.invalidatedAt = Date.now();
    this.invalidateReason = String(reason).slice(0, 96);
  }

  rebuild() {
    const started = performance.now();
    const nodes = new Map(); const edges = new Map(); const reverse = new Map(); const unresolved = [];
    const files = walk(this.scriptsDir, this.maxFiles);
    for (const absolute of files) {
      let stat; let source;
      try {
        stat = fs.statSync(absolute);
        if (stat.size > this.maxSourceBytes) continue;
        source = fs.readFileSync(absolute, 'utf8');
      } catch { continue; }
      const rel = slash(path.relative(this.scriptsDir, absolute));
      const id = `script:${rel}`;
      nodes.set(id, { id, kind: 'script', path: rel, bytes: stat.size, mtime: Math.trunc(stat.mtimeMs) });
      if (/\.(?:js|mjs)$/i.test(rel)) {
        for (const match of source.matchAll(IMPORT_PATTERN)) {
          const specifier = match[1] ?? match[2];
          const target = resolveImport(this.scriptsDir, absolute, specifier);
          addEdge(edges, reverse, id, target, 'import');
          if (target.startsWith('unresolved:')) unresolved.push({ from: id, specifier, target });
          if (target.startsWith('package:') && !nodes.has(target)) nodes.set(target, { id: target, kind: 'package' });
        }
      }
      for (const match of source.matchAll(ASSET_PATTERN)) {
        const raw = slash(match[1]).replace(/^\.\//, '');
        const target = `asset:${raw}`;
        let present = null;
        if (this.assetsDir) {
          const candidate = path.resolve(this.assetsDir, raw.replace(/^assets\//, ''));
          present = candidate.startsWith(`${this.assetsDir}${path.sep}`) && fs.existsSync(candidate);
        }
        if (!nodes.has(target)) nodes.set(target, { id: target, kind: 'asset', path: raw, present });
        addEdge(edges, reverse, id, target, 'asset');
      }
    }
    const rows = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
    const links = [...edges].flatMap(([from, targets]) => [...targets.values()].map((edge) => ({ from, ...edge })))
      .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ rows, links })).digest('hex');
    this.cache = {
      revision: `sha256:${fingerprint}`, generatedAt: Date.now(),
      durationMs: Number((performance.now() - started).toFixed(3)),
      nodes, edges, reverse, rows, links, unresolved: unresolved.slice(0, 1000),
      cycles: findCycles(edges), truncated: files.length >= this.maxFiles,
    };
    return this.cache;
  }

  _value() { return this.cache ?? this.rebuild(); }

  impact(nodeLike, depth = 6) {
    const value = this._value();
    const raw = String(nodeLike ?? '').replace(/\\/g, '/');
    const node = value.nodes.has(raw) ? raw : value.nodes.has(`script:${raw}`) ? `script:${raw}` : raw;
    if (!value.nodes.has(node)) return { ok: false, error: 'dependency node not found', node };
    const boundedDepth = Math.max(1, Math.min(16, Number(depth) | 0 || 6));
    const traverse = (start, adjacency, direction) => {
      const seen = new Set([start]); const queue = [{ id: start, depth: 0 }]; const rows = [];
      for (let index = 0; index < queue.length && rows.length < 5000; index++) {
        const current = queue[index];
        if (current.depth >= boundedDepth) continue;
        const targets = adjacency === value.reverse
          ? [...(adjacency.get(current.id) ?? [])].map((id) => ({ id, kind: direction }))
          : [...(adjacency.get(current.id)?.values?.() ?? [])].map((entry) => ({ id: entry.to, kind: entry.kind }));
        for (const target of targets) {
          if (seen.has(target.id)) continue;
          seen.add(target.id); const row = { id: target.id, depth: current.depth + 1, kind: target.kind };
          rows.push(row); queue.push(row);
        }
      }
      return rows;
    };
    const dependencies = traverse(node, value.edges, 'dependency');
    const dependents = traverse(node, value.reverse, 'dependent');
    return { ok: true, node, revision: value.revision, dependencies, dependents,
      blastRadius: dependents.length, restartSuggested: dependents.some((row) => row.id.startsWith('script:')) };
  }

  snapshot({ includeGraph = false } = {}) {
    const value = this._value();
    return {
      revision: value.revision, generatedAt: value.generatedAt, durationMs: value.durationMs,
      counts: {
        nodes: value.rows.length, links: value.links.length,
        scripts: value.rows.filter((node) => node.kind === 'script').length,
        assets: value.rows.filter((node) => node.kind === 'asset').length,
        packages: value.rows.filter((node) => node.kind === 'package').length,
      },
      unresolved: value.unresolved, cycles: value.cycles, truncated: value.truncated,
      ...(includeGraph ? { nodes: value.rows, links: value.links } : {}),
    };
  }
}
