// World art remains pixel-perfect at renderer resolution=1. UI text gets a
// separate high-resolution backing texture because the interface is commonly
// scaled to 125–150%. Cap at 4x to keep glyph memory bounded on HiDPI screens.
const dpr = Number(globalThis.devicePixelRatio) || 1;
export const UI_TEXT_RESOLUTION = Math.max(3, Math.min(4, Math.ceil(dpr * 2.5)));

export const UI_FONT_FAMILY = '"Segoe UI Variable Text", "Segoe UI", Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
export const UI_MONO_FONT_FAMILY = '"Cascadia Mono", "SFMono-Regular", Consolas, monospace';
