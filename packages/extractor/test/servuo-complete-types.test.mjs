import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const items = JSON.parse(readFileSync(join(ROOT, 'apps/scripts/src/data/config/item-types.json'), 'utf8'));
const mobiles = JSON.parse(readFileSync(join(ROOT, 'apps/scripts/src/data/config/mobile-types.json'), 'utf8'));

test('resolves inherited item art and preserves stable class identity', () => {
    assert.ok(Object.keys(items).length > 5_800);
    assert.partialDeepStrictEqual(items.AloronsBustier, {
      definitionId: 'AloronsBustier', artId: 0x7823, servuoClass: 'AloronsBustier',
    });
    assert.equal(items.BagOfAllReagents.artId, 0x0E76);
    assert.match(items.CrushedCrystals.source, /CrushedCrystals\.cs/);
    assert.equal(items.GreenThorns.script, 'green-thorns');
});

test('contains complete NPC/monster fallbacks with canonical graphics', () => {
    assert.ok(mobiles.length > 1_300);
    const byClass = new Map(mobiles.map((row) => [row.servuoClass, row]));
    assert.partialDeepStrictEqual(byClass.get('Dragon'), { body: 12, role: 'monster' });
    assert.partialDeepStrictEqual(byClass.get('Cow'), { body: 0xD8, role: 'monster' });
    assert.partialDeepStrictEqual(byClass.get('VorpalBunny'), { body: 0xCD, kind: 'vorpal-bunny' });
    assert.partialDeepStrictEqual(byClass.get('IceSnake'), { body: 0x34, kind: 'ice-snake' });
    assert.equal(new Set(mobiles.map((row) => row.kind)).size, mobiles.length);
});
