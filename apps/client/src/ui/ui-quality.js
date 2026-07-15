function channel(value) {
  const n = value / 255;
  return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
}

export function contrastRatio(foreground, background) {
  const rgb = (value) => [value >>> 16 & 255, value >>> 8 & 255, value & 255].map(channel);
  const luminance = (value) => {
    const [r, g, b] = rgb(value >>> 0);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = luminance(foreground); const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function auditGumpQuality(gump, { background = 0x10151d, minimumContrast = 4.5 } = {}) {
  const issues = [];
  const visit = (control, ox = 0, oy = 0) => {
    const x = ox + (Number(control?.x) || 0); const y = oy + (Number(control?.y) || 0);
    if (control?._fontSize) {
      const ratio = contrastRatio(control._hue ?? 0xfff0c0, background);
      if (ratio < minimumContrast) issues.push({ type: 'contrast', ratio: Number(ratio.toFixed(2)), text: String(control._cachedText ?? '').slice(0, 80) });
    }
    if (control !== gump && gump?.width > 0 && gump?.height > 0
        && (x + (control?.width || 0) > gump.width + 2 || y + (control?.height || 0) > gump.height + 2)) {
      issues.push({ type: 'overflow', x, y, width: control?.width || 0, height: control?.height || 0 });
    }
    for (const child of control?.children ?? []) visit(child, x, y);
  };
  visit(gump);
  return { ok: issues.length === 0, issues };
}
