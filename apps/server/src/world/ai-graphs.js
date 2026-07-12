import fs from 'node:fs';
import path from 'node:path';

export const AI_GRAPH_NODE_TYPES = Object.freeze([
  'start', 'target-exists', 'target-in-range', 'acquire-player',
  'move-to-target', 'wander', 'wait', 'say', 'set-state',
  'clear-target', 'end',
]);

function id(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 64);
}

export function validateAIGraph(raw) {
  const errors = [];
  const graphId = id(raw?.id);
  if (!graphId) errors.push('Graph id is required.');
  const nodes = Array.isArray(raw?.nodes) ? raw.nodes.slice(0, 64) : [];
  if (nodes.length === 0) errors.push('At least one node is required.');
  const ids = new Set();
  for (const entry of nodes) {
    const nodeId = id(entry?.id);
    if (!nodeId) errors.push('Every node needs an id.');
    else if (ids.has(nodeId)) errors.push(`Duplicate node id: ${nodeId}.`);
    ids.add(nodeId);
    if (!AI_GRAPH_NODE_TYPES.includes(entry?.type)) errors.push(`Unknown node type: ${entry?.type}.`);
  }
  const start = id(raw?.start ?? nodes[0]?.id);
  if (!ids.has(start)) errors.push('Start node does not exist.');
  for (const entry of nodes) {
    for (const edge of ['next', 'yes', 'no', 'fail']) {
      const ref = id(entry?.[edge]);
      if (ref && !ids.has(ref)) errors.push(`${id(entry.id)}.${edge} points to missing node ${ref}.`);
    }
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    graph: {
      version: 1, id: graphId, name: String(raw?.name ?? graphId).slice(0, 80), start,
      nodes: nodes.map((entry) => ({
        id: id(entry.id), type: entry.type,
        next: id(entry.next), yes: id(entry.yes), no: id(entry.no), fail: id(entry.fail),
        params: entry.params && typeof entry.params === 'object' && !Array.isArray(entry.params)
          ? JSON.parse(JSON.stringify(entry.params)) : {},
      })),
    },
  };
}

function nearestPlayer(world, mob, range) {
  let best = null, bestDistance = Infinity;
  const visit = (other) => {
    if (!other?.client || other.dead || other.map !== mob.map) return;
    const distance = Math.max(Math.abs(other.x - mob.x), Math.abs(other.y - mob.y));
    if (distance <= range && distance < bestDistance) { best = other; bestDistance = distance; }
  };
  if (world.forEachMobileNear) world.forEachMobileNear(mob.x, mob.y, mob.map, range, true, visit);
  else for (const other of world.mobiles.values()) visit(other);
  return best;
}

function directionTo(mob, target) {
  const dx = Math.sign((target.x | 0) - (mob.x | 0));
  const dy = Math.sign((target.y | 0) - (mob.y | 0));
  const key = `${dx},${dy}`;
  return ({ '0,-1': 0, '1,-1': 1, '1,0': 2, '1,1': 3, '0,1': 4, '-1,1': 5, '-1,0': 6, '-1,-1': 7 })[key] ?? 0;
}

export class AIBehaviorGraphRegistry {
  constructor(scheduler, saveDir) {
    this.scheduler = scheduler;
    this.file = path.join(saveDir, 'ai-graphs.json');
    this.graphs = new Map();
  }

  load() {
    if (!fs.existsSync(this.file)) return 0;
    const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    for (const raw of parsed?.graphs ?? []) {
      const checked = validateAIGraph(raw);
      if (checked.ok) this._install(checked.graph);
    }
    return this.graphs.size;
  }

  list() { return [...this.graphs.values()].map((graph) => ({ ...graph, nodes: graph.nodes.map((node) => ({ ...node })) })); }
  get(graphId) { return this.graphs.get(id(graphId)) ?? null; }

  save(raw) {
    const checked = validateAIGraph(raw);
    if (!checked.ok) return checked;
    this._install(checked.graph);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, graphs: this.list() }, null, 2));
    fs.renameSync(tmp, this.file);
    return { ok: true, graph: checked.graph };
  }

  delete(graphId) {
    const graph = this.graphs.get(id(graphId));
    if (!graph) return false;
    this.graphs.delete(graph.id);
    this.scheduler.unregisterBehavior(`graph:${graph.id}`);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ version: 1, graphs: this.list() }, null, 2));
    return true;
  }

  attach(mob, graphId) {
    const graph = this.get(graphId);
    if (!mob || !graph) return false;
    mob.aiBehavior = `graph:${graph.id}`;
    this.scheduler.attach(mob, mob.aiBehavior, { graphNode: graph.start, targetSerial: 0, values: {} });
    return true;
  }

  _install(graph) {
    this.graphs.set(graph.id, graph);
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const scheduler = this.scheduler;
    scheduler.registerBehavior({
      name: `graph:${graph.id}`,
      initState: () => ({ graphNode: graph.start, targetSerial: 0, values: {} }),
      tick(ctx, mob, state) {
        state.values ??= {};
        for (let transitions = 0; transitions < 8; transitions++) {
          const current = byId.get(state.graphNode) ?? byId.get(graph.start);
          if (!current) return;
          const target = ctx.world.mobiles.get(state.targetSerial >>> 0);
          const advance = (edge = 'next') => { state.graphNode = current[edge] || graph.start; };
          switch (current.type) {
            case 'start': advance(); break;
            case 'target-exists': advance(target && !target.dead ? 'yes' : 'no'); break;
            case 'target-in-range': {
              const range = Math.max(1, Math.min(30, current.params.range | 0 || 1));
              const near = target && target.map === mob.map
                && Math.max(Math.abs(target.x - mob.x), Math.abs(target.y - mob.y)) <= range;
              advance(near ? 'yes' : 'no'); break;
            }
            case 'acquire-player': {
              const found = nearestPlayer(ctx.world, mob, Math.max(1, Math.min(30, current.params.range | 0 || 12)));
              state.targetSerial = found?.serial >>> 0 || 0; mob.combatant = state.targetSerial;
              advance(found ? 'next' : 'fail'); break;
            }
            case 'move-to-target': {
              if (!target || target.map !== mob.map) { advance('fail'); break; }
              const stop = Math.max(0, current.params.stopRange | 0 || 1);
              const distance = Math.max(Math.abs(target.x - mob.x), Math.abs(target.y - mob.y));
              if (distance <= stop) { advance(); break; }
              const direction = directionTo(mob, target);
              if (scheduler.stepMobile(mob, direction)) ctx.broadcastMove(mob);
              else {
                const path = scheduler.findPath(mob, target.x, target.y, { maxNodes: 512 });
                if (path?.length && scheduler.stepMobile(mob, path[0])) ctx.broadcastMove(mob);
              }
              return;
            }
            case 'wander': {
              const direction = Math.floor(Math.random() * 8);
              if (scheduler.stepMobile(mob, direction)) ctx.broadcastMove(mob);
              advance(); return;
            }
            case 'wait': {
              const duration = Math.max(50, Math.min(60_000, current.params.ms | 0 || 500));
              if (!state.wakeAt) state.wakeAt = ctx.now + duration;
              if (ctx.now < state.wakeAt) return;
              state.wakeAt = 0; advance(); break;
            }
            case 'say': ctx.broadcastSpeech(mob, String(current.params.text ?? '').slice(0, 120)); advance(); break;
            case 'set-state': state.values[String(current.params.key ?? 'value').slice(0, 40)] = current.params.value; advance(); break;
            case 'clear-target': state.targetSerial = 0; mob.combatant = 0; advance(); break;
            case 'end': state.graphNode = graph.start; return;
            default: return;
          }
        }
      },
    });
  }
}
