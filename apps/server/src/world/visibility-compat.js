// Compatibility-only iterators for tests and embedders that populate the
// authoritative Maps directly instead of using World.create*. Production
// marks its sector indexes authoritative at readiness and never enters these
// full-scan paths. Keeping them in a separate module lets the architecture
// gate protect the actual tick hot path from accidental scans.
export function* legacyNearbyClients(world, center, self, range, inRange) {
  for (const mobile of world.mobiles.values()) {
    if (mobile === self || !mobile.client) continue;
    if (inRange(center, mobile, range)) yield mobile;
  }
}

export function* legacyNearbyMobiles(world, center, self, range, inRange) {
  for (const mobile of world.mobiles.values()) {
    if (mobile === self || mobile.mounted) continue;
    if (inRange(center, mobile, range)) yield mobile;
  }
}

export function* legacyNearbyItems(world, center, range, inRange) {
  for (const item of world.items.values()) {
    if (item.parent || item.visible === false) continue;
    if (inRange(center, item, range)) yield item;
  }
}
