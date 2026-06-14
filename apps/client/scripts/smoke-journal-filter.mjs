import assert from 'node:assert/strict';

const {
  compileJournalFilter,
  makeJournalFilterId,
  normalizeJournalFilters,
} = await import('../src/shared/journal-filter.js');

const bankLine = {
  name: 'Banker',
  text: 'Thou hast 420 gold in thy account.',
  textType: 0,
  hue: 0x0456,
};

const guildLine = {
  name: 'Ari',
  text: 'meet at the gate',
  textType: 3,
  hue: 0x0044,
};

assert.equal(compileJournalFilter('Contains(gold)')(bankLine), true);
assert.equal(compileJournalFilter('Contains(gold) && name:guard')(bankLine), false);
assert.equal(compileJournalFilter('Contains(gold) && !name:guard')(bankLine), true);
assert.equal(compileJournalFilter('type:guild || hue:0x0456')(bankLine), true);
assert.equal(compileJournalFilter('type:guild || hue:0x0456')(guildLine), true);
assert.equal(compileJournalFilter('regex:^thou')(bankLine), true);

const normalized = normalizeJournalFilters([
  { id: 'bank', label: 'Bank words', expr: 'Contains(bank)' },
  { id: 'empty', label: 'Empty', expr: '   ' },
]);
assert.deepEqual(normalized, [{ id: 'custom:bank', label: 'Bank words', expr: 'Contains(bank)' }]);
assert.equal(makeJournalFilterId('Bank words', normalized), 'custom:bank-words');

console.log('[smoke:journal-filter] ok');
