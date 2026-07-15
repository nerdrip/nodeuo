import { describe, expect, it, vi } from 'vitest';
import registerCreate from '../../scripts/src/commands/admin/create.js';

describe('visual create command', () => {
  it('opens the category hub and delegates buttons to canonical catalogues', () => {
    const registered = new Map();
    const dispatch = vi.fn(() => true);
    let sent = null;
    let respond = null;
    const api = {
      commands: {
        register: (definition) => registered.set(definition.name, definition),
        unregister: (name) => registered.delete(name),
        dispatch,
      },
      gumps: {
        send: (_state, definition, callback) => { sent = definition; respond = callback; },
      },
    };
    registerCreate(api);
    const state = { sendSystemMessage: vi.fn() };
    const ctx = { state, sender: { serial: 1 } };

    registered.get('create').run(ctx, []);

    expect(sent?.gumpId).toBe(0x43524541);
    expect(sent?.texts).toContain('Items');
    expect(sent?.texts).toContain('Mobiles');
    expect(sent?.layout).toContain('mobilepic');
    respond({ buttonId: 100 });
    expect(dispatch).toHaveBeenCalledWith('items', ctx);

    registered.get('create').run(ctx, ['mobile', 'rat']);
    expect(dispatch).toHaveBeenCalledWith('mobs rat', ctx);
  });
});
