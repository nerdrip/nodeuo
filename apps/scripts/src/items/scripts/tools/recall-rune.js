export default function buildRecallRune() {
  return {
    name: 'recall-rune',
    onUse(_world, item, user) {
      if (!user?.client) return true;
      const dest = item?.runeDest;
      if (!dest) {
        user.client.sendSystemMessage?.('This recall rune is blank.');
        user.client.sendSystemMessage?.('Cast Mark or use [mark to bind it to your current location.');
        return true;
      }
      const label = dest.label ?? `(${dest.x},${dest.y})`;
      user.client.sendSystemMessage?.(`This rune is marked for ${label}.`);
      user.client.sendSystemMessage?.(`Map ${dest.map ?? 0}: ${dest.x ?? 0}, ${dest.y ?? 0}, ${dest.z ?? 0}.`);
      return true;
    },
  };
}
