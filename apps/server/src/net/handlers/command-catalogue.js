import { NodeUOFeature } from '@uo/nodeuo-protocol';
import { sendNodeUOEvent } from './nodeuo-modern.js';

/** Push the filtered shard command catalogue to one negotiated client. */
export function pushCommandCatalogue(state) {
  if (!state || (!state.send && !state.sendNodeUOMessage)
      || !state.supportsNodeUO?.(NodeUOFeature.RichGumps)) return;
  try {
    const registry = state.ctx?.commands ?? state.ctx?.commandRegistry;
    if (!registry?.commands) return;
    try {
      const refreshed = state.ctx?.accounts?.recheckPromotion?.(state.accountName);
      if (refreshed) state.account = refreshed;
    } catch { /* advisory */ }
    const access = state.account?.accessLevel ?? 'Player';
    const accessOrder = {
      Player: 0, Counselor: 1, Counsellor: 1, Seer: 2,
      GM: 3, GameMaster: 3, Admin: 4, Administrator: 4,
    };
    const level = accessOrder[access] ?? 0;
    const source = typeof registry.list === 'function'
      ? registry.list()
      : [...registry.commands.values()].filter((command) => !command?.aliasOf && command?.hidden !== true);
    const commands = [];
    const seen = new Set();
    for (const command of source) {
      if (!command || typeof command.name !== 'string' || !command.name) continue;
      const name = command.name.toLowerCase();
      if (seen.has(name) || (accessOrder[command.access ?? 'Admin'] ?? 4) > level) continue;
      seen.add(name);
      commands.push({ name, help: command.help ?? '', access: command.access ?? 'Admin' });
    }
    commands.sort((a, b) => a.name.localeCompare(b.name));
    try { state.sendSystemMessage?.(`Commands available: ${commands.length} (access: ${access}).`); }
    catch { /* catalogue delivery remains useful if the advisory line fails */ }
    sendNodeUOEvent(state, {
      feature: NodeUOFeature.RichGumps,
      payload: { operation: 'command-catalogue', accessLevel: access, commands },
    });
  } catch (error) {
    console.warn('[cmd-catalog] push failed:', error?.message);
  }
}

export function pushCommandCatalogueToAll(world) {
  for (const mobile of world?.mobiles?.values?.() ?? []) {
    if (mobile.client) pushCommandCatalogue(mobile.client);
  }
}
