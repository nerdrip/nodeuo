// Optional data-driven appearance layer for local/browser gumps.
//
// The Ultima Online network protocol remains untouched: server-driven gumps
// continue to arrive as standard 0xB0/0xDD layouts. This catalogue only
// overrides local classes after their normal JavaScript constructors have
// built the functional control tree. A client hosted without NodeUO still
// receives /client-gumps.json from its own Vite/public bundle.

import { bus } from '../core/event-bus.js';

const DEFAULT_URL = '/client-gumps.json';
const MAX_DEFINITIONS = 2048;
const MAX_CONTROL_OVERRIDES = 512;

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function bounded(value, min, max, fallback = null) {
  const number = finite(value, fallback);
  return number == null ? fallback : Math.max(min, Math.min(max, number));
}

function normalizeDefinition(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const definitionId = String(raw.definitionId ?? '').trim();
  const className = String(raw.className ?? '').trim();
  const type = String(raw.type ?? '').trim();
  if (!definitionId || (!className && !type)) return null;
  return {
    ...raw,
    definitionId,
    scope: 'client',
    className,
    type,
    frame: raw.frame && typeof raw.frame === 'object' && !Array.isArray(raw.frame) ? raw.frame : {},
    behavior: raw.behavior && typeof raw.behavior === 'object' && !Array.isArray(raw.behavior) ? raw.behavior : {},
    controlOverrides: Array.isArray(raw.controlOverrides)
      ? raw.controlOverrides.slice(0, MAX_CONTROL_OVERRIDES) : [],
  };
}

function controlAtPath(root, path) {
  const parts = Array.isArray(path) ? path : String(path ?? '').split(/[./]/).filter(Boolean);
  let control = root;
  for (const part of parts) {
    const index = Number(part);
    if (!Number.isInteger(index) || index < 0) return null;
    control = control?.children?.[index];
    if (!control) return null;
  }
  return control;
}

function controlsByClass(root, className) {
  const wanted = String(className ?? '').trim();
  if (!wanted) return [];
  const matches = [];
  const visit = (control) => {
    for (const child of control?.children ?? []) {
      if (child?.constructor?.name === wanted) matches.push(child);
      visit(child);
    }
  };
  visit(root);
  return matches;
}

function controlByLayoutId(root, layoutId) {
  const wanted = String(layoutId ?? '').trim();
  if (!wanted) return null;
  let match = null;
  const visit = (control) => {
    if (!control || match) return;
    if (control.layoutId === wanted) { match = control; return; }
    for (const child of control.children ?? []) visit(child);
  };
  visit(root);
  return match;
}

function targetForOverride(gump, override) {
  if (String(override.controlId ?? '').trim()) return controlByLayoutId(gump, override.controlId);
  if (override.path != null && String(override.path).trim() !== '') return controlAtPath(gump, override.path);
  const matches = controlsByClass(gump, override.className);
  return matches[Math.max(0, Number(override.classIndex) | 0)] ?? null;
}

function applyControlOverride(gump, override) {
  if (!override || typeof override !== 'object' || override.enabled === false) return false;
  const control = targetForOverride(gump, override);
  if (!control) return false;
  const x = finite(override.x), y = finite(override.y);
  if (x != null || y != null) control.setPosition?.(x ?? control.x, y ?? control.y);
  const width = finite(override.width), height = finite(override.height);
  if (width != null || height != null) control.setSize?.(width ?? control.width, height ?? control.height);
  if (typeof override.visible === 'boolean') {
    control.visible = override.visible;
    control._applyPageVisibility?.();
  }
  if (override.page != null && Number.isFinite(Number(override.page))) {
    control.page = Number(override.page) | 0;
    control._applyPageVisibility?.();
  }
  const alpha = bounded(override.opacity ?? override.alpha, 0, 1);
  if (alpha != null && control.node) control.node.alpha = alpha;
  if (override.text != null) control.setText?.(String(override.text));
  if (override.hue != null) control.setHue?.(Number(override.hue) | 0);
  if (override.gumpId != null || override.artId != null) control.setGumpId?.(Number(override.gumpId ?? override.artId) | 0);
  if (override.itemId != null) control.setItemId?.(Number(override.itemId) | 0);
  return true;
}

class ClientGumpDefinitions {
  constructor() {
    this.url = DEFAULT_URL;
    this.loaded = false;
    this.revision = 0;
    this.definitions = [];
    this.byClass = new Map();
    this.byType = new Map();
    this.lastError = null;
  }

  async load({ url = this.url, force = false } = {}) {
    if (this._loading && !force) return this._loading;
    this.url = url || DEFAULT_URL;
    const request = fetch(this.url, { cache: 'no-store', credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        if (!Array.isArray(payload)) throw new Error('client gump catalogue must be an array');
        const definitions = payload.slice(0, MAX_DEFINITIONS).map(normalizeDefinition).filter(Boolean);
        const byClass = new Map();
        const byType = new Map();
        for (const definition of definitions) {
          if (definition.className && !byClass.has(definition.className)) byClass.set(definition.className, definition);
          if (definition.type && !byType.has(definition.type)) byType.set(definition.type, definition);
        }
        this.definitions = definitions;
        this.byClass = byClass;
        this.byType = byType;
        this.loaded = true;
        this.lastError = null;
        this.revision++;
        bus.emit('client-gumps:loaded', { count: definitions.length, revision: this.revision });
        return { ok: true, count: definitions.length, revision: this.revision };
      })
      .catch((error) => {
        this.lastError = error;
        // The code-authored constructors are the hard fallback. A malformed
        // or unavailable optional JSON file must never block login/gameplay.
        console.warn('[client-gumps] optional catalogue unavailable:', error?.message ?? error);
        return { ok: false, count: this.definitions.length, error: error?.message ?? String(error) };
      })
      .finally(() => { if (this._loading === request) this._loading = null; });
    this._loading = request;
    return request;
  }

  find(gump) {
    if (!gump) return null;
    const className = gump.constructor?.name ?? '';
    return this.byClass.get(className) ?? this.byType.get(String(gump.type ?? '')) ?? null;
  }

  apply(gump) {
    const definition = this.find(gump);
    if (!definition || definition.abstract) return null;
    const frame = definition.frame ?? {};
    if (frame.enabled) {
      const width = bounded(frame.width, 1, 8192), height = bounded(frame.height, 1, 8192);
      if (width != null || height != null) {
        const nextWidth = width ?? gump.width, nextHeight = height ?? gump.height;
        gump.setSize?.(nextWidth, nextHeight);
        if ('_w' in gump) gump._w = nextWidth;
        if ('_h' in gump) gump._h = nextHeight;
        gump._bg?.setSize?.(nextWidth, nextHeight);
      }
      const x = bounded(frame.x, -32768, 32767), y = bounded(frame.y, -32768, 32767);
      if (x != null || y != null) gump.setPosition?.(x ?? gump.x, y ?? gump.y);
      const opacity = bounded(frame.opacity, 0, 1);
      if (opacity != null && gump.node) gump.node.alpha = opacity;
    }
    const behavior = definition.behavior ?? {};
    if (behavior.enabled) {
      for (const key of ['canMove', 'canClose', 'canCloseWithEsc', 'canCloseWithRMB']) {
        if (typeof behavior[key] === 'boolean') gump[key] = behavior[key];
      }
    }
    let controlsApplied = 0;
    for (const override of definition.controlOverrides ?? []) {
      if (applyControlOverride(gump, override)) controlsApplied++;
    }
    gump._clientGumpDefinition = { definitionId: definition.definitionId, revision: this.revision, controlsApplied };
    return definition;
  }
}

export const clientGumpDefinitions = new ClientGumpDefinitions();
export { normalizeDefinition, applyControlOverride, controlAtPath, controlByLayoutId };
