(function adminCoreBootstrap(global) {
  'use strict';

  const STORAGE_KEY = 'nodeuo.admin.preferences.v1';
  const state = {
    controller: null,
    commands: [],
    paletteIndex: 0,
    preferences: loadPreferences(),
  };
  let preferenceSyncTimer = null;
  let metricsTimer = null;

  function loadPreferences() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; }
    catch { return {}; }
  }
  function persistPreferences() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.preferences));
  }
  function preference(key, fallback) {
    return Object.prototype.hasOwnProperty.call(state.preferences, key) ? state.preferences[key] : fallback;
  }
  function setPreference(key, value) {
    state.preferences[key] = value;
    persistPreferences();
    clearTimeout(preferenceSyncTimer);
    preferenceSyncTimer = setTimeout(() => {
      fetch('/api/preferences', { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ preferences: state.preferences }) }).catch(() => {});
    }, 500);
  }

  async function syncPreferences() {
    try {
      const response = await fetch('/api/preferences', { credentials: 'same-origin' });
      if (!response.ok) return;
      const remote = (await response.json()).preferences;
      if (remote && typeof remote === 'object') { state.preferences = { ...state.preferences, ...remote }; persistPreferences(); applyViewPreferences(); }
    } catch { /* local preferences remain available */ }
  }

  function beginView() {
    state.controller?.abort();
    state.controller = new AbortController();
    return state.controller.signal;
  }
  function viewSignal() { return state.controller?.signal; }

  function toast(message, kind = 'info', timeout = 3600) {
    let host = document.querySelector('.admin-toast-region');
    if (!host) {
      host = document.createElement('div');
      host.className = 'admin-toast-region';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.className = `admin-toast ${kind}`;
    el.textContent = String(message);
    host.appendChild(el);
    const timer = setTimeout(() => el.remove(), timeout);
    el.addEventListener('click', () => { clearTimeout(timer); el.remove(); });
    return el;
  }

  function renderState(host, kind, options = {}) {
    const node = typeof host === 'string' ? document.querySelector(host) : host;
    if (!node) return;
    const labels = {
      loading: options.message || 'Loading…',
      empty: options.message || 'Nothing to display.',
      error: options.message || 'The request failed.',
    };
    const retry = kind === 'error' && typeof options.retry === 'function'
      ? '<button type="button" data-admin-retry>Retry</button>' : '';
    node.innerHTML = `<div class="admin-state" role="${kind === 'error' ? 'alert' : 'status'}"><div>${kind === 'loading' ? '<div class="admin-spinner" aria-hidden="true"></div>' : ''}<div>${escapeHtml(labels[kind] || labels.empty)}</div>${retry}</div></div>`;
    node.querySelector('[data-admin-retry]')?.addEventListener('click', options.retry);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  }

  function stableJson(value) {
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }

  function redact(value, depth = 0) {
    if (depth > 5) return '[depth-limit]';
    if (typeof value === 'string') return value
      .replace(/(password|secret|token|cookie|authorization)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[REDACTED]')
      .replace(/\b[0-9a-f]{48,}\b/gi, '[REDACTED]');
    if (Array.isArray(value)) return value.slice(0, 500).map((entry) => redact(entry, depth + 1));
    if (!value || typeof value !== 'object') return value;
    const output = {};
    for (const [key, entry] of Object.entries(value)) output[key] = /password|secret|token|cookie|authorization/i.test(key)
      ? '[REDACTED]' : redact(entry, depth + 1);
    return output;
  }

  function combineSignals(...signals) {
    const active = signals.filter(Boolean);
    if (!active.length) return undefined;
    if (typeof AbortSignal.any === 'function') return AbortSignal.any(active);
    const controller = new AbortController();
    const abort = () => controller.abort();
    for (const signal of active) {
      if (signal.aborted) { abort(); break; }
      signal.addEventListener('abort', abort, { once: true });
    }
    return controller.signal;
  }

  class RequestBroker {
    constructor({ maxConcurrent = 6, cacheEntries = 160, cacheTtlMs = 15_000 } = {}) {
      this.maxConcurrent = Math.max(1, maxConcurrent | 0);
      this.cacheEntries = Math.max(8, cacheEntries | 0);
      this.cacheTtlMs = Math.max(0, cacheTtlMs | 0);
      this.active = 0; this.queue = []; this.inflight = new Map(); this.cache = new Map();
      this.metrics = { requested: 0, completed: 0, failed: 0, retried: 0, deduped: 0, cacheHits: 0, aborted: 0, maxQueue: 0 };
    }
    _cacheKey(method, url, body) { return `${method}:${url}:${body == null ? '' : stableJson(body)}`; }
    _touchCache(key, entry) {
      this.cache.delete(key); this.cache.set(key, entry);
      while (this.cache.size > this.cacheEntries) this.cache.delete(this.cache.keys().next().value);
    }
    invalidate(match = '') {
      const predicate = typeof match === 'function' ? match : (key) => !match || key.includes(String(match));
      for (const key of this.cache.keys()) if (predicate(key)) this.cache.delete(key);
    }
    async request(method, url, body = null, options = {}) {
      method = String(method || 'GET').toUpperCase();
      const key = options.key || this._cacheKey(method, url, body);
      const cached = method === 'GET' ? this.cache.get(key) : null;
      const now = Date.now();
      if (cached && (now - cached.at) <= (options.cacheTtlMs ?? this.cacheTtlMs)) {
        this.metrics.cacheHits++; this._touchCache(key, cached); return cached.value;
      }
      if (cached && options.staleWhileRevalidate) {
        this._enqueue(method, url, body, { ...options, key, background: true }).catch(() => {});
        this.metrics.cacheHits++; return cached.value;
      }
      if (options.dedupe !== false && this.inflight.has(key)) {
        this.metrics.deduped++; return this.inflight.get(key);
      }
      const promise = this._enqueue(method, url, body, { ...options, key });
      if (options.dedupe !== false) this.inflight.set(key, promise);
      return promise.finally(() => { if (this.inflight.get(key) === promise) this.inflight.delete(key); });
    }
    _enqueue(method, url, body, options) {
      this.metrics.requested++;
      return new Promise((resolve, reject) => {
        const job = { method, url, body, options, resolve, reject, enqueuedAt: performance.now() };
        if (options.signal?.aborted) { this.metrics.aborted++; reject(new global.DOMException('Aborted', 'AbortError')); return; }
        this.queue.push(job); this.queue.sort((a, b) => (a.options.priority ?? 1) - (b.options.priority ?? 1));
        this.metrics.maxQueue = Math.max(this.metrics.maxQueue, this.queue.length); this._drain();
      });
    }
    _drain() {
      while (this.active < this.maxConcurrent && this.queue.length) {
        const job = this.queue.shift();
        if (job.options.signal?.aborted) { this.metrics.aborted++; job.reject(new global.DOMException('Aborted', 'AbortError')); continue; }
        this.active++;
        this._execute(job).then(job.resolve, job.reject).finally(() => { this.active--; this._drain(); });
      }
    }
    async _execute(job) {
      const { method, url, body, options } = job;
      const maxAttempts = method === 'GET' ? Math.max(1, (options.retries ?? 2) + 1) : 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const timeout = new AbortController();
        const timeoutId = setTimeout(() => timeout.abort(), options.timeoutMs ?? 20_000);
        const headers = { ...(options.headers || {}) };
        if (body != null) headers['content-type'] ||= 'application/json';
        if (method !== 'GET' && method !== 'HEAD') headers['x-idempotency-key'] ||= options.idempotencyKey || `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(2)).join('-')}`;
        if (options.revision != null) headers['if-match'] = String(options.revision);
        try {
          const response = await fetch(url, { method, credentials: 'same-origin', headers,
            body: body == null ? undefined : (headers['content-type'] === 'application/json' ? JSON.stringify(body) : body),
            signal: combineSignals(options.signal, timeout.signal) });
          if (response.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
          let payload = null;
          const contentType = response.headers.get('content-type') || '';
          try { payload = contentType.includes('json') ? await response.json() : await response.text(); } catch { payload = null; }
          if (!response.ok) {
            const error = new Error(payload?.error || `HTTP ${response.status}`);
            error.status = response.status; error.payload = payload; error.conflict = response.status === 409 || response.status === 412;
            if (attempt < maxAttempts && response.status >= 500) throw error;
            this.metrics.failed++; throw error;
          }
          if (method === 'GET') this._touchCache(options.key, { at: Date.now(), value: payload });
          else if (options.invalidate) this.invalidate(options.invalidate);
          this.metrics.completed++; return payload;
        } catch (error) {
          if (error.name === 'AbortError') { this.metrics.aborted++; throw error; }
          if (attempt >= maxAttempts) { this.metrics.failed++; throw error; }
          this.metrics.retried++; await new Promise((resolve) => setTimeout(resolve, Math.min(800, 80 * (2 ** (attempt - 1)))));
        } finally { clearTimeout(timeoutId); }
      }
      return null;
    }
    prefetch(url, options = {}) { return this.request('GET', url, null, { ...options, priority: 3, background: true }).catch(() => null); }
    snapshot() { return { ...this.metrics, active: this.active, queued: this.queue.length, inflight: this.inflight.size, cacheEntries: this.cache.size }; }
  }

  class VirtualList {
    constructor(host, { itemHeight = 36, overscan = 6, maxDomNodes = 160, key = (item, index) => item?.id ?? index, renderItem } = {}) {
      this.host = host; this.itemHeight = Math.max(18, itemHeight | 0); this.overscan = Math.max(1, overscan | 0);
      this.maxDomNodes = Math.max(16, maxDomNodes | 0);
      this.key = key; this.renderItem = renderItem || ((item) => String(item)); this.items = []; this.nodes = new Map();
      this.viewport = document.createElement('div'); this.viewport.className = 'admin-virtual-viewport';
      this.spacer = document.createElement('div'); this.spacer.className = 'admin-virtual-spacer'; this.viewport.appendChild(this.spacer);
      host.replaceChildren(this.viewport); host.classList.add('admin-virtual-list'); host.addEventListener('scroll', () => this.render(), { passive: true });
      this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.render()) : null; this.resizeObserver?.observe(host);
      this.metrics = { renders: 0, peakNodes: 0, lastRenderMs: 0, maxRenderMs: 0, budgetClamps: 0 };
    }
    setItems(items, { preserveAnchor = true } = {}) {
      const oldIndex = Math.floor(this.host.scrollTop / this.itemHeight); const anchorItem = this.items[oldIndex];
      const anchorKey = preserveAnchor && anchorItem != null ? this.key(anchorItem, oldIndex) : null;
      this.items = Array.isArray(items) ? items : []; this.spacer.style.height = `${this.items.length * this.itemHeight}px`;
      if (anchorKey != null) { const next = this.items.findIndex((item, index) => this.key(item, index) === anchorKey); if (next >= 0) this.host.scrollTop = next * this.itemHeight; }
      this.render();
    }
    scrollToIndex(index, align = 'nearest') {
      index = Math.max(0, Math.min(this.items.length - 1, index | 0)); const top = index * this.itemHeight; const bottom = top + this.itemHeight;
      if (align === 'start' || top < this.host.scrollTop) this.host.scrollTop = top;
      else if (align === 'end' || bottom > this.host.scrollTop + this.host.clientHeight) this.host.scrollTop = bottom - this.host.clientHeight;
      this.render();
    }
    render() {
      const started = performance.now();
      const height = this.host.clientHeight || 320; const start = Math.max(0, Math.floor(this.host.scrollTop / this.itemHeight) - this.overscan);
      let end = Math.min(this.items.length, Math.ceil((this.host.scrollTop + height) / this.itemHeight) + this.overscan);
      if (end - start > this.maxDomNodes) { end = start + this.maxDomNodes; this.metrics.budgetClamps++; }
      const visible = new Set();
      for (let index = start; index < end; index++) {
        const item = this.items[index]; const key = String(this.key(item, index)); visible.add(key); let node = this.nodes.get(key);
        if (!node) { node = document.createElement('div'); node.className = 'admin-virtual-row'; node.dataset.key = key; this.nodes.set(key, node); this.spacer.appendChild(node); }
        node.style.transform = `translateY(${index * this.itemHeight}px)`; node.style.height = `${this.itemHeight}px`; node.dataset.index = String(index);
        const rendered = this.renderItem(item, index, node); if (rendered instanceof global.Node && rendered !== node) node.replaceChildren(rendered); else if (typeof rendered === 'string') node.innerHTML = rendered;
      }
      for (const [key, node] of this.nodes) if (!visible.has(key)) { node.remove(); this.nodes.delete(key); }
      const elapsed = performance.now() - started;
      this.metrics.renders++; this.metrics.peakNodes = Math.max(this.metrics.peakNodes, this.nodes.size);
      this.metrics.lastRenderMs = Number(elapsed.toFixed(3)); this.metrics.maxRenderMs = Math.max(this.metrics.maxRenderMs, elapsed);
    }
    destroy() { this.resizeObserver?.disconnect(); this.nodes.clear(); this.host.replaceChildren(); }
    snapshot() { return { ...this.metrics, maxRenderMs: Number(this.metrics.maxRenderMs.toFixed(3)), items: this.items.length, domNodes: this.nodes.size, maxDomNodes: this.maxDomNodes }; }
  }

  class VirtualTable {
    constructor(host, { columns = [], rowHeight = 38, overscan = 8, maxDomNodes = 160,
      key = (item, index) => item?.serial ?? item?.id ?? index, renderCells = () => [] } = {}) {
      this.host = host; this.columns = columns; this.renderCells = renderCells;
      this.root = document.createElement('div'); this.root.className = 'admin-virtual-table'; this.root.setAttribute('role', 'table');
      this.header = document.createElement('div'); this.header.className = 'admin-virtual-table-head'; this.header.setAttribute('role', 'row');
      this.header.style.gridTemplateColumns = this._columnsCss();
      for (const column of columns) { const cell = document.createElement('div'); cell.setAttribute('role', 'columnheader'); cell.textContent = column.label ?? String(column); this.header.appendChild(cell); }
      this.body = document.createElement('div'); this.body.className = 'admin-virtual-table-body'; this.body.setAttribute('role', 'rowgroup');
      this.root.append(this.header, this.body); host.replaceChildren(this.root);
      this.list = new VirtualList(this.body, { itemHeight: rowHeight, overscan, maxDomNodes, key,
        renderItem: (item, index) => {
          const cells = this.renderCells(item, index) ?? [];
          return `<div class="admin-virtual-table-row" role="row" style="grid-template-columns:${escapeHtml(this._columnsCss())}">${cells.map((value) => `<div role="cell">${value ?? ''}</div>`).join('')}</div>`;
        } });
    }
    _columnsCss() { return this.columns.map((column) => column.width ?? 'minmax(90px,1fr)').join(' '); }
    setItems(items, options) { this.list.setItems(items, options); }
    scrollToIndex(index, align) { this.list.scrollToIndex(index, align); }
    snapshot() { return this.list.snapshot(); }
    destroy() { this.list.destroy(); this.root.remove(); }
  }

  class EditHistory {
    constructor({ limit = 200 } = {}) { this.limit = Math.max(10, limit | 0); this.undoStack = []; this.redoStack = []; this.batch = null; }
    async execute(command) {
      if (!command || typeof command.do !== 'function' || typeof command.undo !== 'function') throw new TypeError('History command needs do and undo');
      const result = await command.do();
      if (this.batch) this.batch.commands.push(command); else this._push(command);
      this.redoStack = []; return result;
    }
    _push(command) {
      const previous = this.undoStack.at(-1);
      if (command.coalesceKey && previous?.coalesceKey === command.coalesceKey && typeof previous.merge === 'function') previous.merge(command);
      else this.undoStack.push(command);
      while (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    begin(label = 'Batch edit') { if (this.batch) throw new Error('A history batch is already active'); this.batch = { label, commands: [] }; }
    commit() {
      const batch = this.batch; this.batch = null; if (!batch?.commands.length) return;
      this._push({ label: batch.label, do: async () => { for (const command of batch.commands) await command.do(); }, undo: async () => { for (const command of [...batch.commands].reverse()) await command.undo(); } });
    }
    cancel() { const batch = this.batch; this.batch = null; return batch ? Promise.all([...batch.commands].reverse().map((command) => command.undo())) : Promise.resolve(); }
    async undo() { const command = this.undoStack.pop(); if (!command) return false; await command.undo(); this.redoStack.push(command); return true; }
    async redo() { const command = this.redoStack.pop(); if (!command) return false; await command.do(); this.undoStack.push(command); return true; }
    preview() { return this.undoStack.map((command) => command.label || command.coalesceKey || 'Edit'); }
    clear() { this.undoStack = []; this.redoStack = []; this.batch = null; }
    get canUndo() { return this.undoStack.length > 0; } get canRedo() { return this.redoStack.length > 0; }
  }

  class MutationState {
    constructor() { this.pending = new Map(); this.conflicts = []; }
    async run(key, optimistic, request, rollback) {
      const id = String(key); if (this.pending.has(id)) return this.pending.get(id);
      const before = optimistic?.();
      const promise = Promise.resolve().then(request).catch((error) => {
        rollback?.(before, error);
        if (error?.conflict) this.conflicts.push({ at: Date.now(), key: id, payload: redact(error.payload) });
        throw error;
      }).finally(() => this.pending.delete(id));
      this.pending.set(id, promise); return promise;
    }
    isPending(key) { return this.pending.has(String(key)); }
    snapshot() { return { pending: [...this.pending.keys()], conflicts: this.conflicts.slice(-50) }; }
  }

  class WorkTabs {
    constructor(workspace = workspaceState, key = currentViewKey()) { this.workspace = workspace; this.key = `tabs:${key}`; this.tabs = workspace.read(this.key, { tabs: [], active: null }); }
    open(tab) { const id = String(tab.id); this.tabs.tabs = [tab, ...this.tabs.tabs.filter((row) => String(row.id) !== id)].slice(0, 12); this.tabs.active = id; this._save(); return tab; }
    close(id) { id = String(id); this.tabs.tabs = this.tabs.tabs.filter((row) => String(row.id) !== id); if (this.tabs.active === id) this.tabs.active = this.tabs.tabs[0]?.id ?? null; this._save(); }
    activate(id) { if (this.tabs.tabs.some((row) => String(row.id) === String(id))) { this.tabs.active = String(id); this._save(); return true; } return false; }
    _save() { this.workspace.remember(this.key, this.tabs); }
    snapshot() { return structuredClone(this.tabs); }
  }

  function objectDiff(before, after, path = '') {
    const output = []; const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    for (const key of keys) {
      const nextPath = path ? `${path}.${key}` : key; const a = before?.[key]; const b = after?.[key];
      if (stableJson(a) === stableJson(b)) continue;
      if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) output.push(...objectDiff(a, b, nextPath));
      else output.push({ path: nextPath, before: a, after: b });
    }
    return output;
  }

  class DraftStore {
    constructor(prefix = 'nodeuo.admin.draft.v2', ttlMs = 14 * 24 * 60 * 60_000) { this.prefix = prefix; this.ttlMs = Math.max(60_000, ttlMs | 0); }
    key(id) { return `${this.prefix}:${id}`; }
    save(id, value, revision = null) { const draft = { value, revision, savedAt: Date.now() }; localStorage.setItem(this.key(id), JSON.stringify(draft)); return draft; }
    load(id) { try { const draft = JSON.parse(localStorage.getItem(this.key(id)) || 'null'); if (draft && Date.now() - Number(draft.savedAt || 0) > this.ttlMs) { this.remove(id); return null; } return draft; } catch { return null; } }
    remove(id) { localStorage.removeItem(this.key(id)); }
    list() { const output = []; for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key?.startsWith(`${this.prefix}:`)) output.push({ id: key.slice(this.prefix.length + 1), ...this.load(key.slice(this.prefix.length + 1)) }); } return output.sort((a, b) => b.savedAt - a.savedAt); }
  }

  const AdminValidators = Object.freeze({
    required: (value) => String(value ?? '').trim() ? '' : 'This field is required.',
    facet: (value) => Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 5 ? '' : 'Facet must be in 0..5.',
    x: (value, form) => Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= (Number(form?.facet) <= 1 ? 7167 : 8191) ? '' : 'X is outside the selected facet.',
    y: (value, form) => Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= (Number(form?.facet) <= 1 ? 4095 : 8191) ? '' : 'Y is outside the selected facet.',
    z: (value) => Number.isInteger(Number(value)) && Number(value) >= -128 && Number(value) <= 127 ? '' : 'Z must be in -128..127.',
    hue: (value) => Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 0xffff ? '' : 'Hue must be in 0..65535.',
    graphic: (value) => Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 0xffff ? '' : 'Graphic must be in 0..65535.',
    body: (value) => Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 0xffff ? '' : 'Body must be in 0..65535.',
    templateName: (value) => /^[a-z0-9][a-z0-9._/-]{0,127}$/i.test(String(value ?? '')) ? '' : 'Use a valid template/script name.',
  });

  class FormSession {
    constructor({ id, initial = {}, rules = {}, draftStore = new DraftStore(), autosaveMs = 700 } = {}) {
      this.id = id || currentViewKey(); this.initial = structuredClone(initial); this.value = structuredClone(initial); this.rules = rules; this.errors = {}; this.store = draftStore; this.autosaveMs = autosaveMs; this.timer = null;
    }
    set(field, value) { this.value[field] = value; this.validateField(field); clearTimeout(this.timer); this.timer = setTimeout(() => this.store.save(this.id, this.value), this.autosaveMs); return this.errors[field]; }
    validateField(field) {
      const validators = Array.isArray(this.rules[field]) ? this.rules[field] : [this.rules[field]].filter(Boolean); const errors = [];
      for (const validator of validators) { const result = validator(this.value[field], this.value); if (result) errors.push(String(result)); }
      if (errors.length) this.errors[field] = errors; else delete this.errors[field]; return errors;
    }
    validate() { for (const field of Object.keys(this.rules)) this.validateField(field); return { ok: Object.keys(this.errors).length === 0, errors: structuredClone(this.errors), firstField: Object.keys(this.errors)[0] || null }; }
    restoreDraft() { const draft = this.store.load(this.id); if (draft?.value) this.value = structuredClone(draft.value); return draft; }
    commit(next = this.value) { this.initial = structuredClone(next); this.value = structuredClone(next); this.store.remove(this.id); clearTimeout(this.timer); }
    get dirty() { return stableJson(this.initial) !== stableJson(this.value); }
    diff() { return objectDiff(this.initial, this.value); }
    get canSave() { return this.validate().ok; }
    errorSummary() { const result = this.validate(); return Object.entries(result.errors).flatMap(([field, messages]) => messages.map((message) => ({ field, message }))); }
  }

  class WorkspaceState {
    constructor(key = 'nodeuo.admin.workspace.v2') { this.key = key; this.data = this._load(); }
    _load() { try { return JSON.parse(localStorage.getItem(this.key) || '{}') || {}; } catch { return {}; } }
    _save() { localStorage.setItem(this.key, JSON.stringify(this.data)); }
    remember(view, payload) { this.data[view] = { ...(this.data[view] || {}), ...payload, at: Date.now() }; this._save(); }
    read(view, fallback = {}) { return { ...fallback, ...(this.data[view] || {}) }; }
    pin(type, id) { const key = `pins:${type}`; const pins = new Set(this.data[key] || []); pins.add(String(id)); this.data[key] = [...pins].slice(-100); this._save(); }
    unpin(type, id) { const key = `pins:${type}`; this.data[key] = (this.data[key] || []).filter((value) => value !== String(id)); this._save(); }
    recent(type, entry, limit = 20) { const key = `recent:${type}`; this.data[key] = [entry, ...(this.data[key] || []).filter((value) => stableJson(value) !== stableJson(entry))].slice(0, limit); this._save(); }
    export() { return structuredClone(this.data); }
    import(value) { if (!value || typeof value !== 'object') throw new TypeError('Workspace import must be an object'); this.data = structuredClone(value); this._save(); }
  }

  class AdminDiagnostics {
    constructor() { this.events = []; this.longTasks = []; this.startedAt = Date.now(); this.observer = null; }
    start() {
      if (typeof global.PerformanceObserver === 'function') { try { this.observer = new global.PerformanceObserver((list) => { for (const entry of list.getEntries()) this.longTasks.push({ at: Date.now(), duration: Math.round(entry.duration), name: entry.name }); this.longTasks = this.longTasks.slice(-100); }); this.observer.observe({ type: 'longtask', buffered: true }); } catch { /* unsupported */ } }
      global.addEventListener('unhandledrejection', (event) => this.record('unhandled-rejection', { message: event.reason?.message || String(event.reason) }));
      global.addEventListener('error', (event) => this.record('error', { message: event.message, file: event.filename, line: event.lineno }));
    }
    record(type, details = {}) { this.events.push({ at: Date.now(), type, details: redact(details) }); this.events = this.events.slice(-300); }
    snapshot() { return redact({ generatedAt: new Date().toISOString(), uptimeMs: Date.now() - this.startedAt, view: `${location.pathname}${location.hash}`, broker: requestBroker.snapshot(), mutations: mutationState.snapshot(), events: [...this.events], longTasks: [...this.longTasks], workspace: workspaceState.export(), drafts: draftStore.list().map(({ id, savedAt }) => ({ id, savedAt })) }); }
    download() { const blob = new Blob([JSON.stringify(this.snapshot(), null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `nodeuo-admin-diagnostics-${Date.now()}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 0); }
  }

  const requestBroker = new RequestBroker();
  const draftStore = new DraftStore();
  const workspaceState = new WorkspaceState();
  const mutationState = new MutationState();
  const diagnostics = new AdminDiagnostics();

  function addCommand(command) {
    if (!command?.id || !command?.label || typeof command.run !== 'function') return;
    state.commands = state.commands.filter((entry) => entry.id !== command.id);
    state.commands.push(command);
  }
  function collectNavigationCommands() {
    document.querySelectorAll('[data-tab]').forEach((button) => addCommand({
      id: `tab:${button.dataset.tab}`,
      label: `Open: ${button.textContent.trim()}`,
      keywords: `navigation tab ${button.dataset.tab}`,
      run: () => button.click(),
    }));
    addCommand({ id: 'open:studio', label: 'Open: Content Studio', keywords: 'editors catalog', run: () => { location.href = '/studio'; } });
    addCommand({ id: 'open:map', label: 'Open: Isometric map editor', keywords: 'map iso terrain statics', run: () => { location.href = '/editor'; } });
    addCommand({ id: 'open:data', label: 'Open: Data tree editor', keywords: 'json data', run: () => { location.href = '/data-editor'; } });
    addCommand({ id: 'view:settings', label: 'View: filters, columns and density', keywords: 'layout compact table preferences', run: openViewSettings });
    addCommand({ id: 'diagnostics:download', label: 'Download: admin diagnostics', keywords: 'performance support report logs', run: () => diagnostics.download() });
  }
  function currentViewKey() { return `${location.pathname}:${location.hash || '#default'}`; }
  function applyViewPreferences() {
    document.documentElement.dataset.adminDensity = preference('layout.density', 'comfortable');
    const hidden = new Set(preference(`columns:${currentViewKey()}`, []));
    document.querySelectorAll('main table').forEach((table) => table.querySelectorAll('tr').forEach((row) => [...row.children].forEach((cell, index) => { cell.hidden = hidden.has(index); })));
  }
  function reportClientMetrics(extra = {}) {
    state.pendingMetrics = { ...(state.pendingMetrics ?? {}), ...extra, view: `${location.pathname}${location.hash}` };
    clearTimeout(metricsTimer);
    metricsTimer = setTimeout(() => {
      const tableRows = Math.max(0, ...[...document.querySelectorAll('main table tbody')].map((body) => body.rows.length), 0);
      const body = { ...state.pendingMetrics, tableRows };
      state.pendingMetrics = {};
      fetch('/api/operations/client-metrics', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
    }, 750);
  }
  function wirePersistentFilters() {
    document.querySelectorAll('main input').forEach((input) => {
      const hint = `${input.id} ${input.placeholder} ${input.type}`.toLowerCase();
      if (!/(filter|search)/.test(hint) || input.dataset.adminPreferenceWired) return;
      input.dataset.adminPreferenceWired = '1';
      const key = `filter:${currentViewKey()}:${input.id || input.placeholder}`;
      const saved = preference(key, '');
      if (saved && !input.value) { input.value = saved; input.dispatchEvent(new Event('input', { bubbles: true })); }
      input.addEventListener('input', () => setPreference(key, input.value));
    });
  }
  function openViewSettings() {
    const table = document.querySelector('main table');
    const headings = table ? [...table.querySelectorAll('thead th')].map((cell, index) => ({ index, label: cell.textContent.trim() || `Column ${index + 1}` })) : [];
    const hidden = new Set(preference(`columns:${currentViewKey()}`, []));
    const root = document.createElement('div'); root.className = 'modal-bg';
    root.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><h3>View settings</h3><label>Density<select data-density><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></label><fieldset><legend>Visible columns in the first table</legend>${headings.map(({ index, label }) => `<label><input type="checkbox" data-column="${index}" ${hidden.has(index) ? '' : 'checked'}> ${escapeHtml(label)}</label>`).join('') || '<p>No table in this view.</p>'}</fieldset><div class="row" style="justify-content:flex-end"><button data-reset>Reset view</button><button data-close>Done</button></div></div>`;
    document.body.appendChild(root);
    const density = root.querySelector('[data-density]'); density.value = preference('layout.density', 'comfortable');
    density.onchange = () => { setPreference('layout.density', density.value); applyViewPreferences(); };
    root.querySelectorAll('[data-column]').forEach((input) => { input.onchange = () => { const values = [...root.querySelectorAll('[data-column]:not(:checked)')].map((item) => Number(item.dataset.column)); setPreference(`columns:${currentViewKey()}`, values); applyViewPreferences(); }; });
    root.querySelector('[data-reset]').onclick = () => { setPreference(`columns:${currentViewKey()}`, []); setPreference('layout.density', 'comfortable'); root.remove(); applyViewPreferences(); };
    root.querySelector('[data-close]').onclick = () => root.remove(); root.addEventListener('keydown', (event) => { if (event.key === 'Escape') root.remove(); }); density.focus();
  }
  function matchingCommands(query) {
    const q = query.trim().toLowerCase();
    if (!q) return state.commands.slice(0, 40);
    const terms = q.split(/\s+/).filter(Boolean);
    const score = (entry) => {
      const text = `${entry.label} ${entry.keywords || ''}`.toLowerCase(); let total = 0;
      for (const term of terms) {
        const direct = text.indexOf(term);
        if (direct >= 0) { total += direct + (text.startsWith(term) ? -20 : 0); continue; }
        let cursor = 0; let gaps = 0;
        for (const char of term) { const found = text.indexOf(char, cursor); if (found < 0) { gaps += 40; continue; } gaps += found - cursor; cursor = found + 1; }
        total += gaps + 20;
      }
      return total;
    };
    return state.commands.map((entry) => ({ entry, score: score(entry) })).filter((row) => row.score < 160)
      .sort((a, b) => a.score - b.score || a.entry.label.localeCompare(b.entry.label)).slice(0, 40).map((row) => row.entry);
  }
  function renderPaletteResults(root) {
    const input = root.querySelector('input');
    const host = root.querySelector('.admin-palette-results');
    const matches = matchingCommands(input.value);
    state.paletteIndex = Math.max(0, Math.min(state.paletteIndex, matches.length - 1));
    host.innerHTML = matches.length ? matches.map((entry, index) => `<button type="button" class="admin-palette-item ${index === state.paletteIndex ? 'active' : ''}" data-command="${escapeHtml(entry.id)}"><span>${escapeHtml(entry.label)}</span><span class="admin-kbd">Enter</span></button>`).join('') : '<div class="admin-state">No matching command.</div>';
    host.querySelectorAll('[data-command]').forEach((button) => button.addEventListener('click', () => runCommand(button.dataset.command, root)));
  }
  function runCommand(id, root) {
    const command = state.commands.find((entry) => entry.id === id);
    root?.remove();
    command?.run();
  }
  function openPalette() {
    if (document.querySelector('.admin-palette-backdrop')) return;
    state.paletteIndex = 0;
    const root = document.createElement('div');
    root.className = 'admin-palette-backdrop';
    root.innerHTML = '<div class="admin-palette" role="dialog" aria-modal="true" aria-label="Command palette"><input type="search" aria-label="Search commands" placeholder="Type a command or view…"><div class="admin-palette-results"></div></div>';
    document.body.appendChild(root);
    const input = root.querySelector('input');
    input.addEventListener('input', () => { state.paletteIndex = 0; renderPaletteResults(root); });
    input.addEventListener('keydown', (event) => {
      const matches = matchingCommands(input.value);
      if (event.key === 'ArrowDown') { event.preventDefault(); state.paletteIndex = Math.min(matches.length - 1, state.paletteIndex + 1); renderPaletteResults(root); }
      if (event.key === 'ArrowUp') { event.preventDefault(); state.paletteIndex = Math.max(0, state.paletteIndex - 1); renderPaletteResults(root); }
      if (event.key === 'Enter') { event.preventDefault(); runCommand(matches[state.paletteIndex]?.id, root); }
      if (event.key === 'Escape') { event.preventDefault(); root.remove(); }
    });
    root.addEventListener('mousedown', (event) => { if (event.target === root) root.remove(); });
    renderPaletteResults(root);
    input.focus();
  }

  async function confirmDanger({ title = 'Confirm operation', message, phrase = '', actionLabel = 'Confirm' }) {
    return new Promise((resolve) => {
      const root = document.createElement('div');
      root.className = 'modal-bg';
      root.innerHTML = `<div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="admin-danger-title"><h3 id="admin-danger-title">${escapeHtml(title)}</h3><p>${escapeHtml(message)}</p>${phrase ? `<label>Type <b>${escapeHtml(phrase)}</b> to continue<input data-confirm-input autocomplete="off" style="width:100%"></label>` : ''}<div class="row" style="justify-content:flex-end;margin-top:16px"><button type="button" data-cancel>Cancel</button><button type="button" class="danger" data-confirm ${phrase ? 'disabled' : ''}>${escapeHtml(actionLabel)}</button></div></div>`;
      document.body.appendChild(root);
      const close = (value) => { root.remove(); resolve(value); };
      const confirm = root.querySelector('[data-confirm]');
      const input = root.querySelector('[data-confirm-input]');
      input?.addEventListener('input', () => { confirm.disabled = input.value !== phrase; });
      root.querySelector('[data-cancel]').addEventListener('click', () => close(false));
      confirm.addEventListener('click', () => close(true));
      root.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(false); });
      (input || root.querySelector('[data-cancel]')).focus();
    });
  }

  function installModalAccessibility() {
    const host = document.getElementById('modal-host');
    if (!host) return;
    const observer = new MutationObserver(() => {
      const modal = host.querySelector('.modal');
      if (!modal) return;
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      const heading = modal.querySelector('h3');
      if (heading) {
        heading.id ||= `admin-modal-title-${Date.now()}`;
        modal.setAttribute('aria-labelledby', heading.id);
      }
      (modal.querySelector('input,select,textarea,button') || modal).focus?.();
    });
    observer.observe(host, { childList: true, subtree: true });
  }

  function boot() {
    if (!state.booted) { diagnostics.start(); state.booted = true; }
    collectNavigationCommands();
    installModalAccessibility();
    document.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openPalette(); }
      if (event.key === 'Escape') document.querySelector('.admin-palette-backdrop')?.remove();
    });
    clearInterval(state.sessionHeartbeat);
    state.sessionHeartbeat = setInterval(() => fetch('/api/auth/me', { credentials: 'same-origin' })
      .then((response) => { if (response.status === 401) { diagnostics.record('session-expired'); location.href = '/login?expired=1'; } })
      .catch((error) => diagnostics.record('session-heartbeat', { message: error.message })), 5 * 60_000);
    document.querySelector('nav')?.setAttribute('aria-label', 'Administration sections');
    document.querySelector('main')?.setAttribute('aria-live', 'polite');
    if (!document.getElementById('admin-view-settings')) {
      const viewButton = document.createElement('button'); viewButton.id = 'admin-view-settings'; viewButton.type = 'button'; viewButton.textContent = 'View'; viewButton.title = 'Saved filters, columns and layout'; viewButton.addEventListener('click', openViewSettings);
      document.querySelector('header>div:last-child')?.prepend(viewButton);
    }
    const main = document.querySelector('main');
    if (main) {
      let enhancementFrame = 0;
      new MutationObserver(() => {
        if (enhancementFrame) return;
        enhancementFrame = requestAnimationFrame(() => {
          enhancementFrame = 0;
          wirePersistentFilters();
          applyViewPreferences();
          reportClientMetrics();
        });
      }).observe(main, { childList: true, subtree: true });
    }
    wirePersistentFilters(); applyViewPreferences(); reportClientMetrics(); syncPreferences();
  }

  global.AdminCore = Object.freeze({
    beginView, viewSignal, toast, renderState, preference, setPreference, syncPreferences,
    addCommand, openPalette, confirmDanger, escapeHtml, reportClientMetrics, boot,
    RequestBroker, VirtualList, VirtualTable, EditHistory, MutationState, WorkTabs, DraftStore, FormSession, WorkspaceState, AdminDiagnostics, AdminValidators,
    requestBroker, mutationState, draftStore, workspaceState, diagnostics, objectDiff, stableJson, redact,
  });
})(window);
