// Regression tests for S-02 (access level enforcement on text commands).
// Before the fix, CommandRegistry.dispatch ignored access metadata, so a
// plain player could [reload, [nuke, [teleport, etc.

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommandRegistry, hasAccess } from '../src/net/commands.js';

function makeCtx(accessLevel = 'Player') {
  const messages = [];
  return {
    state: {
      account: accessLevel ? { accessLevel } : null,
      accountName: 'tester',
      sendSystemMessage: (text) => messages.push(text),
    },
    messages,
  };
}

describe('CommandRegistry access enforcement', () => {
  it('dispatches compatibility aliases but lists only the canonical command', () => {
    const reg = new CommandRegistry();
    const run = vi.fn();
    expect(reg.register({
      name: 'tp', aliases: ['tpto', 'teleportto'], run, access: 'GM',
    })).toBe(true);

    reg.dispatch('tpto alice', makeCtx('GM'));
    expect(run).toHaveBeenCalledOnce();
    expect(reg.list().map((c) => c.name)).toEqual(['tp']);
    expect(reg.commands.get('tpto')).toMatchObject({ aliasOf: 'tp', hidden: true });

    reg.unregister('tp');
    expect(reg.commands.has('tp')).toBe(false);
    expect(reg.commands.has('tpto')).toBe(false);
  });

  it('keeps the first implementation and records duplicate registrations', () => {
    const reg = new CommandRegistry();
    const first = vi.fn();
    const duplicate = vi.fn();
    expect(reg.register({ name: 'save', run: first, access: 'Admin' })).toBe(true);
    expect(reg.register({ name: 'SAVE', run: duplicate, access: 'Admin' })).toBe(false);

    reg.dispatch('save', makeCtx('Admin'));
    expect(first).toHaveBeenCalledOnce();
    expect(duplicate).not.toHaveBeenCalled();
    expect(reg.collisions).toHaveLength(1);
  });

  it('denies Player access to a command with no explicit access (defaults to Admin)', () => {
    const reg = new CommandRegistry();
    const run = vi.fn();
    reg.register({ name: 'nuke', run });

    const ctx = makeCtx('Player');
    const handled = reg.dispatch('nuke', ctx);
    expect(handled).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(ctx.messages.join('\n')).toMatch(/lack the access level/);
  });

  it('allows Admin to run Admin-only commands', () => {
    const reg = new CommandRegistry();
    const run = vi.fn();
    reg.register({ name: 'nuke', run, access: 'Admin' });

    const ctx = makeCtx('Admin');
    reg.dispatch('nuke', ctx);
    expect(run).toHaveBeenCalledOnce();
  });

  it('allows Player to run an explicitly Player-marked command', () => {
    const reg = new CommandRegistry();
    const run = vi.fn();
    reg.register({ name: 'help', run, access: 'Player' });

    const ctx = makeCtx('Player');
    reg.dispatch('help', ctx);
    expect(run).toHaveBeenCalledOnce();
  });

  it('exposes parsed tokens on ctx.args AND as the run() second parameter', () => {
    // Many scripts read ctx.args rather than the run() second arg. Both must
    // work — an earlier fix added ctx.args after finding party/guild/effect
    // handlers that crashed with "undefined is not iterable" on ctx.args.
    const reg = new CommandRegistry();
    let seenArgs, seenCtxArgs;
    reg.register({
      name: 'echo', access: 'Player',
      run: (ctx, args) => { seenArgs = args; seenCtxArgs = ctx.args; },
    });

    reg.dispatch('echo hello world', makeCtx('Player'));
    expect(seenArgs).toEqual(['hello', 'world']);
    expect(seenCtxArgs).toEqual(['hello', 'world']);
  });

  it('treats an anonymous (unauthenticated) sender as Player', () => {
    const reg = new CommandRegistry();
    const run = vi.fn();
    reg.register({ name: 'shutdown', run }); // default Admin

    const ctx = { state: { account: null, sendSystemMessage: () => {} } };
    reg.dispatch('shutdown', ctx);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('script command catalogue audit', () => {
  it('has no duplicate literal command owners', () => {
    const root = fileURLToPath(new URL('../../scripts/src/', import.meta.url));
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) files.push(full);
      }
    };
    walk(root);
    const owners = new Map();
    const pattern = /commands(?:\.|\?\.)register(?:\?\.)?\s*\(\s*\{[\s\S]*?\bname\s*:\s*(['"`])([^'"`$]+)\1[\s\S]*?\}\s*\)/g;
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(pattern)) {
        const name = match[2].trim().toLowerCase();
        const list = owners.get(name) ?? [];
        list.push(path.relative(root, file));
        owners.set(name, list);
      }
    }
    const duplicates = [...owners]
      .filter(([, filesForName]) => filesForName.length > 1)
      .map(([name, filesForName]) => ({ name, files: filesForName }));
    expect(duplicates).toEqual([]);
  });
});

describe('hasAccess helper', () => {
  it('respects the Player < Counselor < GM < Admin ordering', () => {
    expect(hasAccess('Admin',    'GM')).toBe(true);
    expect(hasAccess('GM',       'Admin')).toBe(false);
    expect(hasAccess('Counselor','Player')).toBe(true);
    expect(hasAccess('Player',   'Counselor')).toBe(false);
    expect(hasAccess('Player',   'Player')).toBe(true);
  });

  it('treats unknown access strings as the most restrictive', () => {
    expect(hasAccess('bogus', 'Player')).toBe(false);
  });
});
