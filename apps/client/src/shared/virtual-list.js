// Shared fixed-row virtual-list math. UI controls can reuse this without
// pulling DOM/Pixi specifics into the hot path.

export function calculateVirtualWindow({
  scrollY = 0,
  viewportSize = 0,
  itemSize = 1,
  itemCount = 0,
  overscan = 0,
} = {}) {
  const count = Math.max(0, itemCount | 0);
  const size = Math.max(1, itemSize | 0);
  const view = Math.max(0, viewportSize | 0);
  const extra = Math.max(0, overscan | 0);
  if (count === 0) {
    return { start: 0, end: 0, before: 0, after: 0, total: 0 };
  }
  const total = count * size;
  const maxScroll = Math.max(0, total - view);
  const y = Math.max(0, Math.min(maxScroll, Number(scrollY) || 0));
  const start = Math.max(0, Math.floor(y / size) - extra);
  const visible = view > 0 ? Math.ceil(view / size) : 1;
  const end = Math.min(count, Math.ceil(y / size) + visible + extra);
  return {
    start,
    end,
    before: start * size,
    after: Math.max(0, total - end * size),
    total,
  };
}
