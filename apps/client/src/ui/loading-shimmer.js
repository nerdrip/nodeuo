// LoadingShimmer — shared placeholder painter used by every UI control /
// renderer that has to show SOMETHING while a real texture is in flight.
//
// Marcin's brief: "podczas ładowania gumpów byl shiver i nadal chcę ale
// szarego/srebrnego koloru. Wogóle gdziekolwiek coś ładujesz to dawaj
// shivery szare/srebne." — the existing per-call hash-coloured rect /
// rounded fill was distracting (every loading patch a different bright
// hue) AND only some controls had it. We unify on a calm gray-silver
// gradient that pulses softly so the user knows "this is loading,
// not broken" no matter which surface is incomplete.
//
// Usage:
//   const sh = createShimmer(width, height);
//   container.addChild(sh.gfx);
//   ...
//   sh.dispose();
//
// `gfx` is a Pixi Graphics primitive; the helper installs a Ticker
// listener that drives `alpha` between SHIMMER_LOW and SHIMMER_HIGH
// in a sin curve so the visual reads as an active "loading" state
// rather than a static filler. dispose() removes the listener AND
// destroys the primitive.

import { Graphics, Ticker } from 'pixi.js';

// Single calm silver-gray. Saturation deliberately low so the
// placeholder doesn't compete with the real assets that will replace it.
const SHIMMER_FILL    = 0xb8babf;
const SHIMMER_BORDER  = 0x6e7178;
const SHIMMER_HIGHLIGHT = 0xe8eaef;

const SHIMMER_LOW   = 0.35;
const SHIMMER_HIGH  = 0.65;
const PERIOD_MS     = 900;

const _activeShimmers = new Set();
let _tickerInstalled = false;

function _tickShimmers() {
  if (_activeShimmers.size === 0) {
    if (_tickerInstalled) {
      Ticker.shared.remove(_tickShimmers);
      _tickerInstalled = false;
    }
    return;
  }
  const now = performance.now();
  for (const s of _activeShimmers) {
    const phase = ((now - s.t0) % PERIOD_MS) / PERIOD_MS;
    s.gfx.alpha = SHIMMER_LOW + (SHIMMER_HIGH - SHIMMER_LOW)
      * (0.5 + 0.5 * Math.sin(phase * 2 * Math.PI));
  }
}

function _addShimmer(entry) {
  _activeShimmers.add(entry);
  if (!_tickerInstalled) {
    Ticker.shared.add(_tickShimmers);
    _tickerInstalled = true;
  }
}

function _removeShimmer(entry) {
  _activeShimmers.delete(entry);
  if (_activeShimmers.size === 0 && _tickerInstalled) {
    Ticker.shared.remove(_tickShimmers);
    _tickerInstalled = false;
  }
}

/**
 * @param {number} width   placeholder width in pixels
 * @param {number} height  placeholder height in pixels
 * @param {{ radius?: number, drawHighlight?: boolean }} [opts]
 * @returns {{ gfx: Graphics, dispose: () => void, resize: (w:number, h:number) => void }}
 */
export function createShimmer(width, height, opts = {}) {
  const radius = opts.radius ?? 2;
  const wantHighlight = opts.drawHighlight !== false;
  const gfx = new Graphics();
  let w = width | 0;
  let h = height | 0;
  let disposed = false;

  const repaint = () => {
    gfx.clear();
    gfx.roundRect(0, 0, w, h, radius)
       .fill({ color: SHIMMER_FILL, alpha: 1 })
       .stroke({ width: 1, color: SHIMMER_BORDER, alpha: 0.85 });
    if (wantHighlight && h > 4) {
      // Faint top diagonal sheen — sells the "loading" feel without
      // animating geometry (cheaper than a moving gradient).
      gfx.rect(1, 1, Math.max(1, w - 2), 1)
         .fill({ color: SHIMMER_HIGHLIGHT, alpha: 0.5 });
    }
  };
  repaint();

  const entry = { gfx, t0: performance.now() };
  const reduceMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    || globalThis.localStorage?.getItem?.('uo.reduced-motion') === '1';
  if (reduceMotion) gfx.alpha = (SHIMMER_LOW + SHIMMER_HIGH) / 2;
  else _addShimmer(entry);

  return {
    gfx,
    resize(nw, nh) {
      if (disposed) return;
      w = nw | 0; h = nh | 0;
      repaint();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (!reduceMotion) _removeShimmer(entry);
      try { gfx.destroy(); } catch { /* ignore */ }
    },
  };
}
