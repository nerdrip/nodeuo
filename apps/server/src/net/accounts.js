// Account registry with hashed passwords.
//
// Persists to saves/accounts.json. Passwords are stored as a scrypt-based
// key derivation ("scrypt:<N>:<r>:<p>:<base64Salt>:<base64Hash>") so a
// compromised save file cannot trivially reveal plaintext. node:crypto is
// built in — no extra deps.
//
// Account shape:
//   { username, created, lastLogin, hash, accessLevel, banned }
// accessLevel values, in ascending privilege order (ServUO AccessLevel):
//   'Player'    — default; no commands beyond chat / movement.
//   'Counselor' — help-queue + [page response, no world-mutating commands.
//   'Seer'      — spawn / move / read-only inspections, no destroy / ban.
//   'GM'        — full mutation, [del / [tele / [kill / [add etc.
//   'Admin'     — GM + persistence reload + account management.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

/** @returns {string}  scrypt password hash encoding */
export function hashPassword(plaintext) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(plaintext, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('base64')}:${key.toString('base64')}`;
}

/** @returns {boolean} */
export function verifyPassword(plaintext, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = parseInt(parts[1], 10);
  const r = parseInt(parts[2], 10);
  const p = parseInt(parts[3], 10);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  const actual = crypto.scryptSync(plaintext, salt, expected.length, { N, r, p });
  return crypto.timingSafeEqual(expected, actual);
}

/**
 * @typedef {Object} Account
 * @property {string} username
 * @property {string} hash         scrypt-encoded
 * @property {string} created
 * @property {string} [lastLogin]
 * @property {'Player'|'Counselor'|'Seer'|'GM'|'Admin'} accessLevel
 * @property {boolean} banned
 * @property {number} [mobileSerial]  serial of the persistent player mobile;
 *                                    set on first `bringIntoWorld` and reused
 *                                    on subsequent logins so reconnecting
 *                                    doesn't spawn duplicate characters.
 * @property {{ name:string, mobileSerial:number }[]} [characters]
 *                                    optional character slots used by the
 *                                    character select and admin panel.
 */

export class AccountDB {
  /** @param {string} saveDir */
  constructor(saveDir) {
    this.saveDir = saveDir;
    this.file = path.join(saveDir, 'accounts.json');
    /** @type {Map<string, Account>} */
    this.accounts = new Map();
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    const raw = fs.readFileSync(this.file, 'utf8');
    /** @type {Account[]} */
    const list = JSON.parse(raw);
    for (const a of list) {
      // Rehydrate Sets that we serialized as arrays in saveSync().
      // Existing fields (achievements/titles/recipes/cleanupRedeemed)
      // round-trip through JSON as arrays — turn them back into Sets
      // so callers get the canonical type.
      if (a.achievements?.unlocked && Array.isArray(a.achievements.unlocked)) {
        a.achievements.unlocked = new Set(a.achievements.unlocked);
      }
      if (a.titles?.unlocked && Array.isArray(a.titles.unlocked)) {
        a.titles.unlocked = new Set(a.titles.unlocked);
      }
      if (a.recipes && Array.isArray(a.recipes)) {
        a.recipes = new Set(a.recipes);
      }
      this.accounts.set(a.username.toLowerCase(), a);
    }
  }

  saveSync() {
    fs.mkdirSync(this.saveDir, { recursive: true });
    const tmp = this.file + '.tmp';
    // Serializer: convert Sets → arrays so JSON.stringify doesn't drop
    // them silently. Mirrors the rehydrate step in load().
    const replacer = (_key, value) => {
      if (value instanceof Set) return [...value];
      if (value instanceof Map) return [...value.entries()];
      return value;
    };
    fs.writeFileSync(tmp, JSON.stringify([...this.accounts.values()], replacer, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /**
   * Authenticate a username/password pair, auto-creating the account if
   * `autoCreate` is true and the username is new (dev convenience).
   *
   * @param {string} username
   * @param {string} password
   * @param {{ autoCreate?: boolean }} [opts]
   * @returns {{ ok: true, account: Account } | { ok: false, reason: string }}
   */
  authenticate(username, password, opts = {}) {
    if (!username || username.length > 30) return { ok: false, reason: 'invalid username' };
    const key = username.toLowerCase();
    let acc = this.accounts.get(key);
    if (!acc) {
      if (!opts.autoCreate) return { ok: false, reason: 'no such account' };
      // First ever user becomes Admin. Beyond that, any username listed in
      // the UO_ADMINS env var (comma-separated) also auto-promotes — handy
      // for solo dev shards where the operator keeps re-creating the same
      // "admin" login but the literal first-ever account was a one-off test.
      const envAdmins = String(process.env.UO_ADMINS ?? 'admin')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      const isFirst = this.accounts.size === 0;
      const isPromoted = envAdmins.includes(key);
      acc = {
        username,
        hash: hashPassword(password),
        created: new Date().toISOString(),
        accessLevel: (isFirst || isPromoted) ? 'Admin' : 'Player',
        banned: false,
      };
      this.accounts.set(key, acc);
      this.saveSync();
    } else {
      if (acc.banned) return { ok: false, reason: 'banned' };
      if (!verifyPassword(password, acc.hash)) return { ok: false, reason: 'bad password' };
      // Idempotent re-promote: existing accounts created BEFORE the
      // auto-promote rule (or after the UO_ADMINS env was widened)
      // would stay on accessLevel='Player' forever otherwise. User
      // report 2026-05-17: logged in as "admin", saw the Player badge
      // in the Commands panel + an empty command catalogue because the
      // 0xBF 0x00A0 push filters by ACCESS_ORDER. Re-evaluating the
      // env list at every login keeps the listed names in lock-step
      // with their intended privilege.
      const envAdminsRecheck = String(process.env.UO_ADMINS ?? 'admin')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (envAdminsRecheck.includes(key)
          && acc.accessLevel !== 'Admin'
          && acc.accessLevel !== 'Administrator') {
        acc.accessLevel = 'Admin';
        this.saveSync();
      }
    }
    acc.lastLogin = new Date().toISOString();
    return { ok: true, account: acc };
  }

  /** Recheck the UO_ADMINS env list and re-promote `username` to Admin
   *  if listed. Idempotent — already-Admin accounts are unchanged.
   *  Returns the resulting account or null. Callable from any code
   *  path that mutates a session's account state and wants to defend
   *  against accidental demotion (e.g. command-catalogue push,
   *  command dispatch). User report 2026-05-18: after `[createworld`
   *  the Commands panel showed "Player" + empty list, suggesting
   *  state.account.accessLevel had drifted; this recheck restores it. */
  recheckPromotion(username) {
    if (!username) return null;
    const key = String(username).toLowerCase();
    const acc = this.accounts.get(key);
    if (!acc) return null;
    const envAdmins = String(process.env.UO_ADMINS ?? 'admin')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (envAdmins.includes(key)
        && acc.accessLevel !== 'Admin'
        && acc.accessLevel !== 'Administrator') {
      acc.accessLevel = 'Admin';
      try { this.saveSync(); } catch { /* advisory */ }
    }
    return acc;
  }

  /** Create a fresh account; throws if the username already exists. */
  createAccount(username, password, accessLevel = 'Player') {
    const key = username.toLowerCase();
    if (this.accounts.has(key)) throw new Error(`account exists: ${username}`);
    /** @type {Account} */
    const acc = {
      username,
      hash: hashPassword(password),
      created: new Date().toISOString(),
      accessLevel,
      banned: false,
    };
    this.accounts.set(key, acc);
    this.saveSync();
    return acc;
  }
}
