import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeUOSettingsStore } from '../src/systems/nodeuo-settings.js';

const temporary = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function store(defaults = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-settings-'));
  temporary.push(directory);
  const file = path.join(directory, 'nodeuo-settings.json');
  return { file, value: new NodeUOSettingsStore(file, defaults) };
}

describe('NodeUO live client settings', () => {
  it('sanitizes, versions, atomically persists, and reloads settings', () => {
    const { file, value } = store({ theme: { variables: { '--uo-gold': '#c90' } } });
    const saved = value.update({
      theme: { variables: { '--uo-gold': '#ffcc00', '--not-allowed': '#fff' } },
      localization: { 'pl-PL': { 'npc.talk': 'Rozmawiaj', '<unsafe>': 'drop' } },
      webTransportUrl: 'https://h3.example.test/nodeuo',
      compatibility: { noticesEnabled: true, noticeCooldownMs: 12_345,
        noticeTemplate: '{label}: use NodeUO.{fallback}' },
    });

    expect(saved).toMatchObject({
      schema: 2, revision: 2, defaultProfile: 'full',
      theme: { variables: { '--uo-gold': '#ffcc00' } },
      localization: { 'pl-pl': { 'npc.talk': 'Rozmawiaj' } },
      webTransportUrl: 'https://h3.example.test/nodeuo',
      compatibility: { noticesEnabled: true, noticeCooldownMs: 12_345,
        noticeTemplate: '{label}: use NodeUO.{fallback}' },
    });
    expect(fs.readdirSync(path.dirname(file))).toEqual(['nodeuo-settings.json']);
    expect(new NodeUOSettingsStore(file).snapshot()).toEqual(saved);
  });

  it('retains omitted sections and rejects an insecure transport endpoint', () => {
    const { value } = store({ localization: { en: { greeting: 'Hello' } } });
    value.update({ theme: { variables: { '--uo-text': '#eee' } } });
    expect(value.snapshot().localization.en.greeting).toBe('Hello');
    expect(() => value.update({ webTransportUrl: 'http://localhost:4433' })).toThrow(/https:\/\//);
    expect(() => value.update({ voice: { secret: 'short' } })).toThrow(/at least 16/);
    expect(value.update({ defaultProfile: 'minimal' }).defaultProfile).toBe('minimal');
    expect(value.update({ defaultProfile: 'unknown' }).defaultProfile).toBe('full');
    expect(value.snapshot().revision).toBe(4);
  });

  it('merges partial service settings and never exposes stored credentials to the admin UI', () => {
    const { file, value } = store({
      ai: { enabled: true, endpoint: 'https://ai.example.test/v1', apiKey: 'ai-secret' },
      voice: { enabled: true, endpoint: 'wss://voice.example.test', secret: 'voice-secret-1234' },
      instances: [{ id: 'dungeon', url: 'wss://dungeon.example.test', secret: 'route-secret-1234' }],
    });
    const redacted = value.adminSnapshot();
    expect(redacted.ai).toMatchObject({ apiKey: '', hasApiKey: true });
    expect(redacted.voice).toMatchObject({ secret: '', hasSecret: true });
    expect(redacted.instances[0]).toMatchObject({ secret: '', hasSecret: true });

    value.update({
      ai: { ...redacted.ai, model: 'new-model' },
      voice: redacted.voice,
      instances: redacted.instances,
    });
    expect(value.snapshot()).toMatchObject({
      ai: { model: 'new-model', apiKey: 'ai-secret' },
      voice: { secret: 'voice-secret-1234' },
      instances: [{ id: 'dungeon', secret: 'route-secret-1234' }],
    });
    value.update({ features: { 'npc.generative': false } });
    expect(new NodeUOSettingsStore(file).snapshot()).toMatchObject({
      revision: 3, features: { 'npc.generative': false }, ai: { apiKey: 'ai-secret' },
    });
  });
});
