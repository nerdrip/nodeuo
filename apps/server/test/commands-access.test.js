// Regression tests for S-02 (access level enforcement on text commands).
// Before the fix, CommandRegistry.dispatch ignored access metadata, so a
// plain player could [reload, [nuke, [teleport, etc.

import { describe, it, expect, vi } from 'vitest';
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
