import assert from 'node:assert/strict';

globalThis.CanvasRenderingContext2D = globalThis.CanvasRenderingContext2D ?? function CanvasRenderingContext2D() {};
globalThis.document = globalThis.document ?? {
  createElement: () => ({
    getContext: () => ({
      font: '',
      measureText: (text) => ({
        width: String(text ?? '').length * 6,
        actualBoundingBoxAscent: 9,
        actualBoundingBoxDescent: 3,
        fontBoundingBoxAscent: 9,
        fontBoundingBoxDescent: 3,
      }),
    }),
  }),
};

const { TextInput } = await import('../src/ui/controls/text-input.js');

let changes = [];
const input = new TextInput({ value: '42', maxLength: 4 });
input.onChange = (value) => changes.push(value);

assert.equal(input.value, '42');
input.setValue('12345');
assert.equal(input.value, '1234');
assert.deepEqual(changes, ['1234']);

input.onKeyDown({ key: 'Backspace', preventDefault: () => {} });
assert.equal(input.value, '123');
assert.equal(changes.at(-1), '123');

input.onKeyDown({ key: 'x', preventDefault: () => {}, ctrlKey: false, metaKey: false });
assert.equal(input.value, '123x');
assert.equal(changes.at(-1), '123x');

input.onKeyDown({ key: 'ArrowLeft', preventDefault: () => {} });
assert.equal(changes.at(-1), '123x');

console.log('[smoke:text-input] ok');
