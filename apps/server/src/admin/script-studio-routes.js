import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { flattenScriptTree, safeJoin, walkScriptTree } from './route-helpers.js';

const MAX_SOURCE_BYTES = 1024 * 1024;
const ACCESS = new Set(['Player', 'Counselor', 'Seer', 'GM', 'Admin']);
const IDENTIFIER = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/;
const ITEM_HOOKS = Object.freeze([
  'onUse', 'onEquip', 'onUnequip', 'onWalkOn', 'onWalkOff',
  'onDrop', 'onPickUp', 'onCreate', 'onDestroy', 'onTick',
]);
const MOBILE_EVENTS = Object.freeze([
  'mobile:created', 'mobile:killed', 'combat:hit', 'player:login', 'player:logout',
]);
const WORLD_EVENTS = Object.freeze([
  ...MOBILE_EVENTS, 'item:created', 'item:destroyed', 'world:saved',
  'placemulti:request', 'content:reloaded',
]);

export const SCRIPT_STUDIO_TYPES = Object.freeze([
  { id: 'item', label: 'Item behavior', path: 'authored/items', hooks: ITEM_HOOKS,
    description: 'Double-click, equipment, tile, drop, creation, destruction and opt-in tick hooks.' },
  { id: 'mobile', label: 'Mobile hooks', path: 'authored/mobiles', hooks: MOBILE_EVENTS,
    description: 'Lifecycle and combat reactions filtered to one mobile template kind.' },
  { id: 'ai', label: 'AI behavior', path: 'authored/ai', hooks: ['tick'],
    description: 'A real scheduler behavior attachable from a monster or NPC definition.' },
  { id: 'command', label: 'Command', path: 'authored/commands', hooks: ['run'],
    description: 'A command with access control, aliases, help and lifecycle ownership.' },
  { id: 'region', label: 'Region boundary', path: 'authored/regions', hooks: ['onEnter', 'onLeave'],
    description: 'Run logic when a mobile enters or leaves a named town, dungeon or custom region.' },
  { id: 'event', label: 'World event', path: 'authored/events', hooks: WORLD_EVENTS,
    description: 'Subscribe to one or more emitted shard events with automatic cleanup.' },
  { id: 'service', label: 'Scheduled service', path: 'authored/services', hooks: ['init', 'interval', 'dispose'],
    description: 'A bounded periodic job using the shared scheduler and script circuit breaker.' },
]);

function q(value) { return JSON.stringify(String(value ?? '')); }
function cleanText(value, max = 256) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);
}
function cleanId(value) { return cleanText(value, 96).trim().toLowerCase(); }
function sourceHash(source) { return crypto.createHash('sha256').update(source).digest('hex'); }
function indentBody(body, spaces = 4) {
  const pad = ' '.repeat(spaces);
  return String(body ?? '').trim().split('\n').map((line) => `${pad}${line}`).join('\n');
}
function messageLine(target, message) {
  const text = cleanText(message || 'The script hook ran successfully.', 512);
  return `${target}?.client?.sendSystemMessage?.(${q(text)});`;
}

function validateSpec(input = {}) {
  const spec = {
    type: cleanId(input.type), id: cleanId(input.id), label: cleanText(input.label, 128).trim(),
    description: cleanText(input.description, 512).trim(), message: cleanText(input.message, 512),
    access: cleanText(input.access || 'GM', 24), region: cleanText(input.region, 128).trim(),
    mobileKind: cleanId(input.mobileKind), intervalMs: Number(input.intervalMs) || 5000,
    aliases: Array.isArray(input.aliases) ? input.aliases.map(cleanId).filter(Boolean).slice(0, 16) : [],
    hooks: Array.isArray(input.hooks) ? [...new Set(input.hooks.map((value) => cleanText(value, 96)))].slice(0, 32) : [],
    eventNames: Array.isArray(input.eventNames) ? [...new Set(input.eventNames.map((value) => cleanText(value, 96).trim()).filter(Boolean))].slice(0, 32) : [],
  };
  const type = SCRIPT_STUDIO_TYPES.find((entry) => entry.id === spec.type);
  const errors = [], warnings = [];
  if (!type) errors.push('Choose a supported script type.');
  if (!IDENTIFIER.test(spec.id)) errors.push('Identifier must start with a letter and contain lowercase letters, numbers, dash, underscore or dot.');
  if (!spec.label) spec.label = spec.id;
  if (spec.type === 'command' && !ACCESS.has(spec.access)) errors.push('Command access must be Player, Counselor, Seer, GM or Admin.');
  if (spec.type === 'region' && !spec.region) errors.push('A region name is required.');
  if (spec.type === 'mobile' && !spec.mobileKind) errors.push('A mobile template kind is required.');
  if (spec.type === 'service' && (spec.intervalMs < 250 || spec.intervalMs > 86_400_000)) errors.push('Interval must be between 250 ms and 24 hours.');
  if (type) {
    const validHooks = new Set(type.hooks);
    for (const hook of spec.hooks) if (!validHooks.has(hook)) errors.push(`Unsupported ${spec.type} hook: ${hook}`);
  }
  if (spec.type === 'event') {
    if (spec.eventNames.length === 0) spec.eventNames = spec.hooks.filter(Boolean);
    if (spec.eventNames.length === 0) errors.push('Select or enter at least one event name.');
  }
  if ((spec.type === 'item' || spec.type === 'region' || spec.type === 'mobile') && spec.hooks.length === 0) {
    warnings.push('No hook selected; a useful default hook will be generated.');
  }
  return { ok: errors.length === 0, errors, warnings, spec, type };
}

function header(spec) {
  return `// Generated by NodeUO Script Studio. Safe to edit by hand.\n`
    + `// ${spec.description || spec.label}\n\n`;
}

function generateItem(spec) {
  const hooks = spec.hooks.length ? spec.hooks : ['onUse'];
  const methods = hooks.map((hook) => {
    if (hook === 'onDrop') return `  onDrop(world, item, dropped, mobile) {\n${indentBody(`${messageLine('mobile', spec.message)}\nvoid world; void item; void dropped;\nreturn { handled: true, consumeHeld: false };`)}\n  }`;
    if (hook === 'onTick') return `  hasTick: true,\n  onTick(world, item, dt) {\n${indentBody(`// Keep this callback cheap; it runs only because hasTick is true.\nitem._scriptTicks = (item._scriptTicks ?? 0) + 1;\nvoid world; void dt;`)}\n  }`;
    const args = hook === 'onDestroy' || hook === 'onCreate' ? 'world, item' : 'world, item, mobile';
    const target = hook === 'onUse' ? 'mobile' : 'mobile';
    const returnLine = hook === 'onUse' ? '\nreturn true;' : '';
    return `  ${hook}(${args}) {\n${indentBody(`${args.includes('mobile') ? messageLine(target, spec.message) : 'void item;'}\nvoid world;${returnLine}`)}\n  }`;
  });
  return `${header(spec)}export default function register(api) {\n  const behavior = {\n    name: ${q(spec.id)},\n${methods.join(',\n')}\n  };\n  for (const hook of ${JSON.stringify(hooks)}) {\n    if (typeof behavior[hook] === 'function') behavior[hook] = api.lifecycle.guard('item:${spec.id}:' + hook, behavior[hook]);\n  }\n  api.itemScripts.register(behavior);\n  return () => api.itemScripts.unregister(${q(spec.id)});\n}\n`;
}

function generateCommand(spec) {
  return `${header(spec)}export default function register(api) {\n  api.lifecycle.command({\n    name: ${q(spec.id)},\n    help: ${q(spec.description || `[${spec.id}]`)},\n    access: ${q(spec.access)},\n    aliases: ${JSON.stringify(spec.aliases)},\n    run(ctx, args) {\n${indentBody(`${messageLine('ctx.sender', spec.message)}\n// Arguments are already tokenized and access was checked by the registry.\nvoid args;`, 6)}\n    },\n  });\n}\n`;
}

function generateAi(spec) {
  return `${header(spec)}export default function register(api) {\n  api.ai.registerBehavior({\n    name: ${q(spec.id)},\n    initState: () => ({ nextThinkAt: 0, targetSerial: 0 }),\n    tick(ctx, mobile, state) {\n      if (ctx.now < state.nextThinkAt) return;\n      state.nextThinkAt = ctx.now + 2000;\n      const nearby = api.ai.nearestOnline?.(mobile, 8);\n      state.targetSerial = nearby?.target?.serial ?? 0;\n      if (nearby?.target) ctx.broadcastSpeech(mobile, ${q(spec.message || 'I see you.')});\n    },\n  });\n  // Preserve live bindings during an atomic hot reload. They pause while the\n  // behavior is absent and resume with their existing state after replacement.\n  return () => api.ai.unregisterBehavior(${q(spec.id)}, { detach: false });\n}\n`;
}

function generateRegion(spec) {
  const hooks = spec.hooks.length ? spec.hooks : ['onEnter'];
  const registrations = [];
  if (hooks.includes('onEnter')) registrations.push(`api.systems.regionOnEnter.onEnterRegion(${q(spec.region)}, (mobile, transition) => {\n    ${messageLine('mobile', spec.message || `You enter ${spec.region}.`)}\n    void transition;\n  })`);
  if (hooks.includes('onLeave')) registrations.push(`api.systems.regionOnEnter.onLeaveRegion(${q(spec.region)}, (mobile, transition) => {\n    ${messageLine('mobile', spec.message || `You leave ${spec.region}.`)}\n    void transition;\n  })`);
  return `${header(spec)}export default function register(api) {\n  const dispose = [\n    ${registrations.join(',\n    ')},\n  ];\n  for (const off of dispose) api.lifecycle.onDispose(off, 'region-hook');\n}\n`;
}

function generateEvents(spec, mobile = false) {
  const names = mobile ? (spec.hooks.length ? spec.hooks : ['mobile:created']) : spec.eventNames;
  const blocks = names.map((name) => {
    const filter = mobile ? `\n    const mobile = payload?.mobile ?? payload?.victim ?? payload?.attacker;\n    if (!mobile || mobile.kind !== ${q(spec.mobileKind)}) return;` : '';
    const target = mobile ? 'mobile' : '(payload?.mobile ?? payload?.player)';
    return `  api.lifecycle.event(${q(name)}, (payload) => {${filter}\n    ${messageLine(target, spec.message)}\n  });`;
  });
  return `${header(spec)}export default function register(api) {\n${blocks.join('\n')}\n}\n`;
}

function generateService(spec) {
  return `${header(spec)}export default function register(api) {\n  let runs = 0;\n  api.lifecycle.setInterval(() => {\n    runs++;\n    // Replace this bounded operation with the service logic. The runtime\n    // profiles it and opens a circuit breaker after repeated errors/slowness.\n    api.log?.(${q(`[${spec.id}] service pulse`)} + ' #' + runs);\n  }, ${Math.trunc(spec.intervalMs)});\n}\n`;
}

export function generateScript(input) {
  const validation = validateSpec(input);
  if (!validation.ok) return { ...validation, source: '' };
  const { spec, type } = validation;
  let source = '';
  if (spec.type === 'item') source = generateItem(spec);
  else if (spec.type === 'command') source = generateCommand(spec);
  else if (spec.type === 'ai') source = generateAi(spec);
  else if (spec.type === 'region') source = generateRegion(spec);
  else if (spec.type === 'mobile') source = generateEvents(spec, true);
  else if (spec.type === 'event') source = generateEvents(spec);
  else source = generateService(spec);
  const rel = `${type.path}/${spec.id}.js`;
  return { ...validation, source, path: rel, bytes: Buffer.byteLength(source),
    graph: { trigger: spec.hooks.length ? spec.hooks : spec.eventNames,
      filter: spec.mobileKind || spec.region || null, registration: spec.type,
      lifecycle: 'owned; disposed automatically on hot reload' } };
}

function inspectSource(rel, source, runtimeEntry = null) {
  const commands = [...source.matchAll(/(?:commands|lifecycle)\.command\s*\(\s*\{[\s\S]{0,320}?name\s*:\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
  const commandRegistrations = [...source.matchAll(/commands\.register\s*\(\s*\{[\s\S]{0,320}?name\s*:\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
  const itemScripts = [...source.matchAll(/(?:itemScripts\.)?register(?:ItemScript)?\s*\(\s*\{[\s\S]{0,320}?name\s*:\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
  const ai = [...source.matchAll(/registerBehavior\s*\(\s*\{[\s\S]{0,320}?name\s*:\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
  const events = [...source.matchAll(/(?:lifecycle\.event|events\.(?:on|emit))\s*\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
  const regions = [...source.matchAll(/\.(onEnterRegion|onLeaveRegion)\s*\(\s*['"`]([^'"`]+)['"`]/g)].map((m) => ({ hook: m[1], region: m[2] }));
  const hooks = ITEM_HOOKS.filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(source));
  const inferredType = itemScripts.length || hooks.length ? 'item'
    : ai.length ? 'ai' : regions.length ? 'region'
      : commands.length || commandRegistrations.length ? 'command'
        : events.some((event) => MOBILE_EVENTS.includes(event)) ? 'mobile'
          : events.length ? 'event' : /setInterval|lifecycle\.setInterval/.test(source) ? 'service' : 'module';
  return { path: rel, type: inferredType, bytes: Buffer.byteLength(source),
    commands: [...new Set([...commands, ...commandRegistrations])], itemScripts: [...new Set(itemScripts)],
    ai: [...new Set(ai)], events: [...new Set(events)], regions, hooks,
    loaded: !!runtimeEntry, resources: runtimeEntry?.lifecycle?.stats?.() ?? null };
}

function sourceDiagnostics(rel, source, sharedCtx) {
  const diagnostics = [];
  const add = (severity, code, message, pattern = null) => {
    const index = pattern ? source.search(pattern) : -1;
    const prefix = index >= 0 ? source.slice(0, index) : '';
    diagnostics.push({ severity, code, message,
      line: index >= 0 ? prefix.split('\n').length : 1,
      column: index >= 0 ? index - prefix.lastIndexOf('\n') : 1 });
  };
  if (!/export\s+default\s+(?:async\s+)?function\b/u.test(source)) {
    add('error', 'missing-registration', 'The module must export a default registration function.');
  }
  if (/(^|[^.\w])setInterval\s*\(/mu.test(source)) add('warning', 'unowned-interval',
    'Use api.lifecycle.setInterval so hot reload disposes the timer.', /(^|[^.\w])setInterval\s*\(/mu);
  if (/(^|[^.\w])setTimeout\s*\(/mu.test(source)) add('warning', 'unowned-timeout',
    'Use api.lifecycle.setTimeout so hot reload disposes the timer.', /(^|[^.\w])setTimeout\s*\(/mu);
  if (/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;/u.test(source)) add('warning', 'unbounded-loop',
    'Unbounded loops can stall the simulation thread.', /while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;/u);
  if (/\.on\s*\([^)]*,/u.test(source) && !/lifecycle\.(?:event|onDispose)/u.test(source)) {
    add('info', 'lifecycle-review', 'Confirm every external event subscription has a lifecycle-owned disposer.', /\.on\s*\(/u);
  }
  const imports = [...source.matchAll(/(?:import[\s\S]*?from\s*|import\s*)['"]([^'"]+)['"]/gu)]
    .map((match) => match[1]).slice(0, 256);
  const graphNode = `script:${String(rel).replace(/\\/g, '/')}`;
  const impact = sharedCtx?.contentDependencies?.impact?.(graphNode, 4) ?? null;
  return { ok: !diagnostics.some((entry) => entry.severity === 'error'), diagnostics,
    imports, impact, hash: sourceHash(source), bytes: Buffer.byteLength(source) };
}

function rotateBackups(file, keep = 5) {
  if (!fs.existsSync(file)) return null;
  const backup = `${file}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(file, backup);
  const prefix = `${path.basename(file)}.bak.`;
  const backups = fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(prefix))
    .map((name) => ({ name, mtime: fs.statSync(path.join(path.dirname(file), name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const old of backups.slice(keep)) fs.unlinkSync(path.join(path.dirname(file), old.name));
  return path.basename(backup);
}

async function validateModule(abs, source) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const temporary = path.join(path.dirname(abs), `.${path.basename(abs)}.studio-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(temporary, source, 'utf8');
  try {
    const mod = await import(`${pathToFileURL(temporary).href}?validate=${Date.now()}`);
    if (typeof mod.default !== 'function') throw new Error('script must export a default registration function');
    return { ok: true, exports: Object.keys(mod) };
  } finally { try { fs.unlinkSync(temporary); } catch { /* best effort */ } }
}

function atomicWrite(file, source) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, source, 'utf8');
  try { fs.renameSync(temporary, file); }
  catch (error) { try { fs.unlinkSync(temporary); } catch { /* best effort */ } throw error; }
}

export function registerScriptStudioRoutes(routes, { scriptsDir, scriptRuntime, sharedCtx }) {
  let cache = null;
  function catalog() {
    if (cache?.expiresAt > Date.now()) return cache.value;
    const runtimeByFile = new Map((scriptRuntime?.loaded ?? []).map((entry) => [path.resolve(entry.file), entry]));
    const files = flattenScriptTree(walkScriptTree(scriptsDir)).filter((row) => /\.(?:js|mjs)$/i.test(row.path));
    const scripts = [];
    const knownEvents = new Set(WORLD_EVENTS);
    for (const file of files) {
      const absolute = safeJoin(scriptsDir, file.path);
      if (!absolute || file.size > MAX_SOURCE_BYTES) continue;
      try {
        const inspected = inspectSource(file.path, fs.readFileSync(absolute, 'utf8'), runtimeByFile.get(path.resolve(absolute)));
        scripts.push(inspected);
        for (const event of inspected.events) knownEvents.add(event);
      } catch { /* one unreadable file does not hide the rest */ }
    }
    const value = { types: SCRIPT_STUDIO_TYPES, itemHooks: ITEM_HOOKS,
      knownEvents: [...knownEvents].sort(), scripts,
      live: {
        commands: [...(sharedCtx?.commands?.commands?.values?.() ?? [])].filter((entry) => !entry.aliasOf).map((entry) => ({ name: entry.name, access: entry.access, help: entry.help })).sort((a, b) => a.name.localeCompare(b.name)),
        ai: [...(sharedCtx?.ai?.behaviors?.keys?.() ?? [])].sort(),
        itemScripts: (sharedCtx?.systems?.itemScripts?.all?.() ?? []).map((entry) => entry.name).sort(),
        regions: (sharedCtx?.regions?.list?.() ?? []).map((entry) => entry.name).filter(Boolean).sort(),
      },
      links: [
        { label: 'Items and item bindings', href: '/studio?domain=items' },
        { label: 'Mob and NPC definitions', href: '/studio?domain=mobiles' },
        { label: 'World regions and spawns', href: '/studio?domain=world' },
        { label: 'Script runtime diagnostics', href: '/#operations' },
      ],
    };
    cache = { value, expiresAt: Date.now() + 5000 };
    return value;
  }

  routes.push({ method: 'GET', path: '/api/script-studio/catalog', run: catalog });
  routes.push({ method: 'POST', path: '/api/script-studio/preview', run: ({ body }) => generateScript(body) });
  routes.push({ method: 'GET', path: '/api/script-studio/file', run: ({ query }) => {
    const rel = query.get('path') ?? '';
    const absolute = safeJoin(scriptsDir, rel);
    if (!absolute || !/\.(?:js|mjs)$/i.test(rel)) return { error: 'invalid script path' };
    try {
      const source = fs.readFileSync(absolute, 'utf8');
      const stat = fs.statSync(absolute);
      return { ok: true, path: rel, source, mtime: Math.trunc(stat.mtimeMs), hash: sourceHash(source),
        inspection: inspectSource(rel, source, (scriptRuntime?.loaded ?? []).find((entry) => path.resolve(entry.file) === path.resolve(absolute))) };
    } catch (error) { return { error: error.message }; }
  } });
  routes.push({ method: 'PUT', path: '/api/script-studio/file', run: async ({ body }) => {
    const rel = cleanText(body?.path, 300).replace(/\\/g, '/');
    const absolute = safeJoin(scriptsDir, rel);
    const source = body?.source;
    if (!absolute || !/\.(?:js|mjs)$/i.test(rel)) return { error: 'invalid script path' };
    if (typeof source !== 'string') return { error: 'source is required' };
    if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) return { error: 'script exceeds the 1 MiB editor limit' };
    const before = fs.existsSync(absolute) ? fs.statSync(absolute) : null;
    const beforeSource = before ? fs.readFileSync(absolute, 'utf8') : '';
    const expected = Number(body?.expectedMtime);
    if (before && Number.isFinite(expected) && Math.trunc(before.mtimeMs) !== Math.trunc(expected)) {
      return { error: 'script changed since it was opened', conflict: true, actualMtime: Math.trunc(before.mtimeMs) };
    }
    if (before && body?.expectedHash && sourceHash(beforeSource) !== String(body.expectedHash)) {
      return { error: 'script content changed since it was opened', conflict: true,
        actualMtime: Math.trunc(before.mtimeMs), actualHash: sourceHash(beforeSource) };
    }
    const diagnostics = sourceDiagnostics(rel, source, sharedCtx);
    if (!diagnostics.ok) return { error: 'source validation failed', phase: 'analyze', ...diagnostics };
    try { await validateModule(absolute, source); }
    catch (error) { return { error: `validation failed: ${error.message}`, phase: 'validate' }; }
    try {
      const backup = rotateBackups(absolute);
      atomicWrite(absolute, source);
      const stat = fs.statSync(absolute);
      let activation = null;
      if (body?.activate !== false && scriptRuntime?.reloadOne) activation = await scriptRuntime.reloadOne(rel);
      if (activation && !activation.ok) {
        if (before && backup) fs.copyFileSync(path.join(path.dirname(absolute), backup), absolute);
        else if (!before) fs.unlinkSync(absolute);
        return { error: `activation failed: ${activation.error}`, phase: activation.phase,
          rolledBack: true, activation };
      }
      cache = null;
      return { ok: true, path: rel, backup, mtime: Math.trunc(stat.mtimeMs), hash: sourceHash(source),
        diagnostics: diagnostics.diagnostics, activation,
        inspection: inspectSource(rel, source, (scriptRuntime?.loaded ?? []).find((entry) => path.resolve(entry.file) === path.resolve(absolute))) };
    } catch (error) { return { error: error.message }; }
  } });
  routes.push({ method: 'DELETE', path: '/api/script-studio/file', run: async ({ query }) => {
    const rel = query.get('path') ?? '';
    const absolute = safeJoin(scriptsDir, rel);
    if (!absolute || !/\.(?:js|mjs)$/i.test(rel) || !fs.existsSync(absolute)) return { error: 'script not found or invalid path' };
    const archiveRoot = path.join(scriptsDir, '.script-studio-archive');
    const archived = path.join(archiveRoot, `${rel.replace(/[\\/]/g, '__')}.${Date.now()}.archived`);
    fs.mkdirSync(archiveRoot, { recursive: true });
    const active = (scriptRuntime?.loaded ?? []).some((entry) => path.resolve(entry.file) === path.resolve(absolute));
    try {
      fs.renameSync(absolute, archived);
      scriptRuntime?.invalidateManifest?.();
      if (active && scriptRuntime?.load) await scriptRuntime.load({ reason: `script-studio-archive:${rel}`, emitEvent: true });
      cache = null;
      return { ok: true, path: rel, archived: path.relative(scriptsDir, archived).replace(/\\/g, '/'), recoverable: true };
    } catch (error) { return { error: error.message }; }
  } });
  routes.push({ method: 'POST', path: '/api/script-studio/validate', run: async ({ body }) => {
    const rel = cleanText(body?.path || 'authored/preview.js', 300).replace(/\\/g, '/');
    const absolute = safeJoin(scriptsDir, rel);
    const source = body?.source;
    if (!absolute || !/\.(?:js|mjs)$/i.test(rel) || typeof source !== 'string') return { error: 'valid script path and source are required' };
    if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) return { error: 'script exceeds the 1 MiB editor limit' };
    const analysis = sourceDiagnostics(rel, source, sharedCtx);
    if (!analysis.ok) return analysis;
    try {
      const syntax = await validateModule(absolute, source);
      return { ...analysis, syntax, inspection: inspectSource(rel, source), ok: true };
    } catch (error) {
      return { ...analysis, ok: false, diagnostics: [...analysis.diagnostics, {
        severity: 'error', code: 'module-validation', message: error.message, line: 1, column: 1,
      }] };
    }
  } });
  routes.push({ method: 'GET', path: '/api/script-studio/archives', run: () => {
    const archiveRoot = path.join(scriptsDir, '.script-studio-archive');
    if (!fs.existsSync(archiveRoot)) return { ok: true, archives: [] };
    const archives = fs.readdirSync(archiveRoot).filter((name) => name.endsWith('.archived')).map((name) => {
      const stat = fs.statSync(path.join(archiveRoot, name));
      const match = name.match(/^(.*)\.(\d+)\.archived$/u);
      return { name, originalPath: match ? match[1].replaceAll('__', '/') : '',
        archivedAt: match ? Number(match[2]) : Math.trunc(stat.mtimeMs), bytes: stat.size };
    }).sort((a, b) => b.archivedAt - a.archivedAt).slice(0, 500);
    return { ok: true, archives };
  } });
  routes.push({ method: 'POST', path: '/api/script-studio/restore', run: async ({ body }) => {
    const archiveRoot = path.join(scriptsDir, '.script-studio-archive');
    const archiveName = path.basename(cleanText(body?.archive, 500));
    const rel = cleanText(body?.path, 300).replace(/\\/g, '/');
    const archived = safeJoin(archiveRoot, archiveName); const destination = safeJoin(scriptsDir, rel);
    if (!archived || !destination || !archiveName.endsWith('.archived') || !/\.(?:js|mjs)$/i.test(rel)
        || !fs.existsSync(archived)) return { error: 'invalid archive or destination' };
    if (fs.existsSync(destination) && body?.overwrite !== true) return { error: 'destination already exists', conflict: true };
    const source = fs.readFileSync(archived, 'utf8');
    try { await validateModule(destination, source); } catch (error) { return { error: `validation failed: ${error.message}` }; }
    const backup = fs.existsSync(destination) ? rotateBackups(destination) : null;
    atomicWrite(destination, source);
    const activation = scriptRuntime?.reloadOne ? await scriptRuntime.reloadOne(rel) : null;
    if (activation && !activation.ok) {
      if (backup) fs.copyFileSync(path.join(path.dirname(destination), backup), destination);
      else fs.unlinkSync(destination);
      return { error: `activation failed: ${activation.error}`, rolledBack: true, activation };
    }
    cache = null;
    return { ok: true, path: rel, hash: sourceHash(source), activation, archiveRetained: true };
  } });
}
