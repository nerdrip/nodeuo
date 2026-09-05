/** Resolve characters owned by an administrator account, preferring the
 * currently connected character. The account slot list is authoritative;
 * accountName on live mobiles is the compatibility fallback for older saves. */
export function resolveAdminCharacters({ world, accounts }, sessionAccount, preferredSlot) {
  if (!sessionAccount) return [];
  const result = [];
  const seen = new Set();
  const accountName = String(sessionAccount).toLowerCase();
  const account = accounts?.accounts?.get?.(accountName);

  if (account) {
    for (let slot = 0; slot < (account.characters?.length ?? 0); slot++) {
      const character = account.characters[slot];
      if (!character) continue;
      const serial = character.mobileSerial >>> 0;
      const mobile = world?.mobiles?.get?.(serial);
      result.push({
        slot, name: character.name ?? mobile?.name ?? '?',
        mobileSerial: character.mobileSerial, mob: mobile, online: !!mobile?.client,
      });
      seen.add(serial);
    }
  }

  let fallbackSlot = result.length;
  for (const mobile of world?.mobiles?.values?.() ?? []) {
    if (seen.has(mobile.serial >>> 0) || !mobile.isPlayer) continue;
    if (String(mobile.accountName ?? '').toLowerCase() !== accountName) continue;
    result.push({
      slot: fallbackSlot++, name: mobile.name ?? '?',
      mobileSerial: mobile.serial >>> 0, mob: mobile, online: !!mobile.client,
    });
    seen.add(mobile.serial >>> 0);
  }

  result.sort((a, b) => Number(b.online) - Number(a.online));
  if (Number.isFinite(preferredSlot)) {
    const preferred = result.find((character) => character.slot === preferredSlot);
    if (preferred) return [preferred];
  }
  return result;
}
