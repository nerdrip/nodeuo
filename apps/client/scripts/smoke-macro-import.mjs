import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => { store.set(key, String(value)); },
  removeItem: (key) => { store.delete(key); },
};
globalThis.document = globalThis.document ?? {
  addEventListener: () => {},
  removeEventListener: () => {},
};

const { macroManager } = await import('../src/managers/macro-manager.js');

const classicXml = `<?xml version="1.0" encoding="utf-8"?>
<macros>
  <macro name="Heal self" key="1073741882" mousebutton="0" wheelscroll="False" wheelup="False" alt="True" ctrl="False" shift="True">
    <actions>
      <action code="1" subcode="0" submenutype="0" text="bank" />
      <action code="15" subcode="64" submenutype="0" />
      <action code="13" subcode="47" submenutype="0" />
      <action code="28" subcode="0" submenutype="0" text="125" />
      <action code="43" subcode="0" submenutype="0" />
      <action code="70" subcode="0" submenutype="0" text="useskill Hiding&#10;waitfortarget 1500&#10;targetself" />
    </actions>
  </macro>
</macros>`;

assert.equal(macroManager.importFromString(classicXml), 1);
assert.equal(macroManager.macros.length, 1);

const [macro] = macroManager.macros;
assert.equal(macro.name, 'Heal self');
assert.equal(macro.key, 'f1');
assert.equal(macro.alt, true);
assert.equal(macro.shift, true);
assert.equal(macro.ctrl, false);
assert.deepEqual(macro.actions, [
  { kind: 'say', arg: 'bank' },
  { kind: 'cast', arg: 'Heal' },
  { kind: 'use-skill', arg: 'Meditation' },
  { kind: 'delay', arg: '125' },
  { kind: 'enable-range-color' },
  { kind: 'use-skill', arg: 'Hiding' },
  { kind: 'wait-for-target', arg: '1500' },
  { kind: 'target-self' },
]);
assert.equal(JSON.parse(store.get('uo.macros')).length, 1);

const json = JSON.stringify({ macros: [{ hotkey: 'Ctrl+Alt+X', actions: [{ kind: 'say', arg: 'ok' }] }] });
assert.equal(macroManager.importFromString(json), 1);
assert.equal(macroManager.macros[0].key, 'x');
assert.equal(macroManager.macros[0].ctrl, true);
assert.equal(macroManager.macros[0].alt, true);

console.log('[smoke:macro-import] ok');
