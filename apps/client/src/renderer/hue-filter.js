// HueFilter — recreates ClassicUO's hue palette lookup as a Pixi v8 GLSL
// fragment shader. Mirrors src/ClassicUO.Renderer/Shaders/IsometricWorld.fx
// (HUED / PARTIAL_HUED / HUE_TEXT branches) with the hue table baked
// into a 32-wide × N-tall RGBA texture (one row per hue id).
//
// Modes:
//   0 = none           sprite sampled untouched
//   1 = hued           every non-transparent pixel replaced by the
//                      palette entry whose column = pixel grayscale (0..31)
//   2 = partial-hued   only grey pixels (R≈G≈B) get replaced; coloured
//                      pixels pass through (used for items where only
//                      cloth recolours)
//   3 = hue-text       grayscale text — every pixel replaced regardless
//                      of the original RGB
//
// PERFORMANCE NOTE (OPT WIN#1, 2026-05-07):
//   Pixi.Filter instances batch by reference: every sprite sharing the
//   same Filter object draws in the same batch. But uniforms are shared
//   across the batch, so we can't truly share ONE filter across sprites
//   with different hues — Pixi flushes with whatever uniforms are current.
//
//   Practical compromise: cache one Filter per (hue, mode) combo. In a
//   typical scene 50–200 unique combos are active concurrently. Cap the
//   cache at 256 entries with LRU eviction so a hue-spamming bug can't
//   leak GPU memory.
//
// Texture references: the LUT (`uHues`) and hueCount are captured at
// `setSharedHueLut()` time so callers don't have to re-pass them. The
// asset manager calls setSharedHueLut once on init.

import { Filter, GlProgram, GpuProgram, UniformGroup } from 'pixi.js';

const VERT = /* glsl */`
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition(vec2 a) {
    vec2 position = a * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord(vec2 a) {
    return a * (uOutputFrame.zw * uInputSize.zw);
}

void main(void) {
    gl_Position = filterVertexPosition(aPosition);
    vTextureCoord = filterTextureCoord(aPosition);
}
`;

// Pixi v8 uses LOOSE GLSL uniforms (e.g. `uniform float uAlpha;`) — not
// uniform blocks. The binding magic happens on the JS side via
// `new UniformGroup({ uAlpha: { value, type } })` passed through the
// `resources` map. Pixi reflects the shader source, finds each named
// uniform, and maps it to the matching key in the UniformGroup.
//
// Earlier attempts that (a) used a plain `{ uAlpha: { value, type } }`
// object in `resources` and (b) wrapped the uniforms in a UBO block in
// GLSL both failed silently: Pixi never bound the values, so the
// shader read defaults (0) and `if (uMode < 0.5) finalColor = src;`
// short-circuited every fragment to raw atlas RGB. Result: every dyed
// item rendered in its base palette (cream-gray for clothing).
//
// Canonical pattern verified against Pixi v8's own ColorMatrixFilter:
//   - GLSL: `uniform float uColorMatrix[20]; uniform float uAlpha;`
//   - JS:   `new UniformGroup({ uColorMatrix: { value, type, size },
//                               uAlpha: { value, type } })`
//   - mutations: `group.uniforms.uColorMatrix = X; group.update();`
const FRAG = /* glsl */`
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uHues;
uniform float uHueIndex;
uniform float uHueCount;
uniform float uMode;

float grayscale(vec3 c) {
    return floor(((c.r + c.g + c.b) / 3.0) * 31.0 + 0.5);
}

void main(void) {
    vec4 src = texture(uTexture, vTextureCoord);
    if (src.a < 0.05) { finalColor = src; return; }
    if (uMode < 0.5)  { finalColor = src; return; }

    float v = grayscale(src.rgb);
    float u = (v + 0.5) / 32.0;
    float w = (uHueIndex + 0.5) / max(uHueCount, 1.0);
    vec4 lut = texture(uHues, vec2(u, w));

    if (uMode > 2.5) {
        finalColor = vec4(lut.rgb, src.a);
    } else if (uMode > 1.5) {
        float maxC = max(src.r, max(src.g, src.b));
        float minC = min(src.r, min(src.g, src.b));
        float greyish = step(maxC - minC, 0.04);
        finalColor = mix(src, vec4(lut.rgb, src.a), greyish);
    } else {
        finalColor = vec4(lut.rgb, src.a);
    }
}
`;

// WGSL fragment for the WebGPU backend. Pixi v8 ships separate GLSL +
// WGSL programs in the Filter constructor (see Pixi's own
// ColorMatrixFilter / DisplacementFilter); under WebGPU the GLSL is
// ignored and the WGSL takes over. Without this, an operator with a
// WebGPU-capable browser (recent Chrome / Edge / Safari) gets a silent
// no-op filter — visible bug: every hued item renders in raw atlas RGB.
// Once we ship both shaders the renderer can prefer WebGPU again for
// the draw-call CPU win (~30% saved on 1k-static scenes).
//
// Pattern verified against Pixi v8's `colorMatrixFilter.wgsl.js`:
//   • `GlobalFilterUniforms` at group 0 binding 0
//   • input texture + sampler at group 0 binding 1 / 2
//   • our filter uniforms at group 1 binding 0
//   • our LUT texture + sampler at group 1 binding 1 / 2 (after the UBO)
// Names of the user resources in our JS-side `resources` map MUST match
// the WGSL binding names exactly — `hueUniforms`, `uHues`, `uHuesSampler`.
const WGSL = /* wgsl */`
struct GlobalFilterUniforms {
  uInputSize: vec4<f32>,
  uInputPixel: vec4<f32>,
  uInputClamp: vec4<f32>,
  uOutputFrame: vec4<f32>,
  uGlobalFrame: vec4<f32>,
  uOutputTexture: vec4<f32>,
};

struct HueUniforms {
  uHueIndex: f32,
  uHueCount: f32,
  uMode: f32,
};

@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;
@group(1) @binding(0) var<uniform> hueUniforms: HueUniforms;
@group(1) @binding(1) var uHues: texture_2d<f32>;
@group(1) @binding(2) var uHuesSampler: sampler;

struct VSOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

fn filterVertexPosition(aPosition: vec2<f32>) -> vec4<f32> {
  var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
  position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;
  return vec4<f32>(position, 0.0, 1.0);
}

fn filterTextureCoord(aPosition: vec2<f32>) -> vec2<f32> {
  return aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
}

@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>) -> VSOutput {
  return VSOutput(filterVertexPosition(aPosition), filterTextureCoord(aPosition));
}

fn grayscale(c: vec3<f32>) -> f32 {
  return floor(((c.r + c.g + c.b) / 3.0) * 31.0 + 0.5);
}

@fragment
fn mainFragment(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  let src = textureSample(uTexture, uSampler, uv);
  if (src.a < 0.05) { return src; }
  if (hueUniforms.uMode < 0.5) { return src; }

  let v = grayscale(src.rgb);
  let u = (v + 0.5) / 32.0;
  let w = (hueUniforms.uHueIndex + 0.5) / max(hueUniforms.uHueCount, 1.0);
  // textureSampleLevel (not textureSample) — the LUT lookup doesn't
  // need mipmap derivatives, and only the *Level* variant is legal
  // to call from non-uniform control flow. The early-returns above
  // make this path non-uniform, so we MUST use Level here or WGSL
  // refuses to compile (validation error 'textureSample must only
  // be called from uniform control flow').
  let lut = textureSampleLevel(uHues, uHuesSampler, vec2<f32>(u, w), 0.0);

  if (hueUniforms.uMode > 2.5) {
    return vec4<f32>(lut.rgb, src.a);
  } else if (hueUniforms.uMode > 1.5) {
    let maxC = max(src.r, max(src.g, src.b));
    let minC = min(src.r, min(src.g, src.b));
    let greyish = step(maxC - minC, 0.04);
    return mix(src, vec4<f32>(lut.rgb, src.a), greyish);
  } else {
    return vec4<f32>(lut.rgb, src.a);
  }
}
`;

let _lutTexture = null;
let _hueCount = 0;
let _glProgram = null;
let _gpuProgram = null;

const FILTER_CACHE_CAP = 256;
const _filterCache = new Map();

function _getGlProgram() {
  if (_glProgram) return _glProgram;
  _glProgram = GlProgram.from({ vertex: VERT, fragment: FRAG, name: 'uo-hue-filter' });
  return _glProgram;
}

function _getGpuProgram() {
  if (_gpuProgram) return _gpuProgram;
  _gpuProgram = GpuProgram.from({
    vertex:   { source: WGSL, entryPoint: 'mainVertex'   },
    fragment: { source: WGSL, entryPoint: 'mainFragment' },
    name: 'uo-hue-filter',
  });
  return _gpuProgram;
}

function _buildFilter(hueIndex, mode) {
  if (!_lutTexture) {
    throw new Error('HueFilter: setSharedHueLut() must be called before applyHueTo');
  }
  // UniformGroup wrap is mandatory — passing a plain `{ uHueIndex: {...} }`
  // object here makes Pixi v8 silently skip the binding so the shader
  // reads default-zero uniforms and the filter is a visual no-op.
  // Keyed `hueUniforms` to match the `var<uniform> hueUniforms` binding
  // name in the WGSL program (group 1, binding 0). The GLSL reflection
  // path doesn't care about the resource key — it matches by uniform
  // name (`uHueIndex` etc.) — so the same key works for both backends.
  const hueUniforms = new UniformGroup({
    uHueIndex: { value: hueIndex, type: 'f32' },
    uHueCount: { value: _hueCount, type: 'f32' },
    uMode:     { value: mode,     type: 'f32' },
  });
  // Pixi v8 binds a sampler in TWO resource entries: the TextureSource
  // under the shader's `sampler2D` / `texture_2d` name, AND its sampler
  // `.style` under `<Name>Sampler`. DisplacementFilter does the same:
  // `uMapTexture` + `uMapSampler`. Missing the companion left the
  // sampler at default 0-bind so `texture(uHues, …)` read from the
  // unrelated input texture — visible bug: applyHueTo logged the call
  // but the sprite stayed gray.
  const lutSource = _lutTexture.source;
  return new Filter({
    glProgram:  _getGlProgram(),
    gpuProgram: _getGpuProgram(),
    resources: {
      uHues:        lutSource,
      uHuesSampler: lutSource.style,
      hueUniforms,
    },
  });
}

function _cacheKey(hueIndex, mode) { return `${hueIndex >>> 0}:${mode | 0}`; }

function _getCachedFilter(hueIndex, mode) {
  const key = _cacheKey(hueIndex, mode);
  let f = _filterCache.get(key);
  if (f) {
    _filterCache.delete(key);
    _filterCache.set(key, f);
    return f;
  }
  f = _buildFilter(hueIndex, mode);
  if (_filterCache.size >= FILTER_CACHE_CAP) {
    const oldest = _filterCache.keys().next().value;
    _filterCache.delete(oldest);
  }
  _filterCache.set(key, f);
  return f;
}

/**
 * Wire the hues palette LUT + count once at boot. AssetManager calls this
 * from its init() after the hues atlas page is loaded.
 */
export function setSharedHueLut(lutTexture, hueCount) {
  _lutTexture = lutTexture;
  _hueCount = hueCount | 0;
  _filterCache.clear();
}

/**
 * Build a NEW Filter (legacy API). Prefer `applyHueTo` for almost all
 * uses — it shares filters across sprites with matching (hue,mode).
 *
 * @param {import('pixi.js').Texture} lutTexture
 * @param {number} hueCount
 */
export function makeHueFilter(lutTexture, hueCount) {
  // Same UniformGroup + sampler pairing as _buildFilter — see the
  // comment there for why both the TextureSource and its `.style` need
  // to land in resources, and why a plain object instead of
  // UniformGroup makes Pixi silently drop the bindings. We ship both
  // GLSL + WGSL programs so the filter works regardless of which
  // backend Pixi picks (WebGL2 / WebGPU).
  const hueUniforms = new UniformGroup({
    uHueIndex: { value: 0,        type: 'f32' },
    uHueCount: { value: hueCount, type: 'f32' },
    uMode:     { value: 0,        type: 'f32' },
  });
  const lutSource = lutTexture.source;
  return new Filter({
    glProgram:  _getGlProgram(),
    gpuProgram: _getGpuProgram(),
    resources: {
      uHues:        lutSource,
      uHuesSampler: lutSource.style,
      hueUniforms,
    },
  });
}

/**
 * Convert the 16-bit hue value carried by UO packets into the zero-based
 * row used by the extracted hues LUT. Bits 14/15 are render flags
 * (partial-hue / spectral), not part of the palette number; hue 1 selects
 * LUT row 0. Passing raw skin hues such as 0x83EA to the shader sampled far
 * below the texture and clamped every human to the final, near-black row.
 */
export function normalizeUoHueIndex(hue) {
  const paletteHue = (Number(hue) | 0) & 0x3fff;
  return paletteHue > 0 ? paletteHue - 1 : -1;
}

/**
 * Stamp a cached hue filter onto a Pixi DisplayObject. Sprites sharing
 * the same (hue, mode) pair use the same Filter instance and batch
 * together — saving GPU state-changes and V-RAM.
 *
 * Backward compatible: callers can still pass explicit `lutTexture` /
 * `hueCount` for an independent (non-shared) filter.
 *
 * @param {import('pixi.js').Container} target
 * @param {number} hueIndex
 * @param {number} mode      0 none / 1 hued / 2 partial / 3 text
 * @param {import('pixi.js').Texture} [lutTexture]
 * @param {number} [hueCount]
 */
export function applyHueTo(target, hueIndex, mode, lutTexture, hueCount) {
  if (!target) return;
  const normalizedHue = normalizeUoHueIndex(hueIndex);
  if (normalizedHue < 0 || mode === 0) {
    if (target._uoHueFilterKey || target.filters) target.filters = null;
    target._uoHueFilterKey = '';
    return;
  }

  // If caller passed an explicit (different) LUT, build a one-off filter
  // — backward compatible with the v1 makeHueFilter+set-uniforms pattern.
  if (lutTexture && (lutTexture !== _lutTexture || hueCount !== _hueCount)) {
    const f = makeHueFilter(lutTexture, hueCount);
    // Pixi v8 UniformGroup mutation pattern: write through `.uniforms`
    // then call `.update()` so the GPU side picks up the new values
    // on the next frame. Skipping `.update()` leaves the filter with
    // its construction-time defaults (hue=0, mode=0) and the filter
    // is a no-op — matches ColorMatrixFilter._loadMatrix() in Pixi.
    const ug = f.resources.hueUniforms;
    ug.uniforms.uHueIndex = normalizedHue;
    ug.uniforms.uMode     = mode;
    ug.update();
    target._uoHueFilterKey = '';
    target.filters = [f];
    return;
  }

  if (!_lutTexture) {
    // Race: hue requested before AssetManager finished init. Skip silently.
    if (target._uoHueFilterKey || target.filters) target.filters = null;
    target._uoHueFilterKey = '';
    return;
  }
  // Pixi v8 `set filters(value)` only fires addEffect/removeEffect when
  // the array's CARDINALITY flips between 0 and N — it doesn't detect
  // a different Filter instance inside the same-length array. That
  // shape works for new-then-attach, but when we re-hue a sprite that
  // ALREADY had a filter (e.g. backpack item dyed via [itemgump, mob
  // wearing a tinted-stack equipment swap, multi-tile re-broadcast on
  // hue change) the effect's internal cache can hold onto the previous
  // filter binding even though `effect.filters` was updated. Force the
  // cardinality flip by clearing first, then re-applying. The cost is
  // one extra `removeEffect`/`addEffect` pair per hue change, which is
  // negligible — hue changes are events, not per-frame.
  const nextKey = _cacheKey(normalizedHue, mode);
  const next = _getCachedFilter(normalizedHue, mode);
  const cur = target.filters;
  if (target._uoHueFilterKey === nextKey && Array.isArray(cur) && cur[0] === next) return;
  if (Array.isArray(cur) && cur.length > 0 && cur[0] !== next) {
    target.filters = null;
  }
  target.filters = [next];
  target._uoHueFilterKey = nextKey;
}

/** Drop all cached filters. Useful after a hot-reload of asset packs. */
export function clearHueFilterCache() { _filterCache.clear(); }

/** Inspect cache size — for tests / debug overlay. */
export function getHueFilterCacheSize() { return _filterCache.size; }
