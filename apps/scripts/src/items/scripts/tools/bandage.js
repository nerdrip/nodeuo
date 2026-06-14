// Bandage — re-routes through the existing `[bandage` chat command so
// the Healing skill check, target prompt, and timing all stay in one
// place. The script is just a sugar shim for double-click → command.

export default function buildBandageScript(api) {
  return {
    name: 'bandage',
    onUse(_w, item, user) {
      user?.client?.send?.(api.protocol.unicodeMessage?.({ text: '[bandage' }));
      void item;
      return true;
    },
  };
}
