// Soulforge — Imbuing crafting station. ServUO `Items/Skill Items/
// Imbuing/Forge/SoulForge.cs`. We stamp `_soulforge: true` so the
// `[imbue` Soulforge-proximity gate (batch #18) finds it, and on
// double-click we just remind the player how to use Imbuing.

export default function buildSoulforge(_api) {
  return {
    name: 'soulforge',
    onCreate(_world, item) {
      // Tag the instance so the imbue/unravel commands' 2-tile range
      // check recognises it regardless of itemId fluctuation.
      item._soulforge = true;
      item.movable = false;
    },
    onUse(_world, _item, user) {
      if (!user?.client) return;
      user.client.sendSystemMessage?.(
        'The Soulforge hums softly. Target an item to imbue.',
      );
      // Sentinel — game-scene re-emits this as `ui:imbuing:open`. The
      // client gump then asks the server for the IMBUE_ATTR list and
      // displays it for selection. Players still have access to the
      // raw `[imbue` / `[unravel` commands underneath.
      user.client.sendSystemMessage?.('@@OPEN_IMBUING_GUMP@@');
    },
  };
}
