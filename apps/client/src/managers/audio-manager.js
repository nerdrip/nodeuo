// AudioManager — plays UO sound effects + music. Mirrors ClassicUO's
// Game/Managers/AudioManager.cs at MVP scope.
//
// Sounds: streamed via HTTP Range from `sounds.bin` (entry index in
// `sounds.json`), decoded by Web Audio API into AudioBuffers, cached
// per id.
//
// Music: ServUO sends 0x6D PlayMusic with a track id. UO ships music as
// MP3s under `Music/` in the install directory; we don't (yet) extract
// those — for now we log the requested track. Once an extractor + a
// Music/ HTTP route exist, this hook will play them.
//
// Volume gates flow through ProfileManager.

import { bus } from '../core/event-bus.js';
import { profile } from './profile-manager.js';
import { world } from '../world/world.js';

const BASE = '/assets';

export function resolveSfxSourceMap(requestedMap, playerMap) {
  return Number.isFinite(requestedMap) ? requestedMap : playerMap;
}

class AudioManager {
  constructor() {
    /** @type {AudioContext | null} */
    this.ctx = null;
    /** @type {Map<number, AudioBuffer>} sound id → decoded buffer */
    this._buffers = new Map();
    /** @type {GainNode | null} master gain */
    this._master = null;
    /** @type {GainNode | null} sfx gain */
    this._sfx = null;
    /** @type {GainNode | null} music gain */
    this._music = null;
    /** @type {{count:number,entries:Record<number,{offset:number,size:number,name:string}>} | null} */
    this._index = null;
    /** @type {{count:number,entries:Record<number,{file:string,loop:boolean,name:string}>} | null} */
    this._musicIndex = null;
    /** Currently-playing HTMLAudioElement for streaming music. */
    this._musicEl = null;
    /** Track id of the currently-playing music (or 0xFFFF if stopped). */
    this._musicId = 0xFFFF;
    /** Per-SFX last-played timestamp for the dedup gate (CUO Sound.cs:121). */
    this._lastPlayedAt = new Map();
    /** lazy-init flag — browsers require user gesture before AudioContext is allowed */
    this._initialized = false;

    bus.on('atmosphere:music', ({ musicId }) => this._onMusicRequest(musicId));
    // Audit #38 P2 #5 — refresh music on facet change. CUO
    // `World.cs MapIndex` setter triggers `Audio.PlayMusic` for the
    // new facet's default track. Was: facet:changed fired from game-
    // scene after `setFacet` but no subscriber — Felucca music kept
    // playing on Trammel after a moongate.
    bus.on('facet:changed', ({ mapId }) => {
      // CUO `Data/Maps.cs` default-music table. Trammel + Felucca
      // share "approach" track 2; Ilshenar / Malas / Tokuno / TerMur
      // have distinct themes.
      const FACET_MUSIC = [
        /* 0 Felucca   */ 8,    // Britain1 default
        /* 1 Trammel   */ 8,
        /* 2 Ilshenar  */ 26,
        /* 3 Malas     */ 14,
        /* 4 Tokuno    */ 44,
        /* 5 TerMur    */ 58,
      ];
      const track = FACET_MUSIC[mapId | 0];
      if (Number.isFinite(track)) this._onMusicRequest(track);
    });
    bus.on('profile:changed', ({ path }) => {
      if (path.startsWith('audio.')) this._refreshGains();
    });

    // Positional SFX hook — content scripts emit `audio:sfx-at` with
    // `{ id, x, y, map }`; we attenuate by distance from the player so
    // a faraway forge clang is quieter than one next to you.
    bus.on('audio:sfx-at', ({ id, x, y, map }) => this.playAt(id, x, y, map));
    // Footstep SFX — mobile-renderer fires this on every step.
    bus.on('mob:footstep', ({ terrain, x, y, map }) => this._onFootstep(terrain, x, y, map));
    // Ambient loops — region-tracker emits when a player crosses into a
    // region with `ambientSound`. The hook fades between loops on switch.
    bus.on('atmosphere:ambient', ({ name }) => this._onAmbient(name));
    // Combat music swap — when the local player enters combat, fade to
    // a "combat" music slot; on combat end fade back to the region music.
    bus.on('combat:state', ({ inCombat }) => this._onCombatState(inCombat));
    // ClassicUO `GameActions.RequestWarMode` plays a random combat track
    // (38/39/40) on war-enter and stops it on war-exit, client-side.
    // We piggy-back on the same `_onCombatState` path so the war toggle
    // gets audible feedback parity even when no actual hits have flown
    // yet. User report 2026-05-19 "brakuje dźwięków przy zmianie
    // peace↔war".
    bus.on('player:warmode', ({ warMode }) => this._onCombatState(!!warMode));
    // Client audit #3 #9 — stop music + ambient on disconnect. Without
    // this the britain theme kept playing through LoginScene after a
    // server kick and the stale audio refs leaked into the next session.
    bus.on('net:close', () => {
      try { this._stopMusic?.(); } catch { /* ignore */ }
      try { this._onAmbient?.(null); } catch { /* ignore */ }
    });
    // Window-level "first user gesture" resume — Chrome/Safari refuse
    // to start an AudioContext until the user has interacted with the
    // page. We hook the very first pointerdown/keydown to kick the
    // context out of 'suspended', then unsubscribe so we don't pay
    // the per-event cost forever.
    if (typeof window !== 'undefined') {
      const kick = () => {
        this._ensureInitialized().then(() => {
          if (this.ctx?.state === 'suspended') this.ctx.resume();
        });
        window.removeEventListener('pointerdown', kick);
        window.removeEventListener('keydown', kick);
      };
      window.addEventListener('pointerdown', kick, { once: false, passive: true });
      window.addEventListener('keydown', kick, { once: false, passive: true });
      // Mute / unmute when the tab loses focus. Without this the
      // music + footsteps + region ambience kept blasting in the
      // background while the user was on a different tab. Suspend
      // the AudioContext outright (cheaper than a gain ramp) and
      // pause any active <audio> music element.
      document.addEventListener('visibilitychange', () => {
        if (!this.ctx) return;
        try {
          if (document.hidden) {
            this.ctx.suspend?.();
            this._musicEl?.pause?.();
            // Client audit #4 E1 — also pause the region ambient loop
            // so cave / cathedral hum doesn't keep playing while the
            // tab is hidden.
            this._ambientEl?.pause?.();
          } else {
            this.ctx.resume?.();
            if (this._musicEl && !this._musicEl.ended) {
              this._musicEl.play?.().catch(() => { /* gesture lost */ });
            }
            if (this._ambientEl && !this._ambientEl.ended) {
              this._ambientEl.play?.().catch(() => { /* gesture lost */ });
            }
          }
        } catch { /* advisory */ }
      });
    }
  }

  /** Lazy AudioContext + manifest fetch. Calls on first user gesture. */
  async _ensureInitialized() {
    if (this._initialized) return;
    this._initialized = true;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this._master = this.ctx.createGain();
      this._sfx    = this.ctx.createGain();
      this._music  = this.ctx.createGain();
      // Procedural reverb send — the SFX bus splits into a dry path
      // (full volume) and a wet path that runs through a ConvolverNode
      // whose impulse response is synthesised at runtime (no IR mp3
      // files needed). Wet level defaults to 0; `setReverbForRegion`
      // dials it up when the player walks into a cave / cathedral.
      try {
        this._convolver = this.ctx.createConvolver();
        this._convolver.buffer = _buildSyntheticIR(this.ctx, /* duration */ 1.5, /* decay */ 2.5);
        this._wet = this.ctx.createGain();
        this._wet.gain.value = 0;
        this._sfx.connect(this._wet);
        this._wet.connect(this._convolver);
        this._convolver.connect(this._master);
      } catch { /* convolver unsupported (older Safari) — dry only */ }
      this._sfx.connect(this._master);
      this._music.connect(this._master);
      this._master.connect(this.ctx.destination);
      this._refreshGains();
    } catch (e) {
      console.warn('[audio] AudioContext init failed', e);
      return;
    }
    try {
      this._index = await fetch(`${BASE}/sounds.json`).then((r) => r.json());
    } catch {
      console.warn('[audio] sounds.json missing — sound playback disabled');
    }
    try {
      this._musicIndex = await fetch(`${BASE}/music.json`).then((r) => r.json());
    } catch {
      // Fallback: shipped placeholder manifest. Lets the engine
      // resolve track names for log + UI even when the extracted
      // music.json from the canonical extractor isn't present.
      try {
        const placeholder = await fetch('/sound/manifest.json').then((r) => r.json());
        if (placeholder?.music) {
          // Convert manifest.json shape (id keys → {name,file}) to
          // the music.json shape we expect (entries[id] = {file}).
          const entries = {};
          for (const [id, e] of Object.entries(placeholder.music)) {
            entries[id] = { file: e.file, name: e.name };
          }
          this._musicIndex = { entries };
        } else {
          console.warn('[audio] music.json + manifest.json both missing — music playback disabled');
        }
      } catch {
        console.warn('[audio] music.json missing — music playback disabled');
      }
    }
  }

  _refreshGains() {
    if (!this._master) return;
    this._master.gain.value = profile.get('audio.master') ?? 0.6;
    this._sfx   .gain.value = profile.get('audio.sfx')    ?? 0.7;
    this._music .gain.value = profile.get('audio.music')  ?? 0.4;
    if (this._musicEl) {
      this._musicEl.volume = (profile.get('audio.master') ?? 0.6)
                           * (profile.get('audio.music')  ?? 0.4);
    }
    // Client audit #6 #7 — also live-update the ambient loop volume.
    // Was static after spawn, so the slider only took effect on next
    // region cross.
    if (this._ambientEl) {
      this._ambientEl.volume = (profile.get('audio.master')  ?? 0.6)
                             * (profile.get('audio.ambient') ?? 0.3);
    }
  }

  /** Range-fetch + decode a sound by id, caching the AudioBuffer.
   *  Returns the buffer or `null` (missing meta / fetch error / decode
   *  unrecoverable). Failures are pinned with a `null` sentinel so we
   *  don't re-fetch + re-decode on every retry.
   *
   *  UO ships sounds as raw 16-bit PCM mono @ 22 050 Hz, NOT a standard
   *  RIFF/WAVE container — `decodeAudioData` rejects them. We build the
   *  AudioBuffer ourselves from the int16 samples. */
  async _loadBuffer(id) {
    let buffer = this._buffers.get(id);
    if (buffer === null) return null;
    if (buffer) return buffer;
    const meta = this._index?.entries?.[id];
    if (!meta) return null;
    const res = await fetch(`${BASE}/sounds.bin`, {
      headers: { Range: `bytes=${meta.offset}-${meta.offset + meta.size - 1}` },
    });
    // Client audit #4 E2 — transient HTTP error (503, brief offline)
    // used to fall through to the cache-poison `set(id, null)` below
    // because the wrapping `try` includes decode only — so the network
    // blip was silent-forever for that SFX. Don't cache on fetch fail.
    if (!res.ok && res.status !== 206) return null;
    const ab = await res.arrayBuffer();
    try {
      buffer = await this._decodeUoSound(ab);
    } catch (e) {
      console.warn(`[audio] decode failed for sound ${id} — silencing further attempts`, e?.message);
      this._buffers.set(id, null);
      return null;
    }
    this._buffers.set(id, buffer);
    return buffer;
  }

  /** Build an AudioBuffer from a UO sound payload. Try the browser's
   *  decoder first (covers the rare RIFF entries), fall back to raw
   *  16-bit PCM mono @ 22 050 Hz which is the standard MUL format. */
  async _decodeUoSound(ab) {
    // Probe for RIFF magic — only spend a `decodeAudioData` round-trip
    // when the payload actually claims to be a container.
    const head = new Uint8Array(ab, 0, Math.min(4, ab.byteLength));
    if (head.length === 4 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46) {
      // RIFF header present — let the browser decode it.
      try { return await this.ctx.decodeAudioData(ab.slice(0)); }
      catch { /* fall through */ }
    }
    // Raw PCM: int16 LE, mono, 22050 Hz.
    const SAMPLE_RATE = 22050;
    const samples = ab.byteLength >>> 1;
    if (samples === 0) throw new Error('empty');
    const pcm = new Int16Array(ab, 0, samples);
    const buf = this.ctx.createBuffer(1, samples, SAMPLE_RATE);
    // Bug-hunt #6 client B#19: was a hot per-sample JS loop on the main
    // thread; replace with Float32Array.from + native copyToChannel so
    // the conversion happens in V8/C++. Same numeric result.
    const f32 = new Float32Array(samples);
    for (let i = 0; i < samples; i++) f32[i] = pcm[i] / 32768;
    buf.copyToChannel(f32, 0);
    return buf;
  }

  /** Play a SFX by id. Resolves once the buffer is decoded + scheduled.
   *  No-op if id isn't in the manifest. */
  async play(id, volume = 1) {
    await this._ensureInitialized();
    if (!this.ctx || !this._index) return;
    // Browsers create the AudioContext in 'suspended' state and a
    // user gesture is required to resume it. Spell casts fire from
    // server packets, not user input — the ctx may still be
    // suspended at this point. Try to resume; if the gesture
    // requirement isn't met yet, the resume() promise rejects and
    // the buffer.start() call below silently swallows.
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* gesture required */ }
    }
    const buffer = await this._loadBuffer(id);
    if (!buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const scalar = Math.max(0, Math.min(1, Number(volume) || 0));
    if (scalar < 0.999) {
      const gain = this.ctx.createGain();
      gain.gain.value = scalar;
      src.connect(gain);
      gain.connect(this._sfx);
    } else {
      src.connect(this._sfx);
    }
    src.start();
  }

  /**
   * Positional play: attenuate by Manhattan distance to the local player.
   * Beyond `maxRange` (18 tiles, matches UO's audible radius) the SFX
   * is dropped entirely. Optional `pan` from `[-1..+1]` based on the
   * relative X (left/right) so sounds offset on an iso map stereo-pan
   * the right way.
   */
  async playAt(id, sx, sy, sMap) {
    await this._ensureInitialized();
    if (!this.ctx || !this._index) return;
    // Resolve player position via the world singleton — kept lazy to
    // avoid a hard dependency on world here (audio-manager loads early).
    let px = sx, py = sy, pMap = sMap;
    // Bug-hunt #6 client B#13 — was `await import('../world/world.js')`
    // per positional SFX (footsteps, spells). Vite caches the module so
    // it's basically Promise.resolve, but the await still defers playback
    // by a microtask and produces audible cadence drift. Direct ref.
    const me = world?.player;
    if (me) { px = me.x; py = me.y; pMap = me.map ?? world.mapId; }
    const sourceMap = resolveSfxSourceMap(sMap, pMap);
    if (pMap !== sourceMap) return;          // wrong facet — never audible
    const dx = sx - px, dy = sy - py;
    const dist = Math.max(Math.abs(dx), Math.abs(dy));
    const MAX = 18;
    if (dist > MAX) return;
    // Dedup gate — CUO `IO/Audio/Sound.cs:121-126` rejects play when
    // `curTime < lastPlayedTime + Delay`. Without this a chain-lightning
    // / mass-spell volley spawns 30 concurrent BufferSources of the
    // same SFX, busting the Web Audio buffer pool and clipping the
    // master gain. Use a per-id timestamp Map; threshold = half the
    // sample's natural duration so distinct shots still layer.
    const now = performance.now();
    const last = this._lastPlayedAt.get(id);
    // Audit #40 client P2 #12 — CUO `IO/Audio/Sound.cs:121-126` reads
    // the per-clip `Delay` field from sound.def so spell sounds (1-3s)
    // get a longer dedup window than footsteps (~250ms). Was: flat
    // 60ms, which blocked nothing audible.
    const meta = this._sfxMeta?.get?.(id);
    const buffer = await this._loadBuffer(id);
    if (!buffer) return;
    const dedupMs = meta?.delayMs
      ?? Math.max(60, Math.floor((buffer.duration ?? 0.06) * 500));
    if (last && (now - last) < dedupMs) return;
    this._lastPlayedAt.set(id, now);
    // Inverse-curve attenuation matches CUO's `att = 1 / (1 + dist²)`
    // approximation — distant SFX falls off faster than the previous
    // linear curve, which made far-away footsteps unnaturally loud.
    const norm = dist / (MAX + 1);
    const att = (1 - norm) * (1 - norm);
    // Audit #34 P3 #10 — iso projection: screen-X = (worldX - worldY).
    // Was `pan = dx / 6` (world-X only), so a sound due south of player
    // (dx=0, dy=+) played centred even though screen-wise it sat to the
    // right. Use (dx − dy) so left/right pan matches what's on screen.
    const pan = Math.max(-1, Math.min(1, (dx - dy) / 8));

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const gain = this.ctx.createGain();
    gain.gain.value = att;
    let panner = null;
    try {
      panner = this.ctx.createStereoPanner();
      panner.pan.value = pan;
      src.connect(panner);
      panner.connect(gain);
    } catch {
      src.connect(gain);
    }
    gain.connect(this._sfx);
    src.start();
  }

  /** Footstep SFX dispatch. Maps terrain kind → sound id, then plays.
   *  CUO `Constants.cs::FOOTSTEPS` ships 24 entries; we cover the
   *  canonical ones below. Lava is silent (matches CUO — the lava
   *  ambient loop already covers the sizzle layer). When the audio
   *  config has footstepSfx=false we early-return so nothing plays. */
  _onFootstep(terrain, x, y, map) {
    if (!profile.get('audio.footstepSfx')) return;
    const FOOTSTEP_IDS = {
      grass:  0x012E, dirt: 0x012E, sand: 0x012E,
      stone:  0x0130, brick: 0x0130, marble: 0x0130,
      wood:   0x0124, snow:  0x0125,
      water:  0x0140, mud:   0x0140, swamp: 0x0140,
      cave:   0x0130, dungeon: 0x0130,
      // Lava + acid: intentionally silent — ambient handles it.
      lava:   0,      acid:   0,
      // Ice slip + carpet padded — finer-grained CUO entries.
      ice:    0x012F, carpet: 0x0127,
      // Tall grass + leaves rustle.
      tall:   0x012D, leaves: 0x012D,
      // Audit rev.4 P3 — full CUO terrain coverage. CUO's
      // `Constants.cs::FOOTSTEPS` lists ~24 entries; we extend with
      // the remaining surfaces we map in region-tracker.
      gravel: 0x0130, cobble: 0x0131, plank: 0x0124,
      tile:   0x0130, metal:  0x0131, parchment: 0x0127,
      bone:   0x0124, grate:  0x0131, glass: 0x0130,
      rope:   0x0124, garbage: 0x0140,
      // Audit rev.9 P3 #8 — extra CUO terrain entries (canon: 30 vs
      // our previous 26). Brick variants for paved roads, deepwater
      // for swimming, ash for desolate biomes, jungle leaves softer
      // than temperate, cobweb/web for ruins, hide/skin for fleshy
      // dungeon floors (yew tree, daemon temple).
      brick_road: 0x0130, deepwater: 0x0140, ash: 0x0125,
      jungle: 0x012D, web: 0x0124, hide: 0x0127,
      sandstone: 0x0130, mosaic: 0x0131,
    };
    const id = FOOTSTEP_IDS[terrain] ?? FOOTSTEP_IDS.stone;
    if (!id) return;
    this.playAt(id, x, y, map);
  }

  /** Ambient loop swap — fades between named ambient tracks. Audit #46
   *  P2 — region → music-id table (CUO `RegionMusic.cs`). When the
   *  region maps to a music id we route via `_onMusicRequest` so the
   *  existing crossfade pipeline handles the swap (and a missing track
   *  doesn't 404 silently). Free-form region names still fall back to
   *  `/ambient/<name>.mp3` for shard-specific overrides. */
  _onAmbient(name) {
    if (!name) {
      if (this._ambientEl) { try { this._ambientEl.pause(); } catch {} this._ambientEl = null; }
      this._ambientName = null;
      return;
    }
    if (name === this._ambientName) return;
    if (this._ambientEl) { try { this._ambientEl.pause(); } catch {} }
    // Music is authoritative from server 0x6D. Do not replace an authored
    // dungeon/town track merely because the local terrain heuristic says
    // "cave". A user override remains available for custom shards.
    const overrides = (() => { try { return JSON.parse(localStorage.getItem('uo.regionMusic') ?? '{}'); } catch { return {}; } })();
    const mid = overrides[name];
    if (mid != null) {
      this._ambientName = name;
      this._onMusicRequest(mid);
      return;
    }
    // Fall back to direct mp3 file lookup for shard-defined ambients.
    const url = `${BASE}/ambient/${encodeURIComponent(name)}.mp3`;
    const el = new Audio(url);
    el.loop = true;
    el.volume = (profile.get('audio.master') ?? 0.6) * (profile.get('audio.ambient') ?? 0.3);
    el.play().catch(() => { /* gesture-blocked or 404 */ });
    this._ambientEl = el;
    this._ambientName = name;
  }

  /** Combat music swap — fade to combat track when entering combat. */
  _onCombatState(inCombat) {
    if (!profile.get('audio.combatMusic')) return;
    // Combat track ids defined in MUSIC_NAME_TO_ID on the server side
    // (combat=38, combat2=39, combat3=40). ClassicUO `GameActions.cs`
    // picks at random per toggle: `(RandomHelper.GetValue(0,3) % 3) + 38`.
    // Pin once per active combat window so it doesn't strobe between
    // tracks across repeated combat:state pulses; reset on exit.
    if (inCombat) {
      if (this._preCombatMusicId == null) this._preCombatMusicId = this._musicId;
      if (this._combatTrackId == null) {
        this._combatTrackId = 38 + (Math.random() * 3) | 0;
      }
      this._onMusicRequest(this._combatTrackId);
    } else if (this._preCombatMusicId != null) {
      this._combatTrackId = null;
      // Audit #40 client P2 #13 — if combat started before any region
      // music was assigned, `_preCombatMusicId` was 0xFFFF (the stop
      // sentinel). Re-issuing it on combat-end killed all music until
      // the next region cross. Skip the restore in that case and let
      // ambient / region logic recompute the right track.
      if (this._preCombatMusicId !== 0xFFFF) {
        this._onMusicRequest(this._preCombatMusicId);
      }
      this._preCombatMusicId = null;
    }
  }

  _onMusicRequest(musicId) {
    // ServUO uses 0xFFFF to mean "stop music".
    if (musicId === 0xFFFF) {
      this._stopMusic();
      return;
    }
    if (this._musicId === musicId) return;
    this._ensureInitialized().then(() => this._playMusic(musicId));
  }

  _stopMusic() {
    if (this._musicEl) {
      // Soft fade-out over 800ms — symmetric with `_playMusic` fade-in
      // so the two tracks overlap evenly for a true crossfade (CUO
      // `MusicManager.cs` ships matched 800ms ramps). Detach before
      // the timer fires.
      const old = this._musicEl;
      const start = old.volume;
      const t0 = performance.now();
      const fade = () => {
        const t = (performance.now() - t0) / 800;
        if (t >= 1) { try { old.pause(); } catch { /* ignore */ } return; }
        try { old.volume = Math.max(0, start * (1 - t)); }
        catch { /* ignore */ }
        requestAnimationFrame(fade);
      };
      try { fade(); } catch { try { old.pause(); } catch { /* ignore */ } }
      this._musicEl = null;
    }
    this._musicId = 0xFFFF;
  }

  _playMusic(musicId) {
    if (!this._musicIndex) return;
    const meta = this._musicIndex.entries?.[musicId];
    if (!meta) return;
    // Cross-fade: start the new track BEFORE stopping the old one and
    // ramp its volume from 0 → target while _stopMusic fades the
    // outgoing in parallel. CUO's MusicManager does the same "fade
    // both" overlap on track swap; the previous serial stop-then-start
    // left a 400 ms silence gap on every region transition.
    this._stopMusic();
    const el = new Audio(`${BASE}/music/${encodeURIComponent(meta.file)}`);
    // Audit #31 P2 #7 — CUO `AudioManager.PlayMusic(id, loop)` honors the
    // `loop` column from `Music/Digital/Config.txt`. Was hardcoded `true`
    // → one-shot stings (death id=4, victory fanfare, intro) replayed
    // forever instead of stopping at end-of-clip. The extractor already
    // populates `meta.loop`; we just need to read it.
    el.loop = meta.loop !== false;
    if (!el.loop) {
      el.addEventListener('ended', () => {
        if (this._musicEl === el) { this._musicEl = null; this._musicId = 0xFFFF; }
      });
    }
    const target = (profile.get('audio.master') ?? 0.6) * (profile.get('audio.music') ?? 0.4);
    el.volume = 0;
    el.preload = 'auto';
    el.play().catch((e) => {
      console.debug(`[audio] music ${meta.file} deferred (autoplay): ${e.message}`);
    });
    this._musicEl = el;
    this._musicId = musicId;
    const t0 = performance.now();
    const fadeIn = () => {
      if (this._musicEl !== el) return;     // a newer track started — bail
      const t = (performance.now() - t0) / 800;
      if (t >= 1) { try { el.volume = target; } catch { /* ignore */ } return; }
      try { el.volume = target * t; } catch { /* ignore */ }
      requestAnimationFrame(fadeIn);
    };
    fadeIn();
  }
}

/** Region → (wet level 0..1, decay multiplier) reverb presets.
 *  audio-manager subscribes to `region:enter` events and looks the
 *  region name up here. Anything not listed gets dry sound. */
const REVERB_PRESETS = {
  cave:        { wet: 0.45, decay: 3.5 },
  dungeon:     { wet: 0.42, decay: 4.0 },
  cathedral:   { wet: 0.55, decay: 5.0 },
  shrine:      { wet: 0.30, decay: 2.5 },
  underwater:  { wet: 0.60, decay: 3.0 },
};

/** Build a synthetic exponential-decay impulse response. Takes the
 *  shape of a brief noise burst that fades to silence over `duration`
 *  seconds — generic "small reverb" that's good enough for any
 *  enclosed space. ServUO doesn't ship per-region IR data so we
 *  generate at runtime; ConvolverNode treats this exactly the same
 *  as a recorded impulse. */
function _buildSyntheticIR(ctx, duration = 1.5, decay = 2.5) {
  const sampleRate = ctx.sampleRate;
  const length = Math.floor(sampleRate * duration);
  const ir = ctx.createBuffer(2, length, sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      // Random noise × exponential envelope.
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return ir;
}

export const audio = new AudioManager();

// Region → reverb wiring. Bus event from region tracker carries the
// region's `kind` string ('cave' / 'cathedral' / etc).
import { bus as _bus } from '../core/event-bus.js';
_bus.on('region:enter', ({ kind }) => {
  const preset = REVERB_PRESETS[String(kind || '').toLowerCase()];
  audio._setReverb?.(preset);
});

// Inject the setter on the singleton — keeps the prototype clean while
// still giving the bus listener access without re-exporting internals.
AudioManager.prototype._setReverb = function _setReverb(preset) {
  if (!this._wet) return;
  if (!preset) {
    try { this._wet.gain.setTargetAtTime(0, this.ctx.currentTime, 0.4); } catch { /* ignore */ }
    return;
  }
  try {
    // 400 ms cross-fade so wet level changes don't pop.
    this._wet.gain.setTargetAtTime(preset.wet, this.ctx.currentTime, 0.4);
    // Rebuild IR if decay differs materially from current setting.
    if (Math.abs((this._irDecay ?? 2.5) - preset.decay) > 0.5) {
      this._convolver.buffer = _buildSyntheticIR(this.ctx, 1.5, preset.decay);
      this._irDecay = preset.decay;
    }
  } catch { /* advisory */ }
};
