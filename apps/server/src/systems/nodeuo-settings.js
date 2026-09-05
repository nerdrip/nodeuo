import fs from 'node:fs';
import path from 'node:path';

const THEME_KEYS = new Set([
  '--uo-gold', '--uo-gold-bright', '--uo-copper', '--uo-ink',
  '--uo-slate', '--uo-muted', '--uo-text', '--uo-danger',
]);

function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function secretValue(source, fallback, key, presenceKey) {
  if (!plain(source) || !own(source, key)) return String(fallback?.[key] ?? '');
  const value = String(source[key] ?? '');
  // The admin API redacts credentials. A blank value paired with the
  // presence marker means "keep what is already stored"; setting the marker
  // to false is the explicit way to clear it.
  if (!value && source[presenceKey] === true) return String(fallback?.[key] ?? '');
  return value;
}

function signingSecret(value, label) {
  const secret = String(value ?? '').slice(0, 256);
  if (secret && secret.length < 16) throw new Error(`${label} must contain at least 16 characters`);
  return secret;
}

function transportEndpoint(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  let endpoint;
  try { endpoint = new URL(text); } catch { throw new Error('WebTransport URL must be a valid https:// URL'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || text.length > 2048) {
    throw new Error('WebTransport URL must use https:// without embedded credentials');
  }
  return endpoint.href;
}

function secureEndpoint(value, label, protocols = ['https:']) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  let endpoint;
  try { endpoint = new URL(text); } catch { throw new Error(`${label} must be a valid URL`); }
  if (!protocols.includes(endpoint.protocol) || endpoint.username || endpoint.password || text.length > 2048) {
    throw new Error(`${label} must use ${protocols.join(' or ')} without embedded credentials`);
  }
  return endpoint.href;
}

function sanitize(input = {}, defaults = {}) {
  const allowedProfiles = new Set(['full', 'minimal', 'gameplay', 'enhanced', 'editor', 'staff']);
  const requestedProfile = String(input.defaultProfile ?? defaults.defaultProfile ?? 'full').toLowerCase();
  const variables = {};
  for (const [key, value] of Object.entries(input.theme?.variables ?? defaults.theme?.variables ?? {})) {
    const text = String(value ?? '').trim();
    if (THEME_KEYS.has(key) && /^#[0-9a-f]{3,8}$/i.test(text)) variables[key] = text;
  }
  const localization = {};
  for (const [locale, source] of Object.entries(input.localization ?? defaults.localization ?? {})) {
    if (!/^[a-z]{2}(?:-[a-z0-9]{2,8})?$/i.test(locale) || !plain(source)) continue;
    const strings = {};
    for (const [key, value] of Object.entries(source).slice(0, 4096)) {
      if (/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(key)) strings[key] = String(value ?? '').slice(0, 4096);
    }
    localization[locale.toLowerCase()] = strings;
  }
  const webTransportUrl = transportEndpoint(input.webTransportUrl ?? defaults.webTransportUrl);
  const features = {};
  for (const [id, enabled] of Object.entries(input.features ?? defaults.features ?? {})) {
    if (/^[a-z0-9][a-z0-9._/-]{0,127}$/i.test(id)) features[id.toLowerCase()] = enabled !== false;
  }
  const aiInput = plain(input.ai) ? input.ai : null;
  const voiceInput = plain(input.voice) ? input.voice : null;
  const aiSource = { ...(defaults.ai ?? {}), ...(aiInput ?? {}) };
  const voiceSource = { ...(defaults.voice ?? {}), ...(voiceInput ?? {}) };
  const networkInput = plain(input.network) ? input.network : null;
  const networkSource = { ...(defaults.network ?? {}), ...(networkInput ?? {}) };
  const compatibilityInput = plain(input.compatibility) ? input.compatibility : null;
  const compatibilitySource = { ...(defaults.compatibility ?? {}), ...(compatibilityInput ?? {}) };
  const defaultCompatibilityNotice = '{label} requires the NodeUO client with the negotiated {feature} feature. You can keep playing normally; only this optional enhanced interface is unavailable.{fallback}';
  const compatibilityNoticeTemplate = String(compatibilitySource.noticeTemplate
    ?? defaultCompatibilityNotice).trim().slice(0, 1000) || defaultCompatibilityNotice;
  const defaultInstances = new Map((defaults.instances ?? []).map((entry) => [entry.id, entry]));
  const instances = [];
  for (const entry of (Array.isArray(input.instances) ? input.instances : defaults.instances ?? []).slice(0, 64)) {
    const id = String(entry?.id ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id)) continue;
    const endpoint = secureEndpoint(entry.url, 'Instance endpoint', ['https:', 'wss:']);
    if (!endpoint) continue;
    instances.push({ id, label: String(entry.label ?? id).slice(0, 96), url: endpoint,
      enabled: entry.enabled !== false, maps: (Array.isArray(entry.maps) ? entry.maps : []).slice(0, 32)
        .map((value) => Math.max(0, Number(value) | 0)),
      secret: signingSecret(secretValue(entry, defaultInstances.get(id), 'secret', 'hasSecret'),
        'Instance signing secret') });
  }
  const cinematics = {};
  for (const [id, timeline] of Object.entries(input.cinematics ?? defaults.cinematics ?? {}).slice(0, 128)) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id) || !Array.isArray(timeline)) continue;
    cinematics[id] = timeline.slice(0, 256).map((cue) => ({
      atMs: Math.max(0, Math.min(60 * 60_000, Number(cue?.atMs) | 0)),
      type: String(cue?.type ?? 'caption').slice(0, 32),
      text: String(cue?.text ?? '').slice(0, 2048),
      value: Number.isFinite(Number(cue?.value)) ? Number(cue.value) : undefined,
      asset: String(cue?.asset ?? '').slice(0, 256),
    })).sort((a, b) => a.atMs - b.atMs);
  }
  return { schema: 2, revision: Math.max(1, Number(input.revision) | 0 || 1),
    defaultProfile: allowedProfiles.has(requestedProfile) ? requestedProfile : 'full',
    theme: { variables }, localization, webTransportUrl, features,
    ai: {
      enabled: aiSource.enabled === true,
      endpoint: secureEndpoint(aiSource.endpoint, 'AI endpoint'),
      model: String(aiSource.model ?? '').slice(0, 128),
      apiKey: secretValue(aiInput, defaults.ai, 'apiKey', 'hasApiKey').slice(0, 4096),
      timeoutMs: Math.max(500, Math.min(15_000, Number(aiSource.timeoutMs) | 0 || 5000)),
    },
    voice: {
      enabled: voiceSource.enabled === true,
      endpoint: secureEndpoint(voiceSource.endpoint, 'Voice endpoint', ['https:', 'wss:']),
      tokenTtlMs: Math.max(10_000, Math.min(10 * 60_000, Number(voiceSource.tokenTtlMs) | 0 || 60_000)),
      secret: signingSecret(secretValue(voiceInput, defaults.voice, 'secret', 'hasSecret'),
        'Voice signing secret'),
    },
    network: {
      bytesPerSecond: Math.max(64 * 1024, Math.min(16 * 1024 * 1024,
        Number(networkSource.bytesPerSecond) | 0 || 512 * 1024)),
      burstBytes: Math.max(64 * 1024, Math.min(32 * 1024 * 1024,
        Number(networkSource.burstBytes) | 0 || 1024 * 1024)),
      criticalReserveBytes: Math.max(4096, Math.min(4 * 1024 * 1024,
        Number(networkSource.criticalReserveBytes) | 0 || 64 * 1024)),
    },
    compatibility: {
      noticesEnabled: compatibilitySource.noticesEnabled !== false,
      noticeCooldownMs: Math.max(5_000, Math.min(60 * 60_000,
        Number(compatibilitySource.noticeCooldownMs) | 0 || 300_000)),
      noticeTemplate: compatibilityNoticeTemplate,
    },
    instances,
    cinematics,
  };
}

export class NodeUOSettingsStore {
  constructor(file, defaults = {}) {
    this.file = path.resolve(file);
    this.defaults = sanitize(defaults);
    this.value = this.defaults;
    try { this.value = sanitize(JSON.parse(fs.readFileSync(this.file, 'utf8')), this.defaults); }
    catch (error) { if (error.code !== 'ENOENT') console.warn(`[nodeuo-settings] ${error.message}`); }
  }
  snapshot() { return structuredClone(this.value); }
  adminSnapshot() {
    const value = this.snapshot();
    value.ai = { ...value.ai, apiKey: '', hasApiKey: !!value.ai?.apiKey };
    value.voice = { ...value.voice, secret: '', hasSecret: !!value.voice?.secret };
    value.instances = value.instances.map((entry) => ({
      ...entry, secret: '', hasSecret: !!entry.secret,
    }));
    return value;
  }
  preview(input) { return sanitize(input, this.value); }
  update(input) {
    const next = sanitize({ ...input, revision: this.value.revision + 1 }, this.value);
    const temporary = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    let descriptor = null;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(temporary, this.file);
    }
    catch (error) {
      if (descriptor != null) try { fs.closeSync(descriptor); } catch { /* best effort */ }
      try { fs.unlinkSync(temporary); } catch { /* best effort */ }
      throw error;
    }
    this.value = next;
    return this.snapshot();
  }
}
