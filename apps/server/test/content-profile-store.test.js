import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContentProfileStore } from '../src/admin/content-profile-store.js';

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeuo-content-profiles-'));
  roots.push(root);
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  const items = path.join(data, 'items.json');
  const monsters = path.join(data, 'monsters.json');
  fs.writeFileSync(items, '[{"definitionId":"katana","damage":10}]');
  fs.writeFileSync(monsters, '[{"definitionId":"dragon","hue":0}]');
  const store = new ContentProfileStore({
    rootDir: path.join(root, 'safe-profiles'),
    sources: [{ key: 'config/items.json', file: items }, { key: 'config/monsters.json', file: monsters }],
  });
  return { root, store, items, monsters };
}

describe('ContentProfileStore', () => {
  it('keeps immutable defaults and checkpoints every published profile change', () => {
    const { store, items } = fixture();
    const initial = store.state();
    expect(initial.profiles).toEqual([expect.objectContaining({
      id: 'factory-defaults', locked: true, fileCount: 2, changedFiles: 0,
    })]);

    store.ensureWritableProfile({ actor: 'admin' });
    fs.writeFileSync(items, '[{"definitionId":"katana","damage":15}]');
    const commit = store.recordFile('config/items.json', { actor: 'admin' });
    expect(commit).toMatchObject({ changed: true, profile: { locked: false, revision: 2, changedFiles: 1 } });
    const workingId = commit.profile.id;

    const defaults = store.restore('factory-defaults', { actor: 'admin' });
    expect(defaults).toMatchObject({ ok: true, activeProfileId: 'factory-defaults', preservedProfileId: workingId });
    expect(JSON.parse(fs.readFileSync(items, 'utf8'))[0].damage).toBe(10);

    const working = store.restore(workingId, { actor: 'admin' });
    expect(working).toMatchObject({ ok: true, activeProfileId: workingId });
    expect(JSON.parse(fs.readFileSync(items, 'utf8'))[0].damage).toBe(15);
    expect(store.export(workingId)).toMatchObject({
      format: 'nodeuo.content-profile',
      files: { 'config/items.json': [{ definitionId: 'katana', damage: 15 }] },
    });
  });

  it('forks unexpected canonical edits before restoring defaults', () => {
    const { store, monsters } = fixture();
    store.state();
    fs.writeFileSync(monsters, '[{"definitionId":"dragon","hue":88}]');
    const result = store.restore('factory-defaults', { actor: 'admin' });
    expect(result.ok).toBe(true);
    expect(result.preservedProfileId).not.toBe('factory-defaults');
    expect(JSON.parse(fs.readFileSync(monsters, 'utf8'))[0].hue).toBe(0);
    expect(store.state().profiles.some((profile) => profile.id === result.preservedProfileId && profile.changedFiles === 1)).toBe(true);
  });
});
