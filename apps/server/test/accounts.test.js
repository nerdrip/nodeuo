import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountDB, hashPassword, verifyPassword } from '../src/net/accounts.js';

describe('password hashing', () => {
  it('round-trips a password through scrypt', () => {
    const h = hashPassword('hunter2');
    expect(verifyPassword('hunter2', h)).toBe(true);
    expect(verifyPassword('hunter3', h)).toBe(false);
  });

  it('rejects malformed hash strings', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(verifyPassword('x', 'scrypt:1:1:1')).toBe(false);
  });
});

describe('AccountDB', () => {
  it('replaces an existing accounts snapshot repeatedly on Windows-safe paths', () => {
    const dir = tmpDir();
    const db = new AccountDB(dir);
    db.authenticate('writer', 'secret', { autoCreate: true });
    for (let i = 0; i < 20; i++) {
      db.accounts.get('writer').lastLogin = `pass-${i}`;
      expect(() => db.saveSync()).not.toThrow();
    }
    const loaded = new AccountDB(dir);
    loaded.load();
    expect(loaded.accounts.get('writer').lastLogin).toBe('pass-19');
  });

  function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'uo-accounts-'));
  }

  it('auto-creates on first login, grants Admin to the first account', () => {
    const dir = tmpDir();
    const db = new AccountDB(dir);
    db.load();

    const res = db.authenticate('alice', 'pw', { autoCreate: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.account.accessLevel).toBe('Admin');

    const res2 = db.authenticate('bob', 'pw', { autoCreate: true });
    expect(res2.ok).toBe(true);
    if (!res2.ok) return;
    expect(res2.account.accessLevel).toBe('Player');

    // Second login should verify existing hash, not re-create.
    const res3 = db.authenticate('alice', 'pw');
    expect(res3.ok).toBe(true);

    // Wrong password fails without auto-create.
    const res4 = db.authenticate('alice', 'wrong');
    expect(res4.ok).toBe(false);
  });

  it('persists to disk and reloads', () => {
    const dir = tmpDir();
    const db1 = new AccountDB(dir);
    db1.load();
    db1.authenticate('carol', 'pw', { autoCreate: true });

    const db2 = new AccountDB(dir);
    db2.load();
    const res = db2.authenticate('carol', 'pw');
    expect(res.ok).toBe(true);
  });

  it('rejects banned accounts', () => {
    const dir = tmpDir();
    const db = new AccountDB(dir);
    db.load();
    const acc = db.createAccount('evil', 'pw');
    acc.banned = true;
    const res = db.authenticate('evil', 'pw');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('banned');
  });
});
