// CraftGump — searchable, stable recipe browser for NodeUO's crafting
// bridge. Transport remains ordinary UO system text/commands; no standard
// packet or opcode is changed. A foreign client simply uses the server's
// normal command/gump path.

import { WindowGump } from './window-gump.js';
import { Graphics } from 'pixi.js';
import { Label } from '../controls/label.js';
import { Button, ButtonAction } from '../controls/button.js';
import { ScrollArea } from '../controls/scroll-area.js';
import { TextInput } from '../controls/text-input.js';
import { CroppedText } from '../controls/cropped-text.js';
import { ItemPic } from '../controls/item-pic.js';
import { SemanticPanel } from '../controls/semantic.js';
import { bus } from '../../core/event-bus.js';

const ROW_H = 34;
const LIST_W = 354;
const STORAGE_FAVORITES = 'uo.craft.favorites.v1';
const STORAGE_HISTORY = 'uo.craft.history.v1';

function readJson(key, fallback) {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem?.(key) ?? 'null');
    return value ?? fallback;
  } catch { return fallback; }
}

function writeJson(key, value) {
  try { globalThis.localStorage?.setItem?.(key, JSON.stringify(value)); } catch { /* quota/private mode */ }
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export class CraftGump extends WindowGump {
  /** @param {{ net?: any, skill?: string, skillVal?: number, recipes?: Array<{id,name,skillId,min,max}> }} opts */
  constructor(opts = {}) {
    const recipes = Array.isArray(opts.recipes) ? opts.recipes : [];
    const skill = String(opts.skill ?? 'all');
    const skillVal = safeNumber(opts.skillVal);
    super({ title: `Crafting — ${skill}`, width: 600, height: 540, x: 200, y: 100 });
    this._net = opts.net;
    this._skillVal = skillVal;
    this._allRecipes = recipes
      .filter((r) => r && Number.isFinite(Number(r.id)))
      .map((r) => ({
        ...r,
        id: Number(r.id) | 0,
        name: String(r.name || `Recipe ${Number(r.id) | 0}`),
        min: safeNumber(r.min),
        max: safeNumber(r.max, 100),
        category: String(r.category || 'Other'),
        outputItemId: safeNumber(r.outputItemId) | 0,
        outputCount: Math.max(1, safeNumber(r.outputCount, 1) | 0),
        inputs: Array.isArray(r.inputs) ? r.inputs.slice(0, 16) : [],
        toolKind: String(r.toolKind || ''),
        success: Math.max(0, Math.min(1, safeNumber(r.success))),
        exceptional: Math.max(0, Math.min(1, safeNumber(r.exceptional))),
        materials: Array.isArray(r.materials) ? r.materials : [],
      }));
    this._onlyCraftable = false;
    this._lastRecipe = null;
    this._selectedRecipe = this._allRecipes[0] ?? null;
    this._favorites = new Set(readJson(STORAGE_FAVORITES, []).map(Number));
    this._history = readJson(STORAGE_HISTORY, []).map(Number).filter(Number.isFinite).slice(0, 20);
    this._quantity = 1;
    this._materialIndex = 0;
    this._busy = false;
    this._rows = [];
    this._unsubs = [];

    this._skillLabel = this.addContent(new Label(`Skill: ${skillVal.toFixed(1)}`, {
      fontSize: 13, hue: 0xffe0a0, fontWeight: 650,
    }), 12, 30);
    this._countLabel = this.addContent(new Label('', {
      fontSize: 11, hue: 0xb8ab91,
    }), 180, 33);

    this._search = new TextInput({
      width: 230, height: 24, placeholder: 'Search recipes…', fontSize: 12,
    });
    this._search.onChange = () => this._renderRecipes();
    this.addContent(this._search, 12, 58);

    this._filterButton = this._makeButton('Craftable: all', 250, 58, 118, () => {
      this._onlyCraftable = !this._onlyCraftable;
      this._filterButton.setLabel(this._onlyCraftable ? 'Craftable: yes' : 'Craftable: all');
      this._renderRecipes();
    });
    this._lastButton = this._makeButton('Make last', 376, 58, 96, () => {
      if (this._lastRecipe) this._craft(this._lastRecipe);
    });
    this._favoriteFilter = this._makeButton('★ All', 480, 58, 90, () => {
      this._favoritesOnly = !this._favoritesOnly;
      this._favoriteFilter.setLabel(this._favoritesOnly ? '★ Favorites' : '★ All');
      this._renderRecipes();
    });

    this._scroll = new ScrollArea({ width: LIST_W, height: 420 });
    this.addContent(this._scroll, 12, 92);
    this._buildDetails();
    for (const [index, action] of [
      ['Repair', 'repair'], ['Smelt', 'smelt'], ['Enhance', 'enhance'], ['Imbue', 'imbueattrs gump'],
    ].entries()) {
      this._makeButton(action[0], 12 + index * 92, 516, 84, () => this._sendCmd(action[1]));
    }
    this._unsubs.push(bus.on('ui:craft:progress', (event) => this._onProgress(event)));
    this._renderRecipes();
    this._renderDetails();
  }

  get type() { return 'craft'; }

  _makeButton(label, x, y, width, onClick) {
    const button = new Button({
      normalGumpId: 0, pressedGumpId: 0,
      width, height: 24, label, flat: true,
      action: ButtonAction.Activate,
    });
    button.setPosition(x, y);
    button.onClick = onClick;
    this.add(button);
    return button;
  }

  _visibleRecipes() {
    const q = this._search?.value?.trim().toLocaleLowerCase() ?? '';
    return this._allRecipes
      .filter((recipe) => !q || recipe.name.toLocaleLowerCase().includes(q))
      .filter((recipe) => !this._onlyCraftable || this._skillVal >= recipe.min)
      .filter((recipe) => !this._favoritesOnly || this._favorites.has(recipe.id))
      .sort((a, b) => {
        const af = this._favorites.has(a.id) ? 0 : 1;
        const bf = this._favorites.has(b.id) ? 0 : 1;
        const ac = this._skillVal >= a.min ? 0 : 1;
        const bc = this._skillVal >= b.min ? 0 : 1;
        return af - bf || ac - bc || a.category.localeCompare(b.category) || a.name.localeCompare(b.name);
      });
  }

  _buildDetails() {
    const x = 378;
    this._detailBg = new SemanticPanel({ width: 192, height: 420, label: 'Recipe details' });
    this._detailBg.setPosition(x, 92);
    this.add(this._detailBg);
    this._preview = new ItemPic(0, {});
    this._preview.setPosition(x + 74, 112);
    this._preview.acceptMouseInput = false;
    this.add(this._preview);
    this._detailName = this.addContent(new CroppedText('', {
      width: 168, height: 22, fontSize: 13, hue: 0xffe4a3,
    }), x + 12, 158);
    this._detailMeta = this.addContent(new Label('', {
      fontSize: 11, hue: 0xcbbd9e, maxWidth: 168, wordWrap: true, lineHeight: 16,
    }), x + 12, 184);
    this._quantityLabel = this.addContent(new Label('Quantity', { fontSize: 11, hue: 0xb8ab91 }), x + 12, 338);
    this._quantityInput = new TextInput({ width: 48, height: 24, value: '1', fontSize: 12 });
    this._quantityInput.setPosition(x + 70, 332);
    this._quantityInput.onChange = (value) => {
      this._quantity = Math.max(1, Math.min(50, Number.parseInt(value, 10) || 1));
    };
    this.add(this._quantityInput);
    this._makeButton('−', x + 124, 332, 28, () => this._setQuantity(this._quantity - 1));
    this._makeButton('+', x + 156, 332, 28, () => this._setQuantity(this._quantity + 1));
    this._favoriteButton = this._makeButton('☆ Favorite', x + 12, 368, 80, () => this._toggleFavorite());
    this._craftButton = this._makeButton('Make', x + 98, 368, 86, () => {
      if (this._selectedRecipe) this._craft(this._selectedRecipe);
    });
    this._materialButton = this._makeButton('Material: automatic', x + 12, 302, 172, () => this._cycleMaterial());
    this._progressBg = new SemanticPanel({ width: 172, height: 12 });
    this._progressBg.setPosition(x + 12, 408);
    this.add(this._progressBg);
    this._progressFill = new Graphics();
    this.node.addChild(this._progressFill);
    this._progressLabel = this.addContent(new Label('Ready', { fontSize: 10, hue: 0xa99f8b }), x + 12, 426);
    this._cancelButton = this._makeButton('Cancel queue', x + 12, 452, 172, () => this._sendCmd('craft cancel'));
    this._cancelButton.node.visible = false;
    const historyNames = this._history.slice(0, 3).map((id) => this._allRecipes.find((r) => r.id === id)?.name).filter(Boolean);
    this._historyLabel = this.addContent(new Label(
      historyNames.length ? `Recent: ${historyNames.join(', ')}` : 'Recent: none',
      { fontSize: 9, hue: 0x8f8778, maxWidth: 168, wordWrap: true, lineHeight: 12 },
    ), x + 12, 480);
  }

  _setQuantity(value) {
    this._quantity = Math.max(1, Math.min(50, value | 0));
    this._quantityInput?.setValue?.(String(this._quantity));
  }

  _toggleFavorite() {
    const recipe = this._selectedRecipe;
    if (!recipe) return;
    if (this._favorites.has(recipe.id)) this._favorites.delete(recipe.id);
    else this._favorites.add(recipe.id);
    writeJson(STORAGE_FAVORITES, [...this._favorites]);
    this._renderRecipes();
    this._renderDetails();
  }

  _cycleMaterial() {
    const options = this._selectedRecipe?.materials ?? [];
    if (!options.length) return;
    this._materialIndex = (this._materialIndex + 1) % options.length;
    const material = options[this._materialIndex];
    this._materialButton.setLabel(`Material: ${material.name}`);
    this._preview?.setHue?.(material.hue || 0);
    this._sendCmd(`craft material ${material.name}`);
  }

  _select(recipe) {
    this._selectedRecipe = recipe;
    this._renderDetails();
  }

  _renderDetails() {
    const recipe = this._selectedRecipe;
    if (!recipe) {
      this._detailName?.setText?.('Select a recipe');
      this._detailMeta?.setText?.('');
      return;
    }
    this._preview?.setItemId?.(recipe.outputItemId || 0);
    const materials = recipe.materials ?? [];
    this._materialIndex = Math.min(this._materialIndex, Math.max(0, materials.length - 1));
    const material = materials[this._materialIndex];
    this._materialButton.node.visible = materials.length > 0;
    this._materialButton.setLabel(material ? `Material: ${material.name}` : 'Material: automatic');
    this._preview?.setHue?.(material?.hue || 0);
    this._preview.node.visible = recipe.outputItemId > 0;
    this._detailName.setText(recipe.name);
    const inputs = recipe.inputs.length
      ? recipe.inputs.map((i) => `${i.name || `0x${(i.itemId >>> 0).toString(16)}`} ×${i.count}`).join('\n')
      : 'Server validates required resources';
    const success = Number.isFinite(recipe.success) ? `${Math.round(recipe.success * 100)}%` : 'server';
    const exceptional = recipe.exceptional > 0 ? `${Math.round(recipe.exceptional * 100)}%` : '—';
    this._detailMeta.setText(
      `${recipe.category}\nSkill ${recipe.min.toFixed(1)}–${recipe.max.toFixed(1)}\n` +
      `Success ${success} · Exceptional ${exceptional}\nOutput: 0x${(recipe.outputItemId >>> 0).toString(16)} ×${recipe.outputCount}\n` +
      `Tool: ${recipe.toolKind || 'recipe default'}\nResources:\n${inputs}`,
    );
    this._favoriteButton?.setLabel?.(this._favorites.has(recipe.id) ? '★ Favorite' : '☆ Favorite');
    const enabled = this._skillVal >= recipe.min && !this._busy;
    this._craftButton.enabled = enabled;
    this._craftButton.acceptMouseInput = enabled;
    this._craftButton.node.alpha = enabled ? 1 : 0.45;
  }

  _clearRows() {
    for (const control of this._rows) {
      try { control.dispose?.(); } catch { /* already disposed */ }
    }
    this._rows.length = 0;
  }

  _renderRecipes() {
    if (!this._scroll || this._scroll.node?.destroyed) return;
    this._clearRows();
    const recipes = this._visibleRecipes();
    this._countLabel.setText(`${recipes.length}/${this._allRecipes.length} recipes`);
    this._scroll.beginBulkUpdate();
    for (let i = 0; i < recipes.length; i++) {
      const recipe = recipes[i];
      const y = i * ROW_H;
      const canCraft = this._skillVal >= recipe.min;
      const favorite = new Button({
        normalGumpId: 0, pressedGumpId: 0, width: 24, height: 24,
        label: this._favorites.has(recipe.id) ? '★' : '☆', flat: true,
        action: ButtonAction.Activate,
      });
      favorite.setPosition(4, y + 2);
      favorite.onClick = () => { this._selectedRecipe = recipe; this._toggleFavorite(); };
      this._scroll.add(favorite);
      this._rows.push(favorite);
      const name = new CroppedText(recipe.name, {
        width: 186, height: 20, fontSize: 12,
        hue: canCraft ? 0xfff0c0 : 0x81796c,
      });
      name.setPosition(34, y + 4);
      name.acceptMouseInput = true;
      name.onMouseDown = () => this._select(recipe);
      this._scroll.add(name);
      this._rows.push(name);

      const range = new Label(`${recipe.min.toFixed(0)}+`, {
        fontSize: 10, hue: canCraft ? 0xb9d9ad : 0x81796c,
      });
      range.setPosition(226, y + 7);
      this._scroll.add(range);
      this._rows.push(range);

      const button = new Button({
        normalGumpId: 0, pressedGumpId: 0,
        width: 72, height: 24, label: canCraft ? 'Select' : 'Too low', flat: true,
        action: ButtonAction.Activate,
      });
      button.enabled = canCraft;
      button.acceptMouseInput = canCraft;
      button.node.alpha = canCraft ? 1 : 0.48;
      button.setPosition(274, y + 2);
      button.onClick = () => canCraft && this._select(recipe);
      this._scroll.add(button);
      this._rows.push(button);
    }
    if (!recipes.length) {
      const empty = new Label('No recipes match the current filter.', {
        fontSize: 12, hue: 0x9f9480,
      });
      empty.setPosition(12, 12);
      this._scroll.add(empty);
      this._rows.push(empty);
    }
    this._scroll.endBulkUpdate();
    this._scroll.setContentHeight(Math.max(42, recipes.length * ROW_H));
  }

  _craft(recipe) {
    if (this._busy) return;
    this._lastRecipe = recipe;
    this._lastButton?.setLabel?.(`Again: ${recipe.name}`);
    this._history = [recipe.id, ...this._history.filter((id) => id !== recipe.id)].slice(0, 20);
    writeJson(STORAGE_HISTORY, this._history);
    const quantity = Math.max(1, Math.min(50, this._quantity | 0));
    this._sendCmd(quantity > 1 ? `craft batch ${recipe.id} ${quantity}` : `craft ${recipe.id}`);
  }

  _onProgress(event = {}) {
    if (event.recipeId && this._selectedRecipe && event.recipeId !== this._selectedRecipe.id) return;
    const done = Math.max(0, event.done | 0);
    const total = Math.max(1, event.total | 0);
    this._busy = event.status === 'working';
    const ratio = Math.max(0, Math.min(1, done / total));
    this._progressFill.clear().roundRect(390, 408, Math.round(172 * ratio), 12, 3)
      .fill({ color: event.status === 'failed' ? 0xc05040 : 0x65ad67, alpha: 1 });
    this._progressLabel.setText(event.message || `${done}/${total} ${event.status || ''}`);
    this._cancelButton.node.visible = this._busy;
    this._renderDetails();
  }

  _sendCmd(cmd) {
    if (this._net?.sendCommand) {
      try { this._net.sendCommand(cmd); } catch { /* socket transient */ }
    }
  }

  dispose() {
    for (const unsub of this._unsubs) unsub?.();
    this._clearRows();
    super.dispose();
  }
}

export function parseCraftPayload(raw) {
  if (!raw || typeof raw !== 'string') return { skill: 'all', skillVal: 0, recipes: [] };
  const idx1 = raw.indexOf('|');
  const idx2 = raw.indexOf('|', idx1 + 1);
  if (idx1 <= 0 || idx2 <= idx1) return { skill: 'all', skillVal: 0, recipes: [] };
  const skill = raw.slice(0, idx1).trim() || 'all';
  const skillVal = safeNumber(raw.slice(idx1 + 1, idx2));
  const rest = raw.slice(idx2 + 1);
  const recipes = rest.split(';').filter(Boolean).slice(0, 1000).map((row) => {
    const [id, name, skillId, min, max, category, outputItemId, outputCount, toolKind, inputsRaw, success, exceptional, materialsRaw] = row.split('|');
    const inputs = String(inputsRaw || '').split(',').filter(Boolean).slice(0, 16).map((entry) => {
      const [itemId, count, encodedName] = entry.split(':');
      let inputName = '';
      try { inputName = decodeURIComponent(encodedName || ''); } catch { /* malformed optional metadata */ }
      return { itemId: safeNumber(itemId) | 0, count: Math.max(1, safeNumber(count, 1) | 0), name: inputName };
    });
    const decode = (value, fallback = '') => {
      try { return decodeURIComponent(value || fallback); } catch { return fallback; }
    };
    const materials = String(materialsRaw || '').split(',').filter(Boolean).slice(0, 16).map((entry) => {
      const [encodedName, hue, skillReq] = entry.split(':');
      return {
        name: decode(encodedName).slice(0, 40),
        hue: safeNumber(hue) | 0,
        skillReq: safeNumber(skillReq),
      };
    }).filter((material) => material.name);
    return {
      id: safeNumber(id) | 0,
      name: String(name || '').slice(0, 160),
      skillId: safeNumber(skillId) | 0,
      min: safeNumber(min),
      max: safeNumber(max, 100),
      category: decode(category, 'Other').slice(0, 80),
      outputItemId: safeNumber(outputItemId) | 0,
      outputCount: Math.max(1, safeNumber(outputCount, 1) | 0),
      toolKind: decode(toolKind).slice(0, 40),
      inputs,
      success: Math.max(0, Math.min(1, safeNumber(success))),
      exceptional: Math.max(0, Math.min(1, safeNumber(exceptional))),
      materials,
    };
  }).filter((recipe) => recipe.id > 0 && recipe.name);
  return { skill, skillVal, recipes };
}
