// TextInput — single-line / multi-line text entry. Mirrors ClassicUO's
// Game/UI/Controls/StbTextBox.cs at a much-reduced level: caret, blink,
// basic editing, IME-via-DOM-input is deferred (we just listen on
// keydown for now).

import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import { Control } from '../control.js';
import { UI_FONT_FAMILY, UI_TEXT_RESOLUTION } from '../text-quality.js';

const CARET_BLINK_MS = 500;

const _inputStyleCache = new Map();
function inputTextStyle(fill, fontSize) {
  const key = `${fill >>> 0}|${fontSize | 0}`;
  let style = _inputStyleCache.get(key);
  if (style) return style;
  style = new TextStyle({ fill, fontSize, fontFamily: UI_FONT_FAMILY, fontWeight: 500 });
  _inputStyleCache.set(key, style);
  return style;
}

export class TextInput extends Control {
  constructor({
    width = 120, height = 22, multiLine = false, maxLength = 256,
    text = undefined, value = undefined, placeholder = '', hue = 0xfff0c0, fontSize = 12,
    entryId = 0,
  } = {}) {
    super();
    this.acceptKeyboardInput = true;
    this.acceptMouseInput = true;
    this.width = width;
    this.height = height;
    this.multiLine = !!multiLine;
    this.maxLength = maxLength | 0;
    this.entryId = entryId | 0; // server-gump text-entry id
    this.placeholder = placeholder;
    this._fontSize = fontSize;

    this._wrap = new Container();
    this._bg = new Graphics();
    this._caret = new Graphics();
    this._clip = new Graphics();
    this._textLayer = new Container();
    const initialText = String(text ?? value ?? '');

    this._text = new Text({
      text: initialText,
      style: inputTextStyle(hue, fontSize),
      resolution: UI_TEXT_RESOLUTION,
      roundPixels: true,
    });
    this._placeholderTxt = new Text({
      text: placeholder || '',
      style: inputTextStyle(0x6f6242, fontSize),
      resolution: UI_TEXT_RESOLUTION,
      roundPixels: true,
    });
    this._textLayer.addChild(this._placeholderTxt, this._text, this._caret);
    this._textLayer.mask = this._clip;
    this._wrap.addChild(this._bg, this._textLayer, this._clip);
    this.node.addChild(this._wrap);

    this._value = initialText.slice(0, this.maxLength);
    this._caretPos = this._value.length;
    this._caretVisible = true;
    this._caretAt = performance.now();
    this._paintedValue = null;
    this._paintedPlaceholder = null;

    this._draw();
  }

  get value() { return this._value; }

  set onChange(fn) { this._onChange = fn; }
  get onChange() { return this._onChange; }

  setValue(v, { silent = false } = {}) {
    const next = String(v ?? '').slice(0, this.maxLength);
    if (next === this._value) return;
    this._value = next;
    this._caretPos = this._value.length;
    this._draw();
    if (!silent) this._emitChange();
  }

  onClick() { /* focus is handled in UIManager via acceptKeyboardInput */ }

  onKeyDown(e) {
    let consume = true;
    const before = this._value;
    if (e.key === 'Backspace') {
      if (this._caretPos > 0) {
        this._value = this._value.slice(0, this._caretPos - 1) + this._value.slice(this._caretPos);
        this._caretPos--;
      }
    } else if (e.key === 'Delete') {
      if (this._caretPos < this._value.length) {
        this._value = this._value.slice(0, this._caretPos) + this._value.slice(this._caretPos + 1);
      }
    } else if (e.key === 'ArrowLeft') {
      this._caretPos = Math.max(0, this._caretPos - 1);
    } else if (e.key === 'ArrowRight') {
      this._caretPos = Math.min(this._value.length, this._caretPos + 1);
    } else if (e.key === 'Home') {
      this._caretPos = 0;
    } else if (e.key === 'End') {
      this._caretPos = this._value.length;
    } else if (e.key === 'Enter') {
      if (this.multiLine && this._value.length < this.maxLength) {
        this._value = this._value.slice(0, this._caretPos) + '\n' + this._value.slice(this._caretPos);
        this._caretPos++;
      } else {
        this.onSubmit?.(this._value);
      }
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      if (this._value.length < this.maxLength) {
        this._value = this._value.slice(0, this._caretPos) + e.key + this._value.slice(this._caretPos);
        this._caretPos++;
      }
    } else {
      consume = false;
    }
    if (consume) {
      e.preventDefault();
      this._draw();
      if (this._value !== before) this._emitChange();
    }
  }

  _emitChange() {
    try { this._onChange?.(this._value); } catch (e) { console.error('[text-input] onChange', e); }
  }

  /** Called by the gump just before sending a response so we can read .value */
  serializeResponse() {
    return { id: this.entryId, text: this._value };
  }

  _draw() {
    this._bg.clear();
    this._bg.roundRect(0, 0, this.width, this.height, 3)
      .fill({ color: 0x0d1117, alpha: 0.92 })
      .stroke({ width: 1, color: 0x8a6a2c, alpha: 0.85 });
    this._bg.roundRect(2, 2, Math.max(0, this.width - 4), Math.max(0, this.height - 4), 2)
      .stroke({ width: 1, color: 0xffffff, alpha: 0.07 });
    this._clip.clear();
    this._clip.rect(3, 2, Math.max(0, this.width - 6), Math.max(0, this.height - 4))
      .fill({ color: 0xffffff });

    if (this._paintedValue !== this._value) {
      this._paintedValue = this._value;
      this._text.text = this._value;
    }
    this._text.position.set(4, (this.height - this._text.height) / 2);

    const placeholder = this.placeholder ?? '';
    if (this._paintedPlaceholder !== placeholder) {
      this._paintedPlaceholder = placeholder;
      this._placeholderTxt.text = placeholder;
    }
    this._placeholderTxt.visible = !this._value;
    this._placeholderTxt.position.set(4, (this.height - this._placeholderTxt.height) / 2);

    this._drawCaret();
  }

  _drawCaret() {
    // Caret: position by remeasuring a substring up to caretPos.
    const before = this._value.slice(0, this._caretPos);
    const meas = approxTextWidth(before, this._fontSize);
    this._caret.clear();
    if (this._caretVisible) {
      this._caret.rect(4 + meas, this._text.position.y, 1, this._text.height || this.height - 6)
                 .fill({ color: 0xfff0c0 });
    }
  }

  /** Called by the host scene/UIManager once per frame to blink the caret. */
  tick() {
    const now = performance.now();
    if (now - this._caretAt >= CARET_BLINK_MS) {
      this._caretVisible = !this._caretVisible;
      this._caretAt = now;
      this._drawCaret();
    }
  }
}

/** Rough monospace text width estimate. Pixi Text gives accurate widths
 * via .width on the live node, but querying that for a fresh substring
 * means re-laying-out a hidden Text — just approximate for the caret. */
function approxTextWidth(s, fontSize) {
  // Consolas roughly 0.55em per character.
  return s.length * fontSize * 0.55;
}
