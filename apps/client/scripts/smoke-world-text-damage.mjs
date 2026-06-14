import assert from 'node:assert/strict';

const { dominantDamageType, damageColor } = await import('../src/managers/world-text-manager.js');

assert.equal(dominantDamageType('FIRE'), 'fire');
assert.equal(dominantDamageType({ phys: 20, fire: 55, cold: 25 }), 'fire');
assert.equal(dominantDamageType({ poison: 1, energy: 80 }), 'energy');
assert.equal(dominantDamageType(null), 'phys');

assert.equal(damageColor('phys'), 0xFFFFFF);
assert.equal(damageColor('fire'), 0xFF4040);
assert.equal(damageColor('cold'), 0x80B0FF);
assert.equal(damageColor('poison'), 0x60E060);
assert.equal(damageColor('energy'), 0xFFC080);
assert.equal(damageColor('heal'), 0x80FF80);
assert.equal(damageColor({ phys: 5, cold: 70, fire: 25 }), 0x80B0FF);
assert.equal(damageColor('unknown'), 0xFFFFFF);

console.log('[smoke:world-text-damage] ok');
