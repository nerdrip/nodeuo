// Canonical data-driven gump compiler.
//
// Content Studio writes config/gumps.json. This module converts those visual
// records into the unchanged Ultima Online layout/text-table protocol used by
// gumps.send(). Dynamic values use {{path.to.value}} placeholders.

const SUPPORTED = new Set([
  'panel', 'label', 'button', 'textentry', 'checkbox', 'radio', 'image', 'tilepic', 'html', 'page', 'alpha',
]);

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function valueAt(values, path) {
  let value = values;
  for (const part of String(path).split('.')) value = value?.[part];
  return value;
}

export function interpolateGumpText(text, values = {}) {
  return String(text ?? '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, key) => {
    const value = valueAt(values, key);
    return value == null ? '' : String(value);
  });
}

/** Compile one Content Studio definition to a protocol-ready gump. */
export function compileGumpDefinition(definition, values = {}) {
  if (!definition || typeof definition !== 'object') throw new Error('gump definition must be an object');
  const controls = Array.isArray(definition.controls) ? definition.controls : [];
  const layout = [];
  const texts = [];
  if (definition.noClose) layout.push('{ noclose }');
  if (definition.noMove) layout.push('{ nomove }');
  if (definition.noDispose) layout.push('{ nodispose }');
  if (definition.noResize) layout.push('{ noresize }');
  const addText = (text) => {
    const index = texts.length;
    texts.push(interpolateGumpText(text, values));
    return index;
  };

  for (const control of controls) {
    if (!control || !SUPPORTED.has(control.type) || control.hidden) continue;
    const x = number(control.x), y = number(control.y);
    const width = Math.max(1, number(control.width ?? control.w, 100));
    const height = Math.max(1, number(control.height ?? control.h, 20));
    switch (control.type) {
      case 'panel':
        layout.push(`{ resizepic ${x} ${y} ${number(control.artId ?? control.gumpId, 5054)} ${width} ${height} }`);
        break;
      case 'label':
        layout.push(`{ text ${x} ${y} ${number(control.hue, 1149)} ${addText(control.text)} }`);
        break;
      case 'html':
        layout.push(`{ htmlgump ${x} ${y} ${width} ${height} ${addText(control.text)} ${control.background ? 1 : 0} ${control.scrollbar ? 1 : 0} }`);
        break;
      case 'button':
        layout.push(`{ button ${x} ${y} ${number(control.normalId, 4005)} ${number(control.pressedId, 4007)} ${number(control.quit ?? 1)} ${number(control.page)} ${number(control.buttonId)} }`);
        break;
      case 'textentry':
        layout.push(`{ textentry ${x} ${y} ${width} ${height} ${number(control.hue, 1152)} ${number(control.entryId)} ${addText(control.text ?? control.initialText)} }`);
        break;
      case 'checkbox':
        layout.push(`{ checkbox ${x} ${y} ${number(control.uncheckedId, 210)} ${number(control.checkedId, 211)} ${control.checked ? 1 : 0} ${number(control.switchId)} }`);
        break;
      case 'radio':
        layout.push(`{ radio ${x} ${y} ${number(control.uncheckedId, 208)} ${number(control.checkedId, 209)} ${control.checked ? 1 : 0} ${number(control.switchId)} }`);
        break;
      case 'image':
        layout.push(`{ gumppic ${x} ${y} ${number(control.artId ?? control.gumpId)}${control.hue ? ` hue=${number(control.hue)}` : ''} }`);
        break;
      case 'tilepic':
        layout.push(`{ tilepic${control.hue ? 'hue' : ''} ${x} ${y} ${number(control.artId ?? control.itemId)}${control.hue ? ` ${number(control.hue)}` : ''} }`);
        break;
      case 'page':
        layout.push(`{ page ${number(control.page)} }`);
        break;
      case 'alpha':
        layout.push(`{ checkertrans ${x} ${y} ${width} ${height} }`);
        break;
      default:
        break;
    }
  }

  return {
    x: number(definition.x, 100),
    y: number(definition.y, 100),
    gumpId: number(definition.gumpId),
    layout: layout.join(' '),
    texts,
  };
}

export function configuredGump(definitions, id, values, fallback) {
  const definition = definitions?.get?.(id)
    ?? (Array.isArray(definitions) ? definitions.find((entry) => (entry.definitionId ?? entry.id) === id) : null);
  return definition ? compileGumpDefinition(definition, values) : fallback;
}
