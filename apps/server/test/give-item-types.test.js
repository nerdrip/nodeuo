import { describe, expect, it, vi } from 'vitest';
import registerGive from '../../scripts/src/commands/admin/give.js';

describe('ServUO item type authoring boundary', () => {
  it('creates inherited ServUO definitions by stable class id', () => {
    const registered = new Map();
    const giveItem = vi.fn((_mobile, data) => ({ serial: 0x40000001, ...data }));
    const api = {
      commands: {
        register: (command) => registered.set(command.name, command),
        unregister: (name) => registered.delete(name),
      },
      game: { mobile: { giveItem } },
      templates: { get: () => null },
      itemTypes: {
        resolve: (name) => name === 'AloronsBustier' ? {
          definitionId: name, artId: 0x7823, itemId: 0x7823,
          name: "Aloron's Armor", hue: 0, servuoClass: name,
        } : null,
      },
    };
    registerGive(api);
    const sendSystemMessage = vi.fn();
    registered.get('give').run({
      args: ['AloronsBustier'], sender: { serial: 1 }, state: { sendSystemMessage },
    });

    expect(giveItem).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      definitionId: 'AloronsBustier', itemId: 0x7823, servuoClass: 'AloronsBustier',
    }), expect.objectContaining({ randomGrid: true }));
    expect(sendSystemMessage).toHaveBeenCalledWith(expect.stringContaining("Aloron's Armor"));
  });
});
