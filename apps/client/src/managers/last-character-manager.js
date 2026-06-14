// LastCharacterManager — port of ClassicUO
// `Game/Managers/LastCharacterManager.cs`. Persists the last successful
// character pick so the login scene can offer "auto-login" / preselect.
//
// Storage: localStorage. Key per account name so multiple accounts on
// one browser don't trample each other.

const KEY_PREFIX = 'uo:lastChar:';

export const lastCharacterManager = {
  /** Save a `(account, slotIndex, charName)` triple. */
  save(account, slotIndex, charName = '') {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(KEY_PREFIX + account, JSON.stringify({
        slot: slotIndex | 0, name: String(charName || ''), ts: Date.now(),
      }));
    } catch { /* quota / disabled */ }
  },

  /** @returns {{ slot:number, name:string, ts:number } | null} */
  load(account) {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(KEY_PREFIX + account);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (typeof obj?.slot !== 'number') return null;
      return obj;
    } catch { return null; }
  },

  forget(account) {
    if (typeof localStorage === 'undefined') return;
    try { localStorage.removeItem(KEY_PREFIX + account); }
    catch { /* ignore */ }
  },

  /** Convenience for the login scene's "Continue as <name>" tile. */
  describe(account) {
    const r = this.load(account);
    if (!r) return null;
    const ageH = ((Date.now() - r.ts) / 3600_000) | 0;
    return r.name
      ? `${r.name} (slot ${r.slot}, ${ageH}h ago)`
      : `slot ${r.slot} (${ageH}h ago)`;
  },
};
