import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const manifestPath = resolve(ROOT, 'apps/scripts/src/data/config/servuo-functional-ports.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

describe('ServUO native functional-port manifest', () => {
  it('maps every helper once to executable code and a regression test', () => {
    const classes = [];
    for (const group of manifest.groups) {
      expect(group.family).toMatch(/^[a-z0-9-]+$/);
      expect(group.classes.length).toBeGreaterThan(0);
      expect(existsSync(resolve(ROOT, group.mechanism)), `${group.family} mechanism`).toBe(true);
      expect(existsSync(resolve(ROOT, group.test)), `${group.family} test`).toBe(true);
      classes.push(...group.classes);
    }
    expect(new Set(classes).size).toBe(classes.length);
    expect(classes.length).toBeGreaterThanOrEqual(60);
  });
});
