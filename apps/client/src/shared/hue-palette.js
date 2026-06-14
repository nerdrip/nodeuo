// hues.png → representative-RGB lookup. Used to display hue swatches
// without firing up Pixi's hue filter — picker gump, admin item editor,
// journal-tag colour preview.
//
// The extractor writes a single 32-px-wide bitmap whose row N is the
// 32-step gradient for hue id N+1 (hue id 0 = "unhued", no row). We
// sample one representative column (x=15, mid-tone) per row and return
// a `Uint32Array` of 24-bit RGB values keyed by hue id (1-based; index
// 0 is unused).
//
// The CSS-fallback path (`fallbackHueColor`) gives every hue a useful
// swatch even when the bitmap hasn't been extracted yet — keeps the
// admin editor's hue swatch picker usable on a stripped-down dev shard.
//
// SHARED MODULE: browser-only (uses Image + canvas). No Pixi imports.

/** Spread `hueId` across the HSL hue circle. `span` covers the rough
 *  "useful" range of UO hues (skin tones + dye-tub colours sit in
 *  ids 1..1158). Saturation 0.65 / Lightness 0.55 gives readable
 *  swatches at small sizes. */
export function fallbackHueColor(hueId, span = 1158) {
  const h = (hueId % span) / span;
  const s = 0.65, l = 0.55;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h * 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if      (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) {         g = c; b = x; }
  else if (hp < 4) {         g = x; b = c; }
  else if (hp < 5) { r = x;         b = c; }
  else             { r = c;         b = x; }
  const m = l - c / 2;
  return ((Math.round((r + m) * 255)) << 16)
       | ((Math.round((g + m) * 255)) <<  8)
       |  (Math.round((b + m) * 255));
}

/** Load `hues.png` from the supplied URL and decode it to a representative
 *  Uint32Array (one 24-bit RGB per hue id, indexed by 1-based hueId).
 *
 *  Resolves to `null` on fetch / decode failure so the caller can fall
 *  back to `fallbackHueColor`. Honours `crossOrigin = 'anonymous'` so
 *  the admin editor can use the same `/assets/hues.png` the client
 *  fetches without tripping a CORS-tainted-canvas read.
 *
 *  @param {string} [url] defaults to '/assets/hues.png'
 *  @param {number} [sampleX] middle column index (0..31); 15 = canonical
 *  @returns {Promise<Uint32Array | null>} */
export async function loadHuePalette(url = '/assets/hues.png', sampleX = 15) {
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = url;
    });
    const cv = document.createElement('canvas');
    cv.width = img.width;
    cv.height = img.height;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    const N = img.height;
    const out = new Uint32Array(N + 1);   // 1-based; index 0 unused
    const x = Math.min(Math.max(0, sampleX | 0), img.width - 1);
    for (let y = 0; y < N; y++) {
      const off = (y * img.width + x) * 4;
      out[y + 1] = (data[off] << 16) | (data[off + 1] << 8) | data[off + 2];
    }
    return out;
  } catch (e) {
    if (typeof console !== 'undefined') {
      console.warn('[hue-palette] load failed:', e?.message);
    }
    return null;
  }
}

/** Resolve a hue id to a 24-bit RGB swatch colour. Uses the loaded
 *  palette if available; falls back to the HSL approximation otherwise.
 *  Mirrors the lookup the client's ColorPickerGump used inline. */
export function hueColor(palette, hueId) {
  if (palette && hueId >= 0 && hueId < palette.length) {
    const v = palette[hueId];
    if (v) return v;
  }
  return fallbackHueColor(hueId);
}
