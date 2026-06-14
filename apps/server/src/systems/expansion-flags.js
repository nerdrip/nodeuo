// Expansion Flags — port of ServUO `Scripts/Services/Expansions/`.
// Toggle which expansion-locked content is reachable. ServUO uses an
// enum + bitfield; we keep a flat object so config files / CLI flags
// can flip individual eras without touching code.
//
// Default: ALL on (modern shard). Operator can disable via
// `expansion-flags.set('toL', false)` to lock the Eodon content.

const FLAGS = {
  uo:   true,      // base Ultima Online
  t2a:  true,      // The Second Age
  ren:  true,      // Renaissance
  td:   true,      // Third Dawn
  lbr:  true,      // Lord Blackthorn's Revenge
  aos:  true,      // Age of Shadows
  se:   true,      // Samurai Empire
  ml:   true,      // Mondain's Legacy
  sa:   true,      // Stygian Abyss
  hs:   true,      // High Seas
  tol:  true,      // Time of Legends (Eodon)
  eaj:  true,      // Endless Adventures of Jhelom
};

export function isEnabled(flag) { return !!FLAGS[String(flag).toLowerCase()]; }
export function set(flag, value) { FLAGS[String(flag).toLowerCase()] = !!value; }
export function snapshot() { return { ...FLAGS }; }

/** Convenience: gate a feature behind multiple flags (AND semantics). */
export function gate(...flags) { return flags.every(isEnabled); }
