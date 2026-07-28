// Region-entry music, season, and achievement tracking.

// Region tracker — detect when each player crosses into a new named
// region and push a 0x6D PlayMusic + a system message. Region.music is
// optional; absent ⇒ stop the loop (id 0xFFFF). Mirrors ServUO's
// `RegionRules.OnEnter` for the music slot. Running at 1Hz; players
// rarely hop regions faster than once per tile-step (≈200ms walk),
// and the cost is just a `regions.at()` per online player.
// `Region.music` is authored as a string (the .mp3 filename UO ships
// in `Music/Digital/Config.txt`, e.g. "britain1"); ServUO translates
// the name to the numeric MusicName enum the 0x6D packet carries.
// Earlier `(top?.music | 0)` cast a string to 0 and emitted 0xFFFF
// (stop) on every region change — the player's "music 65535" console
// line. Resolve through this lookup so authored names actually play.
const MUSIC_NAME_TO_ID = {
  britain1: 8,  britain2: 9,
  forest_a: 7,  mountn_a: 19,
  trinsic:  23, vesper:   24,
  jhelom:   12, magincia: 14,
  yew:      31, moonglow: 18, ocllo: 21,
  cove:     11, skarabrae: 22,
  dungeon2: 21, dungeon9: 28, dungeon10: 29,
  death:    42, victory:  52,
  oldult01: 0,  oldult02: 1, oldult03: 2, oldult04: 3, oldult05: 4, oldult06: 5,
  combat:   38, combat2:  39, combat3:  40,
  approach: 53,

  // Tokuno expansion music (Music/Digital/Tokuno*.mp3)
  tokuno1: 60, tokuno2: 61, tokuno3: 62, tokuno4: 63, tokuno5: 64,
  // ML / SA expansions
  malas:    33, samlethe: 41, samlethe2: 41, despise: 26, deceit:  25,
  hythloth: 30, destard:  32, covetous: 27, shame:    34, wrong:   35,
  // Tavern + small interior loops
  tavern01: 36, tavern02: 37, tavern03: 17,
  // SA/ML extras
  stones2:  44, sailing: 43, gargoyle_queen: 45, primeval: 46,
  // Special-event tracks
  honour:   54, valor:   55, justice:  56, sacrifice: 57, compassion: 58, humility: 59,
};
function resolveMusicId(name) {
  if (typeof name === 'number') return name & 0xffff;
  if (typeof name !== 'string') return 0xFFFF;
  return MUSIC_NAME_TO_ID[name.toLowerCase()] ?? 0xFFFF;
}

export function startRegionTracker({ world, regions, achievementsSystem, protocol }) {
  const regionTimer = setInterval(() => {
  const online = typeof world.onlineMobiles === 'function'
    ? world.onlineMobiles()
    : world.mobiles.values();
  for (const m of online) {
    if (!m.client) continue;
    const here = regions.at(m.map ?? 1, m.x | 0, m.y | 0);
    const top = here.length > 0 ? here[here.length - 1] : null;
    const lastName = m._lastRegion;
    const newName = top?.name ?? null;
    // Facet-visit achievement (Ilshenar / Tokuno / Malas / TerMur).
    const lastFacet = m._lastFacet;
    if (m.client.account && lastFacet !== m.map) {
      m._lastFacet = m.map;
      try {
        const unlocks = achievementsSystem.trigger(m.client.account, 'visit-facet', { facet: m.map });
        for (const u of unlocks) {
          m.client.sendSystemMessage?.(
            `★ Achievement unlocked: ${u.achievement.name}` +
            (u.grantedTitle ? ` (title: ${u.grantedTitle})` : '')
          );
        }
      } catch { /* advisory */ }
    }
    // Gold-snapshot achievement (carrying 1M gold). Cheap snapshot
    // every region tick (≤200 players × 1Hz).
    if (m.client.account && (m.gold ?? 0) >= 1_000_000) {
      try {
        const unlocks = achievementsSystem.trigger(m.client.account, 'gold-snapshot', { amount: m.gold });
        for (const u of unlocks) {
          m.client.sendSystemMessage?.(
            `★ Achievement unlocked: ${u.achievement.name}` +
            (u.grantedTitle ? ` (title: ${u.grantedTitle})` : '')
          );
        }
      } catch { /* advisory */ }
    }
    if (lastName === newName) continue;
    m._lastRegion = newName;
    // ServUO `Region.OnEnter` falls back to the parent region's music
    // when the innermost region has none — without this every nested
    // "tavern room" / "bedroom" region without a music attr silenced
    // the city's main loop on entry, then any move back out re-played
    // it. User report 2026-05-19 "jak zmienia się miasta bywa różnie
    // [z muzyką]". Walk `here` from innermost outward and use the
    // first region with a music attr; only emit 0xFFFF (stop) when
    // nothing in the stack declares one.
    let musicRegion = null;
    for (let i = here.length - 1; i >= 0; i--) {
      if (here[i]?.music != null) { musicRegion = here[i]; break; }
    }
    const musicId = musicRegion ? resolveMusicId(musicRegion.music) : 0xFFFF;
    try {
      m.client.send(protocol.playMusic(musicId));
    } catch { /* ignore — disconnect race */ }
    // Region seasonal override — Spring/Summer/Fall/Winter/Desolation.
    // ServUO `Region.GetSeason`: a dungeon region carries Desolation
    // (4), Ilshenar uses Fall (2), Trammel/Felucca cycle naturally.
    // Region authors set `season: 0..4` to pin the value on entry;
    // unset means "no change" and the client keeps the prior season.
    const wantSeason = top?.season;
    if (wantSeason != null && wantSeason !== m._lastSeason) {
      m._lastSeason = wantSeason;
      try {
        const packet = protocol.seasonChange(wantSeason | 0, 1);
        if (m.client.sendCosmetic) m.client.sendCosmetic(packet, 'season');
        else m.client.send(packet);
      }
      catch { /* socket race */ }
    }
    if (newName) m.client.sendSystemMessage?.(`You have entered ${newName}.`);
  }
}, 1000);
  regionTimer.unref();
  return regionTimer;
}

