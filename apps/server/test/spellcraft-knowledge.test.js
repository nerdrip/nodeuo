import { describe, expect, it, vi } from 'vitest';
import { World } from '../src/world/world.js';
import { createItem, setItemParent } from '../src/world/items.js';
import {
  buildCustomSpellScrollScript, buildSpellcraftKnowledgeScript,
} from '../../scripts/src/items/scripts/functional/spell-schema.js';

describe('spellcraft knowledge items', () => {
  it('teaches a discovery, grants research and consumes exactly one item', () => {
    const world = new World();
    const user = world.createMobile({ name: 'Scribe', x: 1, y: 1, z: 0, map: 1 });
    const pack = createItem(world, { itemId: 0x0E75, parent: user.serial, layer: 21 });
    const fragment = createItem(world, {
      itemId: 0x1F2D, amount: 2, spellcraftUnlock: 'element:fire', spellcraftXp: 75,
    });
    setItemParent(world, fragment, pack.serial);
    user.client = { sendSystemMessage: vi.fn(), send: vi.fn(), account: { accessLevel: 'Player' } };
    const learn = vi.fn(() => ({
      ok: true, discovered: true, xpGained: 75, leveledUp: true,
      profile: { rank: 'Apprentice' },
    }));
    const api = {
      spellComposer: { profile: () => ({ admin: false }), learn },
      game: { inventory: { isInPack: (item) => item.parent === pack.serial } },
      protocol: { containerContentUpdate: vi.fn(() => new Uint8Array([1])) },
    };
    buildSpellcraftKnowledgeScript(api).onUse(world, fragment, user);
    expect(learn).toHaveBeenCalledWith(user, 'element:fire', 75);
    expect(fragment.amount).toBe(1);
    expect(user.client.sendSystemMessage).toHaveBeenCalledWith(expect.stringContaining('Apprentice'));
  });

  it('does not consume knowledge for an administrator', () => {
    const world = new World();
    const user = world.createMobile({ name: 'Admin', x: 1, y: 1, z: 0, map: 1 });
    const item = createItem(world, { itemId: 0x0FF1 });
    user.client = { sendSystemMessage: vi.fn() };
    const learn = vi.fn();
    const api = {
      spellComposer: { profile: () => ({ admin: true }), learn },
      game: { inventory: { isInPack: () => true } },
    };
    buildSpellcraftKnowledgeScript(api).onUse(world, item, user);
    expect(learn).not.toHaveBeenCalled();
    expect(world.items.has(item.serial)).toBe(true);
  });

  it('enforces the published cooldown when schema scrolls are invoked directly', () => {
    const world = new World();
    const user = world.createMobile({ name: 'Scribe', x: 1, y: 1, z: 0, map: 1 });
    const pack = createItem(world, { itemId: 0x0E75, parent: user.serial, layer: 21 });
    const first = createItem(world, { itemId: 0x1F2D, customSpellId: 10001 });
    const second = createItem(world, { itemId: 0x1F2D, customSpellId: 10001 });
    setItemParent(world, first, pack.serial);
    setItemParent(world, second, pack.serial);
    user.client = {
      account: { accessLevel: 'Player' }, sendSystemMessage: vi.fn(), send: vi.fn(),
    };
    const castSpell = vi.fn(() => ({ ok: true }));
    const draft = { spellId: 10001, requiredRank: 1, cooldownMs: 5000 };
    const api = {
      game: { inventory: { isInPack: (item) => item.parent === pack.serial } },
      spellComposer: { getPublished: () => draft, profile: () => ({ admin: false, level: 1 }) },
      systems: { spells: { getSpell: () => ({ requiresTarget: false }), castSpell } },
      protocol: { removeEntity: vi.fn(() => new Uint8Array([1])) },
    };
    const script = buildCustomSpellScrollScript(api);
    script.onUse(world, first, user);
    script.onUse(world, second, user);
    expect(castSpell).toHaveBeenCalledOnce();
    expect(world.items.has(first.serial)).toBe(false);
    expect(world.items.has(second.serial)).toBe(true);
    expect(user._castReadyAt).toBeGreaterThan(Date.now());
  });
});
