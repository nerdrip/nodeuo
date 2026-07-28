// Sign posts are intentionally tiny but still functional: double-clicking
// reads the authored destination/shop/dungeon label instead of falling into
// the generic "nothing special" response.

export default function buildSignPost() {
  return {
    name: 'sign-post',
    onUse(_world, item, user) {
      const label = String(item.sign?.text ?? item.displayName ?? item.name ?? 'an unmarked sign').trim();
      user?.client?.sendSystemMessage?.(`The sign reads: ${label}.`);
      return true;
    },
  };
}
