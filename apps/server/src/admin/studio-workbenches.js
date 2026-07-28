/* Domain-specific visual workbenches for Content Studio. */
(function installContentStudioWorkbenches(global) {
  'use strict';

  const local = { selectedControl: 0, catalog: null, catalogPromise: null };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const esc = (value) => global.AdminCore?.escapeHtml?.(value) ?? String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

  function getPath(host, path) {
    let value = host;
    for (const part of String(path).split('.')) value = value?.[part];
    return value;
  }

  function setPath(host, path, value) {
    const parts = String(path).split('.');
    let target = host;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!target[parts[i]] || typeof target[parts[i]] !== 'object') target[parts[i]] = {};
      target = target[parts[i]];
    }
    target[parts.at(-1)] = value;
  }

  function quickField(label, path, value, type = 'text', options = []) {
    if (type === 'select') return `<label>${esc(label)}<select data-quick-path="${esc(path)}">${options.map((option) => `<option value="${esc(option)}" ${String(value ?? '') === String(option) ? 'selected' : ''}>${esc(option || '—')}</option>`).join('')}</select></label>`;
    if (type === 'boolean') return `<label><span>${esc(label)}</span><input type="checkbox" data-quick-path="${esc(path)}" data-quick-type="boolean" ${value ? 'checked' : ''}></label>`;
    const shown = type === 'range' && Array.isArray(value) ? value.join(', ') : value ?? '';
    return `<label>${esc(label)}<input data-quick-path="${esc(path)}" data-quick-type="${esc(type)}" type="${type === 'number' ? 'number' : 'text'}" value="${esc(shown)}"></label>`;
  }

  function visualField(label, path, value, kind, scope = 'quick') {
    let field = quickField(label, path, value, 'number');
    if (scope === 'control') field = field.replace('data-quick-path=', 'data-control-field=');
    const id = num(value);
    const preview = kind === 'item' ? `<img src="/api/studio/art/${id}" alt="">`
      : kind === 'body' ? `<img src="/api/studio/body-art/${id}" alt="">`
        : kind === 'gump' ? `<img src="/api/studio/gump-art/${id}" alt="">`
          : '<i class="hue-dot"></i>';
    return `<div class="visual-field">${field}<button type="button" class="visual-pick" data-visual-picker="${kind}" data-visual-path="${esc(path)}" data-visual-scope="${scope}" title="Choose ${esc(label)} visually" aria-label="Choose ${esc(label)} visually">${preview}</button></div>`;
  }

  function renderMobile(value) {
    const statsRoot = value.stats && typeof value.stats === 'object' ? 'stats.' : '';
    const stat = (name) => getPath(value, `${statsRoot}${name}`);
    const rangeType = (v) => Array.isArray(v) ? 'range' : 'number';
    const resists = value.resists ?? value.resistances ?? {};
    return `<div class="domain-workbench special-editor" data-special-editor="mobile">
      <div class="special-section"><h5>Identity and body</h5><div class="quick-grid">
        ${quickField('Kind', 'kind', value.kind)}${quickField('Display name', 'name', value.name)}
        ${visualField('Body', 'body', value.body, 'body')}${visualField('Hue', 'hue', value.hue ?? 0, 'hue')}
        ${quickField('Title', 'title', value.title)}${quickField('Notoriety', 'notoriety', value.notoriety ?? 3, 'number')}
      </div></div>
      <div class="special-section"><h5>Stats</h5><div class="quick-grid">
        ${quickField('Strength', `${statsRoot}str`, stat('str'), rangeType(stat('str')))}
        ${quickField('Dexterity', `${statsRoot}dex`, stat('dex'), rangeType(stat('dex')))}
        ${quickField('Intelligence', `${statsRoot}int`, stat('int'), rangeType(stat('int')))}
        ${quickField('HP', `${statsRoot}hp`, stat('hp') ?? value.hp, 'number')}
        ${quickField('HP max', `${statsRoot}hpMax`, stat('hpMax') ?? value.hpMax, 'number')}
        ${quickField('Mana', `${statsRoot}mana`, stat('mana') ?? value.mana, 'number')}
      </div></div>
      <div class="special-section"><h5>Combat and AI</h5><div class="quick-grid">
        ${quickField('AI behavior', 'ai', value.ai ?? value.behavior ?? 'aggressive')}
        ${quickField('Secondary behavior', 'behavior', value.behavior ?? '')}
        ${quickField('Aggro range', 'aggroRange', value.aggroRange ?? 8, 'number')}
        ${quickField('Attack interval ms', 'attackInterval', value.attackInterval ?? 2000, 'number')}
        ${quickField('Damage min', 'dmgMin', value.dmgMin ?? 1, 'number')}
        ${quickField('Damage max', 'dmgMax', value.dmgMax ?? 4, 'number')}
        ${quickField('Armor', 'armor', value.armor ?? value.virtualArmor ?? 0, 'number')}
        ${quickField('Fight mode', 'fightMode', value.fightMode ?? '')}
      </div><div class="row" style="margin-top:8px"><button data-open-bound-script="ai">Edit AI source</button><button data-open-script-picker="ai">Browse AI scripts</button><a class="button" href="/#ai-graphs">Open graph editor in Admin</a></div></div>
      <div class="special-section"><h5>Resistances</h5><div class="quick-grid">
        ${['phys', 'fire', 'cold', 'pois', 'energy'].map((key) => quickField(key, `resists.${key}`, resists[key] ?? 0, 'number')).join('')}
      </div></div>
      <div class="special-section"><h5>Pet, loot and abilities</h5><div class="quick-grid">
        ${quickField('Tameable', 'tameable', value.tameable ?? false, 'boolean')}${quickField('Taming skill', 'tameMinSkill', value.tameMinSkill ?? 0, 'number')}
        ${quickField('Control slots', 'controlSlots', value.controlSlots ?? 1, 'number')}${quickField('Loot table', 'lootTable', value.lootTable ?? '')}
      </div><p class="muted">Skills, abilities, equipment and complex loot remain available in the structured fields below this workbench.</p></div>
    </div>`;
  }

  function renderItem(value) {
    const flags = Array.isArray(value.flags) ? value.flags.join(', ') : value.flags ?? '';
    return `<div class="domain-workbench special-editor" data-special-editor="item">
      <div class="special-section"><h5>Identity and appearance</h5><div class="quick-grid">
        ${quickField('Definition ID', 'definitionId', value.definitionId ?? value.id)}${quickField('Name', 'name', value.name ?? value.label)}
        ${visualField('Art ID', 'artId', value.artId ?? value.itemId, 'item')}${visualField('Hue', 'hue', value.hue ?? 0, 'hue')}
        ${quickField('Amount', 'amount', value.amount ?? 1, 'number')}${quickField('Weight', 'weight', value.weight ?? 1, 'number')}
      </div></div>
      <div class="special-section"><h5>Equipment and container</h5><div class="quick-grid">
        ${quickField('Layer', 'layer', value.layer ?? value.equipLayer ?? 0, 'number')}${visualField('Gump ID', 'gumpId', value.gumpId ?? 0, 'gump')}
        ${quickField('Movable', 'movable', value.movable ?? true, 'boolean')}${quickField('Stackable', 'stackable', value.stackable ?? false, 'boolean')}
        ${quickField('Container', 'container', value.container ?? false, 'boolean')}${quickField('Capacity', 'capacity', value.capacity ?? 0, 'number')}
      </div></div>
      <div class="special-section"><h5>Behavior</h5><div class="quick-grid">
        ${quickField('Item script', 'script', value.script ?? '')}${quickField('Flags (comma separated)', 'flags', flags, 'csv')}
        ${quickField('Durability', 'durability', value.durability ?? value.maxDurability ?? 0, 'number')}${quickField('Decay ms', 'decayMs', value.decayMs ?? 0, 'number')}
      </div><div class="row" style="margin-top:8px"><button data-open-bound-script="item">Edit bound script</button><button data-open-script-picker="item">Browse item scripts</button></div><div data-script-binding-status class="muted"></div></div>
      <div class="special-section"><h5>Custom properties</h5>${renderProperties(value.properties)}<button data-add-property>＋ Property</button></div>
    </div>`;
  }

  function renderSpell(value) {
    const reagents = Array.isArray(value.reagents) ? value.reagents.join(', ') : value.reagents ?? '';
    const script = value.script ?? value.handler ?? '';
    return `<div class="domain-workbench special-editor" data-special-editor="spell">
      <div class="special-section"><h5>Identity and school</h5><div class="quick-grid">
        ${quickField('Spell ID', 'id', value.id ?? value.spellId, 'number')}${quickField('Name', 'name', value.name)}
        ${quickField('School', 'school', value.school ?? 'magery')}${quickField('Circle / tier', 'circle', value.circle ?? value.tier ?? 1, 'number')}
        ${quickField('Skill ID', 'skillId', value.skillId ?? 26, 'number')}${quickField('Words / mantra', value.words != null ? 'words' : 'mantra', value.words ?? value.mantra ?? '')}
      </div></div>
      <div class="special-section"><h5>Casting lifecycle</h5><div class="quick-grid">
        ${quickField('Mana', value.mana != null ? 'mana' : 'manaCost', value.mana ?? value.manaCost ?? 0, 'number')}
        ${quickField('Cast delay ms', value.delayMs != null ? 'delayMs' : 'castTime', value.delayMs ?? value.castTime ?? 0, 'number')}
        ${quickField('Minimum skill', 'minSkill', value.minSkill ?? 0, 'number')}${quickField('Maximum skill', 'maxSkill', value.maxSkill ?? 100, 'number')}
        ${quickField('Requires target', 'requiresTarget', value.requiresTarget ?? false, 'boolean')}${quickField('Target kind', 'target', value.target ?? value.targetKind ?? '')}
        ${quickField('Sound ID', 'soundId', value.soundId ?? 0, 'number')}${quickField('Cooldown ms', 'cooldown', value.cooldown ?? 0, 'number')}
      </div></div>
      <div class="special-section"><h5>Implementation and reagents</h5><div class="quick-grid">
        ${quickField('Spell script', 'script', script)}${quickField('Reagents (comma separated)', 'reagents', reagents, 'csv')}
      </div><div class="row" style="margin-top:8px"><button data-open-bound-script="spell">Edit bound spell script</button><button data-open-script-picker="spell">Browse spell scripts</button><button data-studio-tool="spell">Run safe cast validation</button></div><div data-script-binding-status class="muted"></div><div data-tool-result></div></div>
    </div>`;
  }

  function renderProperties(properties) {
    const entries = Object.entries(properties && typeof properties === 'object' && !Array.isArray(properties) ? properties : {});
    return `<div data-property-list>${entries.map(([key, value], index) => `<div class="quick-grid" data-property="${index}" style="margin-bottom:5px"><label>Key<input data-property-key value="${esc(key)}"></label><label>Value<input data-property-value value="${esc(typeof value === 'object' ? JSON.stringify(value) : value)}"></label><button data-remove-property title="Remove property">×</button></div>`).join('') || '<p class="muted">No custom properties.</p>'}</div>`;
  }

  function gumpNode(control, index, width, height) {
    const x = num(control.x), y = num(control.y);
    const w = Math.max(6, num(control.width ?? control.w, control.type === 'label' ? 120 : 24));
    const h = Math.max(6, num(control.height ?? control.h, control.type === 'label' ? 20 : 24));
    const overflow = x < 0 || y < 0 || x + w > width || y + h > height;
    const selected = index === local.selectedControl;
    let body = '';
    if (control.type === 'panel') {
      const base = num(control.artId ?? control.gumpId, 5054);
      body = `<div class="gump-nine" aria-hidden="true">${Array.from({ length: 9 }, (_unused, part) => `<img src="/api/studio/gump-art/${base + part}" alt="">`).join('')}</div>`;
    }
    else if (control.type === 'image') body = `<img src="/api/studio/gump-art/${num(control.artId ?? control.gumpId, 5054)}" alt="">`;
    else if (control.type === 'button') body = `<img src="/api/studio/gump-art/${num(control.normalId, 4005)}" alt="button ${num(control.buttonId)}">`;
    else if (control.type === 'checkbox' || control.type === 'radio') body = `<img src="/api/studio/gump-art/${num(control.checked ? control.checkedId : control.uncheckedId, control.type === 'radio' ? 208 : 210)}" alt="">`;
    else if (control.type === 'tilepic') body = `<img src="/api/studio/art/${num(control.artId ?? control.itemId)}" alt="">`;
    else if (control.type === 'textentry') body = `<div class="gump-node-entry">${esc(control.text ?? control.initialText ?? 'Text entry')}</div>`;
    else if (control.type === 'html') body = `<div class="gump-node-html">${esc(control.text ?? 'HTML text')}</div>`;
    else if (control.type === 'label') body = `<div class="gump-node-label">${esc(control.text ?? 'Label')}</div>`;
    else if (control.type === 'alpha') body = '<div style="width:100%;height:100%;background:#0008"></div>';
    else body = `<div class="gump-node-page">${esc(control.type)} ${esc(control.page ?? '')}</div>`;
    return `<div class="gump-node ${selected ? 'selected' : ''} ${overflow ? 'overflow' : ''}" data-gump-control="${index}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;z-index:${index + 1}" title="#${index + 1} ${esc(control.type)} · ${x},${y} · ${w}×${h}">${body}${selected && !['page'].includes(control.type) ? '<i class="resize-handle" data-resize-handle></i>' : ''}</div>`;
  }

  function controlInspector(control, index) {
    if (!control) return '<p class="muted">Select a control.</p>';
    const types = ['panel', 'label', 'button', 'textentry', 'image', 'tilepic', 'checkbox', 'radio', 'html', 'alpha', 'page'];
    const common = [
      ['X', 'x', 'number'], ['Y', 'y', 'number'], ['Width', 'width', 'number'], ['Height', 'height', 'number'],
    ];
    const specific = {
      panel: [['Panel art', 'artId', 'number', 'gump'], ['Hue', 'hue', 'number', 'hue']],
      label: [['Text / template', 'text', 'text'], ['Hue', 'hue', 'number', 'hue'], ['Page', 'page', 'number']],
      button: [['Normal art', 'normalId', 'number', 'gump'], ['Pressed art', 'pressedId', 'number', 'gump'], ['Button ID', 'buttonId', 'number'], ['Quit after click', 'quit', 'boolean'], ['Switch page', 'page', 'number']],
      textentry: [['Initial text', 'text', 'text'], ['Hue', 'hue', 'number', 'hue'], ['Entry ID', 'entryId', 'number'], ['Page', 'page', 'number']],
      image: [['Gump art', 'artId', 'number', 'gump'], ['Hue', 'hue', 'number', 'hue'], ['Page', 'page', 'number']],
      tilepic: [['Item art', 'artId', 'number', 'item'], ['Hue', 'hue', 'number', 'hue'], ['Page', 'page', 'number']],
      checkbox: [['Unchecked art', 'uncheckedId', 'number', 'gump'], ['Checked art', 'checkedId', 'number', 'gump'], ['Switch ID', 'switchId', 'number'], ['Checked', 'checked', 'boolean'], ['Page', 'page', 'number']],
      radio: [['Unchecked art', 'uncheckedId', 'number', 'gump'], ['Checked art', 'checkedId', 'number', 'gump'], ['Switch ID', 'switchId', 'number'], ['Checked', 'checked', 'boolean'], ['Page', 'page', 'number']],
      html: [['HTML / text', 'text', 'text'], ['Background', 'background', 'boolean'], ['Scrollbar', 'scrollbar', 'boolean'], ['Page', 'page', 'number']],
      alpha: [['Page', 'page', 'number']],
      page: [['Page number', 'page', 'number']],
    }[control.type] ?? [];
    const field = ([label, key, type, picker]) => picker
      ? visualField(label, key, control[key], picker, 'control')
      : quickField(label, key, control[key], type).replace('data-quick-path=', 'data-control-field=');
    const typeField = quickField('Type', 'type', control.type, 'select', types).replace('data-quick-path=', 'data-control-field=');
    return `<h5>Control #${index + 1} · ${esc(control.type)}</h5><div class="quick-grid gump-control-fields">${typeField}${common.map(field).join('')}${specific.map(field).join('')}</div>
      <div class="row" style="margin-top:8px"><button data-duplicate-control>Duplicate</button><button data-control-back>↓ Back</button><button data-control-front>↑ Front</button><button class="danger" data-delete-control>Delete</button></div>`;
  }

  function renderGump(value) {
    const controls = Array.isArray(value.controls) ? value.controls : [];
    const sourceLinked = value.scope === 'server' && value.mode === 'source-linked';
    local.selectedControl = clamp(local.selectedControl, 0, Math.max(0, controls.length - 1));
    const width = clamp(num(value.width, 320), 40, 1600), height = clamp(num(value.height, 240), 40, 1200);
    const selected = controls[local.selectedControl];
    return `<div class="domain-workbench special-editor" data-special-editor="gump">
      ${sourceLinked ? `<div class="special-section"><h5>Server source link</h5><div class="quick-grid">${quickField('Enable JSON layout override', 'enabled', value.enabled ?? false, 'boolean')}${quickField('Source module', 'source', value.source)}${quickField('Source line', 'sourceLine', value.sourceLine ?? 0, 'number')}${quickField('Stable gump ID', 'gumpId', value.gumpId ?? 0, 'number')}</div><div class="row" style="margin-top:8px"><button data-open-server-gump-source>Edit functional server source</button><span class="muted">When enabled and controls are present, the JSON layout replaces source layout for a unique gumpId. The standard UO packet is unchanged.</span></div></div>` : ''}
      <div class="special-section"><h5>Definition</h5><div class="quick-grid">
        ${quickField('Definition ID', 'definitionId', value.definitionId ?? value.id)}${quickField('Name', 'name', value.name)}
        ${quickField('X', 'x', value.x ?? 100, 'number')}${quickField('Y', 'y', value.y ?? 100, 'number')}
        ${quickField('Width', 'width', width, 'number')}${quickField('Height', 'height', height, 'number')}
        ${quickField('Cannot close', 'noClose', value.noClose ?? false, 'boolean')}${quickField('Cannot move', 'noMove', value.noMove ?? false, 'boolean')}
        ${quickField('Cannot dispose', 'noDispose', value.noDispose ?? false, 'boolean')}${quickField('Cannot resize', 'noResize', value.noResize ?? false, 'boolean')}
      </div></div>
      <div class="special-section"><h5>Visual gump designer</h5><div class="row">
        <button data-add-control="panel">＋ Panel</button><button data-add-control="label">＋ Label</button><button data-add-control="button">＋ Button</button><button data-add-control="textentry">＋ Input</button><button data-add-control="image">＋ Image</button><button data-add-control="tilepic">＋ Item art</button><button data-add-control="checkbox">＋ Check</button><button data-add-control="radio">＋ Radio</button><button data-add-control="html">＋ HTML</button><button data-add-control="alpha">＋ Alpha</button><button data-add-control="page">＋ Page</button>
        <label>Grid <select data-gump-grid><option>1</option><option>2</option><option selected>5</option><option>10</option></select></label>
        <a class="button" href="/docs#gumps">Gump documentation</a>
      </div></div>
      <div class="gump-designer"><div class="gump-canvas-wrap"><div class="gump-stage" data-gump-stage style="width:${width}px;height:${height}px">${controls.map((control, index) => gumpNode(control, index, width, height)).join('')}</div></div>
      <aside class="gump-inspector"><section>${controlInspector(selected, local.selectedControl)}</section><details open><summary>Layers <small>${controls.length}</small></summary><div class="gump-layers">${controls.map((control, index) => `<button class="gump-layer ${index === local.selectedControl ? 'active' : ''}" data-select-control="${index}"><span>${index + 1}</span><span>${esc(control.text ?? control.type)}</span><small>${num(control.x)},${num(control.y)}</small></button>`).join('')}</div></details></aside></div>
      <p class="muted">Drag controls to move them. Use the blue corner to resize. Red inset means the control overflows the gump. Text supports runtime placeholders such as <code>{{player.name}}</code>.</p>
      ${sourceLinked ? '' : '<div class="special-section"><h5>Bundled browser client gumps</h5><p class="muted">Choose the @client/client-gumps.json source above to edit local client layouts. Functional JavaScript remains available from each client record.</p><button data-browse-client-gumps>Browse and edit client source modules</button></div>'}
    </div>`;
  }

  function renderClientGump(value) {
    value.frame ??= { enabled: false, x: 0, y: 0, width: 320, height: 240, opacity: 1 };
    value.behavior ??= { enabled: false, canMove: true, canClose: true, canCloseWithEsc: true, canCloseWithRMB: true };
    value.controlOverrides ??= [];
    const frame = value.frame;
    const overrides = value.controlOverrides;
    local.selectedControl = clamp(local.selectedControl, 0, Math.max(0, overrides.length - 1));
    const width = clamp(num(frame.width, 320), 40, 1600), height = clamp(num(frame.height, 240), 40, 1200);
    const previewControls = overrides.map((override) => ({
      ...override,
      type: override.previewType ?? (override.itemId != null ? 'tilepic' : override.gumpId != null ? 'image' : override.text != null ? 'label' : 'alpha'),
      artId: override.gumpId ?? override.itemId ?? 0,
      text: override.text ?? override.controlId ?? override.path ?? override.className ?? 'override',
      width: override.width ?? 80,
      height: override.height ?? 24,
    }));
    const overrideEditor = (override, index) => `<details class="client-control-override" ${index === local.selectedControl ? 'open' : ''}><summary>#${index + 1} · ${esc(override.controlId || override.path || override.className || 'unmapped control')}</summary><div class="quick-grid">
      ${quickField('Enabled', `controlOverrides.${index}.enabled`, override.enabled ?? true, 'boolean')}
      ${quickField('Stable control ID', `controlOverrides.${index}.controlId`, override.controlId ?? '')}
      ${quickField('Child path', `controlOverrides.${index}.path`, override.path ?? '')}
      ${quickField('Or class name', `controlOverrides.${index}.className`, override.className ?? '')}
      ${quickField('Class occurrence', `controlOverrides.${index}.classIndex`, override.classIndex ?? 0, 'number')}
      ${quickField('X', `controlOverrides.${index}.x`, override.x ?? 0, 'number')}${quickField('Y', `controlOverrides.${index}.y`, override.y ?? 0, 'number')}
      ${quickField('Width', `controlOverrides.${index}.width`, override.width ?? 80, 'number')}${quickField('Height', `controlOverrides.${index}.height`, override.height ?? 24, 'number')}
      ${quickField('Visible', `controlOverrides.${index}.visible`, override.visible ?? true, 'boolean')}${quickField('Opacity', `controlOverrides.${index}.opacity`, override.opacity ?? 1, 'number')}
      ${quickField('Text', `controlOverrides.${index}.text`, override.text ?? '')}${visualField('Hue', `controlOverrides.${index}.hue`, override.hue ?? 0, 'hue')}
      ${visualField('Gump art', `controlOverrides.${index}.gumpId`, override.gumpId ?? 0, 'gump')}${visualField('Item art', `controlOverrides.${index}.itemId`, override.itemId ?? 0, 'item')}
    </div><div class="row" style="margin-top:7px"><button data-select-client-control="${index}">Show on canvas</button><button data-duplicate-client-control="${index}">Duplicate</button><button class="danger" data-delete-client-control="${index}">Delete</button></div></details>`;
    return `<div class="domain-workbench special-editor" data-special-editor="client-gump">
      <div class="special-section"><h5>Bundled client gump</h5><div class="quick-grid">
        ${quickField('Definition ID', 'definitionId', value.definitionId)}${quickField('Display name', 'name', value.name)}
        ${quickField('JavaScript class', 'className', value.className)}${quickField('Runtime type', 'type', value.type ?? '')}
        ${quickField('Source module', 'source', value.source)}${quickField('Abstract base', 'abstract', value.abstract ?? false, 'boolean')}
      </div><div class="row" style="margin-top:8px"><button data-open-client-gump-source>Edit functional JavaScript source</button><a class="button" href="/docs#gumps">Gump documentation</a><span class="muted">JSON stays local to the web client; other UO emulators need no extension.</span></div></div>
      <div class="special-section"><h5>Optional frame override</h5><div class="quick-grid">
        ${quickField('Enable override', 'frame.enabled', frame.enabled ?? false, 'boolean')}
        ${quickField('X', 'frame.x', frame.x ?? 0, 'number')}${quickField('Y', 'frame.y', frame.y ?? 0, 'number')}
        ${quickField('Width', 'frame.width', width, 'number')}${quickField('Height', 'frame.height', height, 'number')}
        ${quickField('Opacity', 'frame.opacity', frame.opacity ?? 1, 'number')}
      </div></div>
      <div class="special-section"><h5>Optional behavior override</h5><div class="quick-grid">
        ${quickField('Enable behavior', 'behavior.enabled', value.behavior.enabled ?? false, 'boolean')}
        ${quickField('Movable', 'behavior.canMove', value.behavior.canMove ?? true, 'boolean')}${quickField('Closable', 'behavior.canClose', value.behavior.canClose ?? true, 'boolean')}
        ${quickField('Close with Esc', 'behavior.canCloseWithEsc', value.behavior.canCloseWithEsc ?? true, 'boolean')}${quickField('Close with RMB', 'behavior.canCloseWithRMB', value.behavior.canCloseWithRMB ?? true, 'boolean')}
      </div></div>
      <div class="gump-designer"><div class="gump-canvas-wrap"><div class="gump-stage client-gump-stage" data-client-gump-stage style="width:${width}px;height:${height}px">${previewControls.map((control, index) => gumpNode(control, index, width, height)).join('')}</div></div>
      <aside class="gump-inspector"><h5>Control overrides</h5><p class="muted"><code>Stable control ID</code> is the preferred mapping and survives code reordering. Child path and class occurrence remain available for legacy gumps.</p><button data-add-client-control>＋ Add control override</button><div class="client-control-overrides">${overrides.map(overrideEditor).join('') || '<p class="muted">No control overrides. The code-authored layout is used unchanged.</p>'}</div></aside></div>
      <p class="muted">The canvas shows authored overrides, not a fake reconstruction of dynamic game state. Reopen a gump after publishing to apply the new catalogue.</p>
    </div>`;
  }

  function render(domain, value) {
    if (domain === 'gumps') return value?.scope === 'client' ? renderClientGump(value) : renderGump(value);
    if (domain === 'mobiles') return renderMobile(value);
    if (domain === 'items') return renderItem(value);
    if (domain === 'spells') return renderSpell(value);
    if (domain === 'create') {
      if (value?.body != null) return renderMobile(value);
      if (value?.artId != null || value?.itemId != null) return renderItem(value);
    }
    return '';
  }

  async function loadCatalog(ctx) {
    if (local.catalog) return local.catalog;
    if (!local.catalogPromise) local.catalogPromise = ctx.request('GET', '/api/studio/script-catalog').then((value) => (local.catalog = value)).finally(() => { local.catalogPromise = null; });
    return local.catalogPromise;
  }

  function parseQuickValue(input) {
    if (input.dataset.quickType === 'boolean') return input.checked;
    if (input.dataset.quickType === 'number') return num(input.value);
    if (input.dataset.quickType === 'range') return input.value.split(/[,;]+/).map((part) => num(part.trim())).slice(0, 2);
    if (input.dataset.quickType === 'csv') return input.value.split(',').map((part) => part.trim()).filter(Boolean);
    return input.value;
  }

  function wireQuickFields(ctx) {
    ctx.root.querySelectorAll('[data-quick-path]').forEach((input) => {
      input.disabled = !ctx.canEdit;
      input.addEventListener('change', () => {
        ctx.beforeMutate();
        setPath(ctx.value, input.dataset.quickPath, parseQuickValue(input));
        ctx.mutated({ rerender: true });
      });
    });
  }

  function pickerChoice(entry, kind) {
    const art = kind === 'hue'
      ? `<i class="hue-swatch" style="background:${esc(entry.color ?? '#000')}"></i>`
      : `<img loading="lazy" src="${esc(entry.preview)}" alt="${esc(entry.name)}">`;
    return `<button type="button" class="asset-choice" data-asset-id="${num(entry.id)}" title="${esc(entry.name)}">${art}<b>${esc(entry.name)}</b><small>${num(entry.id)} · 0x${num(entry.id).toString(16)}${entry.width ? ` · ${num(entry.width)}×${num(entry.height)}` : ''}</small></button>`;
  }

  async function showAssetPicker(ctx, trigger) {
    const kind = trigger.dataset.visualPicker;
    const path = trigger.dataset.visualPath;
    const scope = trigger.dataset.visualScope ?? 'quick';
    const title = { item: 'Item graphics', body: 'Mobile bodies', gump: 'Gump graphics', hue: 'UO hues' }[kind] ?? 'Assets';
    const root = document.createElement('div');
    root.className = 'modal-bg';
    root.innerHTML = `<div class="modal asset-picker-modal" role="dialog" aria-modal="true"><div class="asset-picker-head"><label>Search ${esc(title)}<input data-picker-search placeholder="name, decimal ID, or 0x…" autocomplete="off"></label><button data-close>Close</button></div><div class="asset-picker-grid" data-picker-grid><p class="muted">Loading visual catalogue…</p></div><div class="asset-picker-foot"><span class="muted" data-picker-status></span><button data-picker-prev>← Previous</button><button data-picker-next>Next →</button></div></div>`;
    document.body.appendChild(root);
    const grid = root.querySelector('[data-picker-grid]');
    const status = root.querySelector('[data-picker-status]');
    const search = root.querySelector('[data-picker-search]');
    const prev = root.querySelector('[data-picker-prev]');
    const next = root.querySelector('[data-picker-next]');
    let offset = 0;
    let total = 0;
    let requestVersion = 0;
    const pageSize = 96;
    const load = async () => {
      const version = ++requestVersion;
      grid.setAttribute('aria-busy', 'true');
      try {
        const query = new URLSearchParams({ kind, q: search.value.trim(), offset: String(offset), limit: String(pageSize) });
        const result = await ctx.request('GET', `/api/studio/asset-catalog?${query}`);
        if (version !== requestVersion) return;
        total = num(result.total);
        const entries = result.entries ?? [];
        grid.innerHTML = entries.map((entry) => pickerChoice(entry, kind)).join('') || '<p class="muted">No matching extracted assets.</p>';
        status.textContent = total ? `${offset + 1}–${Math.min(offset + entries.length, total)} of ${total}` : '0 results';
        prev.disabled = offset <= 0;
        next.disabled = offset + entries.length >= total;
        grid.querySelectorAll('[data-asset-id]').forEach((button) => button.onclick = () => {
          const value = num(button.dataset.assetId);
          ctx.beforeMutate();
          if (scope === 'control') {
            const control = ctx.value.controls?.[local.selectedControl];
            if (control) control[path] = value;
          } else setPath(ctx.value, path, value);
          root.remove();
          ctx.mutated({ rerender: true });
        });
      } catch (error) {
        if (version === requestVersion) grid.innerHTML = `<p class="error">${esc(error.message)}</p>`;
      } finally { if (version === requestVersion) grid.removeAttribute('aria-busy'); }
    };
    let searchTimer = 0;
    search.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { offset = 0; load(); }, 180); });
    prev.onclick = () => { offset = Math.max(0, offset - pageSize); load(); };
    next.onclick = () => { offset += pageSize; load(); };
    root.querySelector('[data-close]').onclick = () => root.remove();
    root.addEventListener('mousedown', (event) => { if (event.target === root) root.remove(); });
    root.addEventListener('keydown', (event) => { if (event.key === 'Escape') root.remove(); });
    search.focus();
    await load();
  }

  function wireAssetPickers(ctx) {
    ctx.root.querySelectorAll('[data-visual-picker]').forEach((button) => {
      button.disabled = !ctx.canEdit;
      button.onclick = () => showAssetPicker(ctx, button);
    });
  }

  function scriptEntries(catalog, kind) {
    if (kind === 'ai') return catalog.ai ?? [];
    if (kind === 'spell') return catalog.spells ?? [];
    return catalog.items ?? [];
  }

  function normalizeScriptRef(value) {
    return String(value ?? '').trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/^spells\//i, '').toLowerCase();
  }

  function matchingScript(entries, preferred, value = {}) {
    const refs = [preferred, value.script, value.handler, value.name]
      .map(normalizeScriptRef).filter(Boolean);
    return entries.find((entry) => {
      const path = normalizeScriptRef(entry.path);
      const name = normalizeScriptRef(entry.name);
      return refs.some((ref) => ref === path || ref === name || path.endsWith(`/${ref}`)
        || path.endsWith(`/${ref}.js`) || path.endsWith(`/${ref.replace(/\s+/g, '-')}.js`));
    });
  }

  async function showScriptPicker(ctx, kind, preferred) {
    const catalog = await loadCatalog(ctx);
    const entries = scriptEntries(catalog, kind).filter((entry) => entry.path);
    const matched = matchingScript(entries, preferred, ctx.value);
    const label = kind === 'ai' ? 'AI scripts' : kind === 'spell' ? 'Spell scripts' : 'Item scripts';
    const root = document.createElement('div');
    root.className = 'modal-bg';
    root.innerHTML = `<div class="modal" role="dialog" aria-modal="true"><h3>${label}</h3><label>Implementation<select data-script-choice>${entries.map((entry) => `<option value="${esc(entry.path)}" ${entry === matched ? 'selected' : ''}>${esc(entry.name)} · ${esc(entry.path)}</option>`).join('')}</select></label><div class="row" style="justify-content:flex-end;margin-top:12px"><button data-close>Close</button><button class="primary" data-open ${entries.length ? '' : 'disabled'}>Edit source</button></div></div>`;
    document.body.appendChild(root);
    root.querySelector('[data-close]').onclick = () => root.remove();
    root.querySelector('[data-open]').onclick = () => { const path = root.querySelector('[data-script-choice]').value; root.remove(); openScriptEditor(ctx, path); };
  }

  async function showClientGumpPicker(ctx) {
    const catalog = await loadCatalog(ctx);
    const entries = catalog.clientGumps ?? [];
    const root = document.createElement('div');
    root.className = 'modal-bg';
    root.innerHTML = `<div class="modal asset-picker-modal" role="dialog" aria-modal="true"><h3>Built-in client gumps · ${entries.length}</h3><label>Filter<input data-client-gump-filter placeholder="paperdoll, skills, container…"></label><div class="asset-picker-grid" data-client-gump-list></div><div class="row" style="justify-content:flex-end;margin-top:10px"><button data-close>Close</button></div></div>`;
    document.body.appendChild(root);
    const host = root.querySelector('[data-client-gump-list]');
    const filter = root.querySelector('[data-client-gump-filter]');
    const render = () => {
      const q = filter.value.trim().toLowerCase();
      const shown = entries.filter((entry) => !q || `${entry.name} ${entry.path} ${entry.type ?? ''} ${(entry.classes ?? []).map((row) => row.name).join(' ')}`.toLowerCase().includes(q));
      host.innerHTML = shown.map((entry) => `<button class="asset-choice" data-client-gump="${esc(entry.path)}"><span style="font-size:28px">🪟</span><b>${esc(entry.name)}</b><small>${esc(entry.type ?? entry.classes?.[0]?.name ?? entry.path)}</small></button>`).join('') || '<p class="muted">No matching gumps.</p>';
      host.querySelectorAll('[data-client-gump]').forEach((button) => button.onclick = () => { const path = button.dataset.clientGump; root.remove(); openScriptEditor(ctx, path, { clientGump: true }); });
    };
    filter.oninput = render;
    root.querySelector('[data-close]').onclick = () => root.remove();
    root.addEventListener('mousedown', (event) => { if (event.target === root) root.remove(); });
    render(); filter.focus();
  }

  async function openScriptEditor(ctx, path, { clientGump = false, serverSource = false } = {}) {
    if (!path) { global.AdminCore?.toast?.('No source file is mapped to this runtime behavior.', 'warning'); return; }
    const endpoint = clientGump ? '/api/studio/client-gump-source' : serverSource ? '/api/studio/server-source' : '/api/scripts/file';
    const payload = await ctx.request('GET', `${endpoint}?path=${encodeURIComponent(path)}`);
    const root = document.createElement('div');
    root.className = 'modal-bg script-modal';
    root.innerHTML = `<div class="modal" role="dialog" aria-modal="true" style="width:min(1100px,94vw)"><h3>Edit ${clientGump ? 'client gump' : serverSource ? 'server engine source' : 'script'} · ${esc(path)}</h3><div class="script-meta"><span>${payload.size ?? 0} bytes</span><span data-lines></span><span data-script-status>Loaded; live runtime is unchanged.</span></div><textarea data-script-source spellcheck="false" aria-label="JavaScript source">${esc(payload.content ?? '')}</textarea><div class="row" style="justify-content:flex-end;margin-top:10px"><button data-close>Close</button><button data-reload>Reload from disk</button><button class="primary" data-save ${ctx.canEdit ? '' : 'disabled'}>Validate & save${clientGump || serverSource ? '' : ' & hot-reload'}</button></div></div>`;
    document.body.appendChild(root);
    const source = root.querySelector('[data-script-source]');
    const status = root.querySelector('[data-script-status]');
    let mtime = payload.mtime;
    const lines = () => { root.querySelector('[data-lines]').textContent = `${source.value.split('\n').length} lines`; };
    lines(); source.addEventListener('input', lines);
    source.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') { event.preventDefault(); const start = source.selectionStart; source.setRangeText('  ', start, source.selectionEnd, 'end'); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); root.querySelector('[data-save]').click(); }
    });
    root.querySelector('[data-close]').onclick = () => root.remove();
    root.querySelector('[data-reload]').onclick = async () => { const fresh = await ctx.request('GET', `${endpoint}?path=${encodeURIComponent(path)}`); source.value = fresh.content; mtime = fresh.mtime; lines(); status.textContent = 'Reloaded from disk.'; };
    root.querySelector('[data-save]').onclick = async () => {
      status.textContent = 'Validating temporary module…';
      try {
        const result = await ctx.request('PUT', `${endpoint}?path=${encodeURIComponent(path)}`, { content: source.value, expectedMtime: mtime, reload: !clientGump && !serverSource });
        mtime = result.mtime;
        const savedLabel = clientGump ? 'Saved; Vite will reload it in development'
          : serverSource ? 'Saved; restart the Node server to activate engine changes'
            : 'Saved and hot-reloaded';
        status.textContent = result.reloaded?.ok === false ? `Saved, activation failed: ${result.reloaded.error}` : `${savedLabel}${result.backup ? ` · backup ${result.backup}` : ''}.`;
        local.catalog = null;
        global.AdminCore?.toast?.(`Script ${path} saved.`, 'success');
      } catch (error) { status.textContent = error.message; global.AdminCore?.toast?.(error.message, 'error'); }
    };
  }

  function wireScripts(ctx) {
    ctx.root.querySelectorAll('[data-open-bound-script]').forEach((button) => button.onclick = async () => {
      const kind = button.dataset.openBoundScript;
      const preferred = kind === 'ai' ? (ctx.value.ai ?? ctx.value.behavior) : (ctx.value.script ?? ctx.value.handler ?? ctx.value.name);
      const catalog = await loadCatalog(ctx);
      const entry = matchingScript(scriptEntries(catalog, kind), preferred, ctx.value);
      if (entry?.path) openScriptEditor(ctx, entry.path); else showScriptPicker(ctx, kind, preferred);
    });
    ctx.root.querySelectorAll('[data-open-script-picker]').forEach((button) => button.onclick = () => {
      const kind = button.dataset.openScriptPicker;
      showScriptPicker(ctx, kind, kind === 'ai' ? ctx.value.ai : (ctx.value.script ?? ctx.value.handler ?? ctx.value.name));
    });
    loadCatalog(ctx).then((catalog) => {
      const kind = ctx.domain === 'spells' ? 'spell' : ctx.domain === 'mobiles' || ctx.value?.body != null ? 'ai' : 'item';
      const entries = scriptEntries(catalog, kind);
      const path = kind === 'ai' ? 'ai' : 'script';
      const input = ctx.root.querySelector(`[data-quick-path="${path}"]`);
      if (!input) return;
      const datalist = document.createElement('datalist');
      datalist.id = `studio-${kind}-catalog`;
      datalist.innerHTML = entries.map((entry) => `<option value="${esc(kind === 'spell' ? entry.reference ?? entry.path : entry.name)}">${esc(entry.name)} · ${esc(entry.path ?? 'runtime')}</option>`).join('');
      input.setAttribute('list', datalist.id); input.after(datalist);
      const selected = matchingScript(entries, input.value, ctx.value);
      const status = ctx.root.querySelector('[data-script-binding-status]');
      if (status) status.textContent = selected
        ? `${selected.live === false ? 'Offline' : 'Mapped'} · ${selected.path}${selected.hooks?.length ? ` · ${selected.hooks.join(', ')}` : ''}${selected.hasTick ? ' · ticking' : ''}`
        : input.value ? 'Unregistered binding' : 'No script bound';
    }).catch(() => {});
  }

  function wireProperties(ctx) {
    const rows = [...ctx.root.querySelectorAll('[data-property]')];
    const rebuild = () => {
      const next = {};
      for (const row of rows) {
        if (!row.isConnected) continue;
        const key = row.querySelector('[data-property-key]').value.trim();
        if (!key) continue;
        const raw = row.querySelector('[data-property-value]').value;
        try { next[key] = JSON.parse(raw); } catch { next[key] = raw; }
      }
      ctx.value.properties = next;
    };
    rows.forEach((row) => {
      row.querySelector('[data-remove-property]').onclick = () => { ctx.beforeMutate(); row.remove(); rebuild(); ctx.mutated({ rerender: true }); };
      row.querySelectorAll('input').forEach((input) => input.onchange = () => { ctx.beforeMutate(); rebuild(); ctx.mutated({ rerender: true }); });
    });
    ctx.root.querySelector('[data-add-property]')?.addEventListener('click', () => { ctx.beforeMutate(); ctx.value.properties = { ...(ctx.value.properties ?? {}), [`property${Object.keys(ctx.value.properties ?? {}).length + 1}`]: '' }; ctx.mutated({ rerender: true }); });
  }

  function defaultControl(type, value) {
    const base = { type, x: 20, y: 20, width: 100, height: 24 };
    if (type === 'panel') return { ...base, x: 0, y: 0, width: num(value.width, 320), height: num(value.height, 240), artId: 5054 };
    if (type === 'label') return { ...base, width: 140, height: 20, hue: 1149, text: 'New label' };
    if (type === 'button') return { ...base, width: 30, normalId: 4005, pressedId: 4007, buttonId: 1 };
    if (type === 'textentry') return { ...base, width: 180, hue: 1152, entryId: 1, text: '' };
    if (type === 'image') return { ...base, width: 40, height: 40, artId: 0 };
    if (type === 'tilepic') return { ...base, width: 44, height: 44, artId: 0 };
    if (type === 'checkbox') return { ...base, width: 20, height: 20, uncheckedId: 210, checkedId: 211, switchId: 1 };
    if (type === 'radio') return { ...base, width: 20, height: 20, uncheckedId: 208, checkedId: 209, switchId: 1 };
    if (type === 'html') return { ...base, width: 180, height: 70, text: 'HTML text', background: false, scrollbar: false };
    if (type === 'alpha') return { ...base, width: 180, height: 70 };
    if (type === 'page') return { ...base, width: 80, height: 20, page: 1 };
    return base;
  }

  function wireGump(ctx) {
    const controls = ctx.value.controls ?? (ctx.value.controls = []);
    const rerender = () => ctx.mutated({ rerender: true });
    ctx.root.querySelectorAll('[data-select-control],[data-gump-control]').forEach((node) => node.addEventListener('click', (event) => {
      if (event.target.closest('[data-resize-handle]')) return;
      local.selectedControl = Number(node.dataset.selectControl ?? node.dataset.gumpControl);
      ctx.rerender();
    }));
    ctx.root.querySelectorAll('[data-add-control]').forEach((button) => button.onclick = () => { ctx.beforeMutate(); controls.push(defaultControl(button.dataset.addControl, ctx.value)); local.selectedControl = controls.length - 1; rerender(); });
    ctx.root.querySelectorAll('[data-control-field]').forEach((input) => {
      input.disabled = !ctx.canEdit;
      input.onchange = () => {
        const control = controls[local.selectedControl]; if (!control) return;
        ctx.beforeMutate();
        const value = input.dataset.quickType === 'boolean' ? input.checked : input.type === 'number' ? num(input.value) : input.value;
        if (value === '' && !['text', 'type'].includes(input.dataset.controlField)) delete control[input.dataset.controlField];
        else control[input.dataset.controlField] = value;
        rerender();
      };
    });
    ctx.root.querySelector('[data-delete-control]')?.addEventListener('click', () => { ctx.beforeMutate(); controls.splice(local.selectedControl, 1); local.selectedControl = clamp(local.selectedControl, 0, controls.length - 1); rerender(); });
    ctx.root.querySelector('[data-duplicate-control]')?.addEventListener('click', () => { const control = controls[local.selectedControl]; if (!control) return; ctx.beforeMutate(); controls.splice(local.selectedControl + 1, 0, { ...structuredClone(control), x: num(control.x) + 10, y: num(control.y) + 10 }); local.selectedControl++; rerender(); });
    ctx.root.querySelector('[data-control-front]')?.addEventListener('click', () => { if (local.selectedControl >= controls.length - 1) return; ctx.beforeMutate(); const [control] = controls.splice(local.selectedControl, 1); controls.splice(++local.selectedControl, 0, control); rerender(); });
    ctx.root.querySelector('[data-control-back]')?.addEventListener('click', () => { if (local.selectedControl <= 0) return; ctx.beforeMutate(); const [control] = controls.splice(local.selectedControl, 1); controls.splice(--local.selectedControl, 0, control); rerender(); });

    ctx.root.querySelectorAll('[data-gump-control]').forEach((node) => node.addEventListener('pointerdown', (event) => {
      if (!ctx.canEdit) return;
      event.preventDefault(); event.stopPropagation();
      const index = Number(node.dataset.gumpControl), control = controls[index];
      if (!control) return;
      local.selectedControl = index; ctx.beforeMutate(); node.setPointerCapture(event.pointerId);
      const resize = !!event.target.closest('[data-resize-handle]');
      const startX = event.clientX, startY = event.clientY, x0 = num(control.x), y0 = num(control.y), w0 = num(control.width, node.offsetWidth), h0 = num(control.height, node.offsetHeight);
      const grid = Math.max(1, num(ctx.root.querySelector('[data-gump-grid]')?.value, 5));
      const snap = (v) => Math.round(v / grid) * grid;
      node.onpointermove = (move) => {
        if (resize) { control.width = Math.max(6, snap(w0 + move.clientX - startX)); control.height = Math.max(6, snap(h0 + move.clientY - startY)); node.style.width = `${control.width}px`; node.style.height = `${control.height}px`; }
        else { control.x = snap(x0 + move.clientX - startX); control.y = snap(y0 + move.clientY - startY); node.style.left = `${control.x}px`; node.style.top = `${control.y}px`; }
      };
      node.onpointerup = () => { node.onpointermove = null; node.onpointerup = null; rerender(); };
    }));
    ctx.root.querySelector('[data-browse-client-gumps]')?.addEventListener('click', () => showClientGumpPicker(ctx));
    ctx.root.querySelector('[data-open-server-gump-source]')?.addEventListener('click', () => {
      const source = String(ctx.value.source ?? '');
      if (source.startsWith('@server/')) openScriptEditor(ctx, source.slice('@server/'.length), { serverSource: true });
      else openScriptEditor(ctx, source);
    });
  }

  function wireClientGump(ctx) {
    const overrides = ctx.value.controlOverrides ?? (ctx.value.controlOverrides = []);
    const rerender = () => ctx.mutated({ rerender: true });
    ctx.root.querySelector('[data-open-client-gump-source]')?.addEventListener('click', () => openScriptEditor(ctx, ctx.value.source, { clientGump: true }));
    ctx.root.querySelector('[data-add-client-control]')?.addEventListener('click', () => {
      ctx.beforeMutate();
      overrides.push({ enabled: true, controlId: '', path: '', className: '', classIndex: 0, x: 20, y: 20, width: 80, height: 24, visible: true, opacity: 1 });
      local.selectedControl = overrides.length - 1;
      rerender();
    });
    ctx.root.querySelectorAll('[data-select-client-control]').forEach((button) => button.onclick = () => {
      local.selectedControl = Number(button.dataset.selectClientControl);
      ctx.rerender();
    });
    ctx.root.querySelectorAll('[data-delete-client-control]').forEach((button) => button.onclick = () => {
      ctx.beforeMutate();
      overrides.splice(Number(button.dataset.deleteClientControl), 1);
      local.selectedControl = clamp(local.selectedControl, 0, Math.max(0, overrides.length - 1));
      rerender();
    });
    ctx.root.querySelectorAll('[data-duplicate-client-control]').forEach((button) => button.onclick = () => {
      const index = Number(button.dataset.duplicateClientControl), current = overrides[index];
      if (!current) return;
      ctx.beforeMutate();
      overrides.splice(index + 1, 0, { ...structuredClone(current), x: num(current.x) + 10, y: num(current.y) + 10 });
      local.selectedControl = index + 1;
      rerender();
    });
    ctx.root.querySelectorAll('[data-gump-control]').forEach((node) => {
      node.addEventListener('click', (event) => {
        if (event.target.closest('[data-resize-handle]')) return;
        local.selectedControl = Number(node.dataset.gumpControl);
        ctx.rerender();
      });
      node.addEventListener('pointerdown', (event) => {
        if (!ctx.canEdit) return;
        event.preventDefault(); event.stopPropagation();
        const index = Number(node.dataset.gumpControl), override = overrides[index];
        if (!override) return;
        local.selectedControl = index; ctx.beforeMutate(); node.setPointerCapture(event.pointerId);
        const resize = !!event.target.closest('[data-resize-handle]');
        const startX = event.clientX, startY = event.clientY;
        const x0 = num(override.x), y0 = num(override.y), w0 = num(override.width, node.offsetWidth), h0 = num(override.height, node.offsetHeight);
        const snap = (value) => Math.round(value / 5) * 5;
        node.onpointermove = (move) => {
          if (resize) {
            override.width = Math.max(6, snap(w0 + move.clientX - startX)); override.height = Math.max(6, snap(h0 + move.clientY - startY));
            node.style.width = `${override.width}px`; node.style.height = `${override.height}px`;
          } else {
            override.x = snap(x0 + move.clientX - startX); override.y = snap(y0 + move.clientY - startY);
            node.style.left = `${override.x}px`; node.style.top = `${override.y}px`;
          }
        };
        node.onpointerup = () => { node.onpointermove = null; node.onpointerup = null; rerender(); };
      });
    });
  }

  function wire(ctx) {
    wireQuickFields(ctx);
    wireAssetPickers(ctx);
    if (ctx.domain === 'gumps') ctx.value?.scope === 'client' ? wireClientGump(ctx) : wireGump(ctx);
    if (ctx.domain === 'items' || (ctx.domain === 'create' && ctx.value?.body == null)) wireProperties(ctx);
    if (ctx.domain === 'items' || ctx.domain === 'mobiles' || ctx.domain === 'spells' || ctx.domain === 'create') wireScripts(ctx);
  }

  function newRecord(domain, sourceFile = '') {
    if (domain === 'gumps' && sourceFile === '@client/client-gumps.json') return { definitionId: `client:new-gump-${Date.now().toString(36)}`, scope: 'client', name: 'New client gump', className: '', type: '', source: '', abstract: false, frame: { enabled: false, x: 0, y: 0, width: 320, height: 240, opacity: 1 }, behavior: { enabled: false, canMove: true, canClose: true, canCloseWithEsc: true, canCloseWithRMB: true }, controlOverrides: [] };
    if (domain === 'gumps') return { definitionId: `new-gump-${Date.now().toString(36)}`, name: 'New gump', width: 320, height: 240, x: 100, y: 100, controls: [{ type: 'panel', x: 0, y: 0, width: 320, height: 240, artId: 5054 }] };
    if (domain === 'items') return { definitionId: `new-item-${Date.now().toString(36)}`, artId: 0, name: 'New item', hue: 0, weight: 1, movable: true, script: null };
    if (domain === 'mobiles') return { kind: `new-mobile-${Date.now().toString(36)}`, name: 'New mobile', body: 400, hue: 0, hp: 50, str: 50, dex: 50, int: 50, dmgMin: 1, dmgMax: 4, ai: 'wander' };
    return { name: 'New record' };
  }

  global.ContentStudioWorkbench = Object.freeze({ render, wire, newRecord, openScriptEditor });
})(window);
