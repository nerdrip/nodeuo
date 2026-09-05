// LoginScene — port of ClassicUO `Game/Scenes/LoginScene.cs` flow.
//
// State machine (mirrors CUO `LoginSteps`):
//
//   Main             user types account/password, picks Connect
//   Connecting       socket open in flight (loading)
//   VerifyingAccount 0xEF + 0x80 sent, waiting for 0xA8 server list
//   ServerSelection  pick a shard from the list (we usually have 1)
//   LoginInToServer  0xA0/0x91/0xA9 round-trip (loading)
//   CharacterSelection  5 character slots; Play / Delete / New
//   CharacterCreation   4 sub-pages: Appearance → Profession → Trade → City
//   CharacterCreationDone   final 0xF8 sent, waiting for 0x1B
//   EnteringBritania        post-login warm-up (loading)
//   PopUpMessage     blocking error / disclaimer dialog
//
// Every step renders its own gump (DOM panel — Pixi parity is a Phase-7
// follow-up); the LoginBackdrop Pixi animation runs underneath. Step
// transitions go through `_setStep(s)` so the disposer always tears
// down the previous panel before the next one mounts.

import { Scene } from '../core/scene.js';
import { net } from '../net/net-client.js';
import { bus } from '../core/event-bus.js';
import { LoginBackdrop } from './login-backdrop.js';
import {
  buildLoginSeed, buildAccountLogin, buildPlayServer, buildGameLogin,
  buildPlayCharacter, buildClientVersion, buildSystemInfo,
  buildCreateCharacter, buildDeleteCharacter, buildPing,
} from '../net/outgoing.js';
import { assets } from '../assets/asset-manager.js';
import { world } from '../world/world.js';
import {
  ADVANCED_PROFESSION_ID, CLOTHING_HUES, CREATE_SKILL_COUNT, CREATE_SKILL_TOTALS, CREATE_STAT_TOTAL,
  ELF_SKIN_VALUES, MAX_CHAR_SLOTS, PROFESSIONS, _loadCustomProfessions, creationBeardStyles, creationHairHues,
  creationHairStyles, creationSkinHues, creationSkillOptionsForRace, normalizeCreationAppearance,
  normalizeCreationSkills, validateCreationName,
} from './login-character-creation.js';

const LS_PREFIX = 'uo.login.';
// Terrain priming is an optional visual optimization. It must never hold the
// login state machine indefinitely when a range request or texture decode is
// slow on a cold disk/browser cache.
const INITIAL_TERRAIN_WARMUP_BUDGET_MS = 4_000;
let loginProfileCache;

// Login only needs four scalar preferences. Importing the full in-game
// ProfileManager here pulled its large defaults, layout migration and gump
// state machinery into the cold login graph. Read the same persisted global
// document directly and let ProfileManager perform its normal full migration
// when the world bundle is prepared.
function loginProfileSetting(path, fallback) {
  if (loginProfileCache === undefined) {
    try { loginProfileCache = JSON.parse(localStorage.getItem('uo.profile') || '{}'); }
    catch { loginProfileCache = {}; }
  }
  let value = loginProfileCache;
  for (const part of String(path).split('.')) value = value?.[part];
  return value ?? fallback;
}

/** CUO `LoginSteps` enum. */
export const LoginSteps = Object.freeze({
  Main:                  'Main',
  Connecting:            'Connecting',
  Reconnecting:          'Reconnecting',
  VerifyingAccount:      'VerifyingAccount',
  ServerSelection:       'ServerSelection',
  LoginInToServer:       'LoginInToServer',
  CharacterSelection:    'CharacterSelection',
  EnteringBritania:      'EnteringBritania',
  CharacterCreation:     'CharacterCreation',
  CharacterCreationDone: 'CharacterCreationDone',
  PopUpMessage:          'PopUpMessage',
});


export class LoginScene extends Scene {
  constructor(gc) {
    super(gc);
    this._panel = null;
    this._unsubs = [];
    // _step starts as null — the first `_setStep(Main)` from load() must
    // run the renderer. Pre-seeding it to Main here would trip the
    // `if (this._step === step) return` guard and the form would never
    // mount (visible: only the LoginBackdrop sun glow, no DOM panel).
    this._step = null;
    this._popupOnDismiss = null;
    /** Account form state — survives across step transitions. */
    this._account = '';
    this._password = '';
    this._host = '127.0.0.1';
    this._port = 2593;
    /** 'ws' (direct to our shard) or 'bridge' (ws→tcp proxy to ServUO).
     *  Kept on the scene so `_onRelay` knows whether to do the canonical
     *  UO disconnect-and-reconnect dance — required for ServUO + the
     *  bridge, harmful for our same-socket WS path. */
    this._mode = 'ws';
    this._bridgeUrl = '';
    /** Server-list reply payload. */
    this._servers = [];
    this._serverIndex = 0;
    this._serverPingSeq = 0;
    this._serverPingSent = new Map();
    this._serverPingMs = null;
    this._serverPingTimer = null;
    /** 0x8C relay reply (kept so the resend at LoginInToServer reuses authKey). */
    this._relay = null;
    /** 0xA9 reply: 5 character slots + city list. */
    this._characters = [];
    this._cities = [];
    /** CharCreation working buffer — built page-by-page. */
    this._creation = null;
    this._creationPage = 0;
    this._previewImageCache = new Map();
    this._previewPaintToken = 0;
    this._reconnectTryCounter = 0;
    this._reconnectTimer = null;
    this._reconnectTicker = null;
    this._reconnectCancelled = false;
  }

  // --------------------------------------------------------------------------
  // Scene lifecycle

  async load() {
    // The login backdrop is deliberately low-motion and does not benefit from
    // driving Pixi at 60-240 Hz.  Keep the account flow responsive while
    // avoiding a permanently hot GPU on the screen where users can idle for
    // the longest time.  Preserve a stricter user cap and restore the exact
    // game cap when the world scene takes over.
    this._tickerMaxFpsBeforeLogin = this.gc.app.ticker.maxFPS || 0;
    if (!this._tickerMaxFpsBeforeLogin || this._tickerMaxFpsBeforeLogin > 30) {
      this.gc.app.ticker.maxFPS = 30;
    }

    // Re-read preferences after a logout; the Options gump may have changed
    // reconnect behaviour while the previous world scene was active.
    loginProfileCache = undefined;
    this._backdrop = new LoginBackdrop(this.gc.ui);
    this._mountBg();

    this._sub('login:rejected',     (info) => this._onRejected(info));
    this._sub('login:server-list',  (info) => this._onServerList(info));
    this._sub('login:relay',        (info) => this._onRelay(info));
    this._sub('login:char-list',    (info) => this._onCharList(info));
    this._sub('world:login-confirm',()     => this._onLoginConfirm());
    this._sub('world:bootstrap-progress', (info) => this._onWorldBootstrapProgress(info));
    this._sub('net:close',          ()     => this._onSocketClosed());
    this._sub('net:ping',           (info) => this._onServerPing(info));

    this._setStep(LoginSteps.Main);
    this.gc.setStatus('idle');
    // Login intro music — UO uses track 0 (oldult01 / "Stones") as the
    // ambient title-screen loop. Profile gate (`audio.loginMusic`)
    // lets the user disable it from Options. Browsers will not start
    // playback until the first user gesture (click on the panel),
    // which audio-manager handles via its 'pointerdown' kicker.
    try {
      // Defer one tick so the AudioContext init can fire from the
      // backdrop's hover handlers before we ask for music.
      setTimeout(() => bus.emit('atmosphere:music', { musicId: 0 }), 100);
    } catch { /* audio is best-effort */ }
  }

  unload() {
    this._stopLoadingHeartbeat();
    this._stopServerPingProbe();
    this._cancelReconnect({ returnToMain: false });
    for (const u of this._unsubs) u();
    this._unsubs.length = 0;
    this._panel?.remove(); this._panel = null;
    this._bg?.remove();    this._bg = null;
    this._backdrop?.destroy(); this._backdrop = null;
    if (this._tickerMaxFpsBeforeLogin != null) {
      this.gc.app.ticker.maxFPS = this._tickerMaxFpsBeforeLogin;
      this._tickerMaxFpsBeforeLogin = null;
    }
  }

  resize() { /* DOM panels centered via CSS */ }

  // --------------------------------------------------------------------------
  // State machine driver

  /** Swap to a new step — tears down the current panel and mounts the next. */
  _setStep(step, payload = null) {
    if (this._step === step) return;
    if (this._step === LoginSteps.ServerSelection && step !== LoginSteps.ServerSelection) {
      this._stopServerPingProbe();
    }
    this._stopLoadingHeartbeat();
    this._step = step;
    this._panel?.remove(); this._panel = null;
    switch (step) {
      case LoginSteps.Main:                  this._renderMain(); break;
      case LoginSteps.Connecting:            this._renderLoading('Connecting to server'); break;
      case LoginSteps.Reconnecting:          this._renderReconnect(payload); break;
      case LoginSteps.VerifyingAccount:      this._renderLoading('Verifying account'); break;
      case LoginSteps.ServerSelection:       this._renderServerSelection(); break;
      case LoginSteps.LoginInToServer:       this._renderLoading('Logging in to server'); break;
      case LoginSteps.CharacterSelection:    this._renderCharacterSelection(); break;
      case LoginSteps.CharacterCreation:     this._renderCharacterCreation(); break;
      case LoginSteps.CharacterCreationDone: this._renderLoading('Creating character'); break;
      case LoginSteps.EnteringBritania:      this._renderLoading('Entering Britannia'); break;
      case LoginSteps.PopUpMessage:          this._renderPopup(payload); break;
      default: break;
    }
    this.gc.setStatus(step.toLowerCase());
  }

  // --------------------------------------------------------------------------
  // Background — gradient + dragon silhouette behind every step

  _mountBg() {
    this._bg = document.createElement('div');
    this._bg.id = 'uo-login-bg';
    this._bg.className = 'uo-login-ambient';
    this._bg.innerHTML = `
      <div class="uo-login-orb"></div>
      <div class="uo-login-runes" aria-hidden="true">ᚠ · ᚢ · ᚦ · ᚨ · ᚱ · ᚲ</div>
      <div class="uo-login-horizon"></div>
    `;
    this._injectStyles();
    this.gc.domMount(this._bg);
  }

  /** Mount a fresh panel element (replaces any previous panel). */
  _mountPanel(html, opts = {}) {
    this._injectStyles();
    const wrap = document.createElement('div');
    wrap.innerHTML = html.trim();
    this._panel = wrap.firstElementChild;
    this._panel.classList.add('uo-panel', 'uo-login-surface');
    if (this._panel.dataset) this._panel.dataset.loginStep = this._step ?? '';
    else this._panel.setAttribute?.('data-login-step', this._step ?? '');
    Object.assign(this._panel.style, {
      position: 'fixed',
      top: '50%', left: '50%',
      transform: 'translate(-50%, -50%)',
      zIndex: 10,
    });
    if (opts.minWidth) this._panel.style.minWidth = opts.minWidth;
    if (opts.maxWidth) this._panel.style.maxWidth = opts.maxWidth;
    this.gc.domMount(this._panel);
    return this._panel;
  }

  // --------------------------------------------------------------------------
  // Step: Main — account login form

  _renderMain() {
    const remembered = {
      host: localStorage.getItem(LS_PREFIX + 'host')    ?? this._host,
      port: localStorage.getItem(LS_PREFIX + 'port')    ?? String(this._port),
      account: localStorage.getItem(LS_PREFIX + 'account') ?? this._account,
      mode: localStorage.getItem(LS_PREFIX + 'mode')    ?? 'ws',
      bridgeUrl: localStorage.getItem(LS_PREFIX + 'bridgeUrl') ?? 'ws://127.0.0.1:2595/bridge',
    };
    const modeBridge = remembered.mode === 'bridge';
    this._mountPanel(`
      <section class="uo-login-frame uo-login-frame--auth">
        <aside class="uo-login-aside">
          <div class="uo-brand-seal" aria-hidden="true"><span>UO</span></div>
          <div class="uo-eyebrow">PAPERDOLL · WEB CLIENT</div>
          <h1>Enter<br><em>Britannia</em></h1>
          <p>A living world of magic, trade and adventure. Your journey continues where you left it.</p>
          <div class="uo-aside-status"><i></i><span>Shard gateway ready</span></div>
        </aside>
        <main class="uo-login-content">
          <header class="uo-screen-heading">
            <div class="uo-eyebrow">ACCOUNT ACCESS</div>
            <h2>Welcome back</h2>
            <p>Sign in to continue to your character roster.</p>
          </header>
          <div class="uo-form-grid">
            <div class="uo-field uo-field--wide">
              <label for="m-account">Account name</label>
              <input id="m-account" type="text" value="${esc(remembered.account)}" maxlength="30" autocomplete="username" placeholder="Your account" />
            </div>
            <div class="uo-field uo-field--wide">
              <label for="m-password">Password</label>
              <input id="m-password" type="password" value="" maxlength="30" autocomplete="current-password" placeholder="Your password" />
            </div>
            <details class="uo-connection-settings uo-field--wide" ${modeBridge ? 'open' : ''}>
              <summary><span>Connection settings</span><small>${modeBridge ? 'ServUO bridge' : 'Direct WebSocket'}</small></summary>
              <div class="uo-settings-grid">
                <div class="uo-field uo-field--wide">
                  <label for="m-mode">Transport</label>
                  <select id="m-mode">
                    <option value="ws" ${modeBridge ? '' : 'selected'}>WebSocket · UO-Node server</option>
                    <option value="bridge" ${modeBridge ? 'selected' : ''}>TCP bridge · ServUO / RunUO / OSI</option>
                  </select>
                </div>
                <div class="uo-field uo-field--host">
                  <label for="m-host">Shard host</label>
                  <input id="m-host" type="text" value="${esc(remembered.host)}" />
                </div>
                <div class="uo-field uo-field--port">
                  <label for="m-port">Port</label>
                  <input id="m-port" type="text" inputmode="numeric" value="${esc(remembered.port)}" />
                </div>
                <div id="m-bridge-row" class="uo-field uo-field--wide" style="display:${modeBridge ? '' : 'none'}">
                  <label for="m-bridge">Bridge WebSocket URL</label>
                  <input id="m-bridge" type="text" value="${esc(remembered.bridgeUrl)}" />
                </div>
              </div>
            </details>
          </div>
          <div id="m-msg" class="uo-status-line" role="status"></div>
          <footer class="uo-actions">
            <button id="m-quit" class="uo-button uo-button--quiet">Quit</button>
            <button id="m-login" class="uo-button primary">Enter Britannia <span>→</span></button>
          </footer>
        </main>
      </section>
    `);
    // Transport selector toggles the bridge URL row.
    const modeSel = this._panel.querySelector('#m-mode');
    const bridgeRow = this._panel.querySelector('#m-bridge-row');
    modeSel?.addEventListener('change', () => {
      bridgeRow.style.display = modeSel.value === 'bridge' ? '' : 'none';
      const summary = this._panel.querySelector('.uo-connection-settings summary small');
      if (summary) summary.textContent = modeSel.value === 'bridge' ? 'ServUO bridge' : 'Direct WebSocket';
    });
    const accIn = this._panel.querySelector('#m-account');
    const pwIn = this._panel.querySelector('#m-password');
    pwIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._doConnect(); });
    accIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') pwIn.focus(); });
    this._panel.querySelector('#m-login').addEventListener('click', () => this._doConnect());
    this._panel.querySelector('#m-quit').addEventListener('click', () => {
      try { window.close(); } catch { /* navigation gated */ }
    });
    accIn.value ? pwIn.focus() : accIn.focus();
  }

  _setMainMsg(text) {
    const el = this._panel?.querySelector('#m-msg');
    if (el) el.textContent = text ?? '';
  }

  async _doConnect(cached = null) {
    if (!cached && !this._panel) return;
    const host = cached?.host ?? this._panel.querySelector('#m-host').value.trim();
    const port = Number(cached?.port ?? this._panel.querySelector('#m-port').value.trim());
    const account = cached?.account ?? this._panel.querySelector('#m-account').value.trim();
    const password = cached?.password ?? this._panel.querySelector('#m-password').value;
    const mode = cached?.mode ?? this._panel.querySelector('#m-mode')?.value ?? 'ws';
    const bridgeUrl = cached?.bridgeUrl ?? this._panel.querySelector('#m-bridge')?.value?.trim()
                   ?? 'ws://127.0.0.1:2595/bridge';
    if (!host || !port || !account) {
      this._setMainMsg('please fill server, port and account');
      return;
    }
    localStorage.setItem(LS_PREFIX + 'host', host);
    localStorage.setItem(LS_PREFIX + 'port', String(port));
    localStorage.setItem(LS_PREFIX + 'account', account);
    localStorage.setItem(LS_PREFIX + 'mode', mode);
    localStorage.setItem(LS_PREFIX + 'bridgeUrl', bridgeUrl);
    this._host = host; this._port = port;
    this._account = account; this._password = password;
    this._mode = mode;
    this._bridgeUrl = bridgeUrl;

    this._setStep(LoginSteps.Connecting);
    // Bridge mode: ws connection to the local bridge with `?target=host:port`
    // — the bridge opens a raw TCP socket to the real shard. WS mode talks
    // directly to our @uo/server on /game.
    const url = mode === 'bridge'
      ? `${bridgeUrl}${bridgeUrl.includes('?') ? '&' : '?'}target=${encodeURIComponent(host + ':' + port)}`
      : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${host}:${port}/game`;
    try {
      await net.connect(url);
    } catch (e) {
      if (cached && !this._reconnectCancelled) {
        this._scheduleReconnect({ immediateFailure: e.message });
        return;
      }
      this._showPopup(`Connection failed: ${e.message}`, () => this._setStep(LoginSteps.Main));
      return;
    }
    this._clearReconnectTimers();
    this._reconnectTryCounter = 0;
    this._reconnectCancelled = false;
    this._setStep(LoginSteps.VerifyingAccount);
    net.send(buildLoginSeed(0x7F000001));
    net.send(buildAccountLogin(account, password));
  }

  // --------------------------------------------------------------------------
  // Step: ServerSelection — pick a shard

  _onServerList(info) {
    this._servers = info?.servers?.length ? info.servers
      : [{ index: 0, name: 'Local Shard', percent: 0, timezone: 0, ip: 0 }];
    this._setStep(LoginSteps.ServerSelection);
  }

  _renderServerSelection() {
    const pingText = () => this._serverPingMs == null ? '...' : `${this._serverPingMs} ms`;
    const rows = this._servers.map((s, i) => `
      <div class="uo-server-row" data-idx="${i}" tabindex="0">
        <span class="uo-server-icon" aria-hidden="true">◆</span>
        <span class="uo-server-copy"><strong class="uo-server-name">${esc(s.name)}</strong><small>Online shard</small></span>
        <span class="uo-server-load"><b>${s.percent ?? 0}%</b><small>load</small></span>
        <span class="uo-server-ping"><b>${pingText()}</b><small>latency</small></span>
      </div>
    `).join('');
    this._mountPanel(`
      <section class="uo-login-frame uo-login-frame--selection">
        <aside class="uo-login-aside uo-login-aside--compact">
          <div class="uo-brand-seal uo-brand-seal--small" aria-hidden="true"><span>UO</span></div>
          <div class="uo-eyebrow">WORLD GATEWAY</div>
          <h1>Choose<br><em>your shard</em></h1>
          <p>Select the world you want to enter. Latency is measured live.</p>
        </aside>
        <main class="uo-login-content">
          <header class="uo-screen-heading">
            <div class="uo-eyebrow">STEP 2 · SERVER</div>
            <h2>Available worlds</h2>
            <p>${this._servers.length} ${this._servers.length === 1 ? 'shard is' : 'shards are'} ready.</p>
          </header>
          <div class="uo-server-list uo-choice-list">${rows}</div>
          <footer class="uo-actions">
            <button id="ss-back" class="uo-button uo-button--quiet">← Back</button>
            <button id="ss-next" class="uo-button primary">Connect <span>→</span></button>
          </footer>
        </main>
      </section>
    `);
    const rowsEl = [...this._panel.querySelectorAll('.uo-server-row')];
    const select = (i) => {
      this._serverIndex = i;     // Client audit #6 #2 — was hardcoded 0
      rowsEl.forEach((r, j) => r.classList.toggle('selected', j === i));
    };
    rowsEl.forEach((r, i) => {
      r.addEventListener('click', () => select(i));
      r.addEventListener('dblclick', () => { select(i); this._doSelectServer(); });
    });
    select(0);
    this._panel.querySelector('#ss-back').addEventListener('click', () => this._goBackToMain());
    this._panel.querySelector('#ss-next').addEventListener('click', () => this._doSelectServer());

    // Inject server-list styling once.
    this._injectStyles();
    this._startServerPingProbe();

    // Client audit #6 #2: removed auto-select timeout. Single-server
    // shards just need the user to click Connect (or double-click row);
    // the previous unconditional 30 ms timer ignored the choice and
    // always logged into server 0 for multi-server lists.
    if (this._servers.length === 1) {
      this._serverIndex = 0;
      setTimeout(() => this._doSelectServer(), 30);
    }
  }

  _doSelectServer() {
    if (this._step !== LoginSteps.ServerSelection) return;
    this._setStep(LoginSteps.LoginInToServer);
    net.send(buildPlayServer(this._serverIndex));
  }

  _startServerPingProbe() {
    this._stopServerPingProbe();
    const send = () => {
      if (this._step !== LoginSteps.ServerSelection) return;
      if (!net.ws || net.ws.readyState !== WebSocket.OPEN) return;
      const seq = (this._serverPingSeq = (this._serverPingSeq + 1) & 0xff);
      this._serverPingSent.set(seq, performance.now());
      while (this._serverPingSent.size > 8) {
        const first = this._serverPingSent.keys().next().value;
        this._serverPingSent.delete(first);
      }
      try { net.send(buildPing(seq)); } catch { /* socket may close mid-probe */ }
    };
    send();
    this._serverPingTimer = setInterval(send, 10_000);
  }

  _stopServerPingProbe() {
    if (this._serverPingTimer) {
      clearInterval(this._serverPingTimer);
      this._serverPingTimer = null;
    }
    this._serverPingSent.clear();
  }

  _onServerPing({ seq } = {}) {
    const sentAt = this._serverPingSent.get(seq & 0xff);
    if (!sentAt) return;
    this._serverPingSent.delete(seq & 0xff);
    this._serverPingMs = Math.max(0, Math.round(performance.now() - sentAt));
    if (this._step !== LoginSteps.ServerSelection || !this._panel) return;
    for (const el of this._panel.querySelectorAll('.uo-server-ping')) {
      const value = el.querySelector('b');
      if (value) value.textContent = `${this._serverPingMs} ms`;
      else el.textContent = `${this._serverPingMs} ms`;
    }
  }

  _onRelay(info) {
    this._relay = info;
    // ServUO (and OSI/RunUO) requires the client to DISCONNECT after
    // 0x8C Relay and reconnect to the game-server address embedded in
    // the relay payload. The new connection must begin with a 4-byte
    // bare authKey, then 0x91 GameLogin. Without the reconnect ServUO
    // re-runs Encryption.DetermineClientType on the next received
    // packet on the original socket, sees the wrong seed pattern and
    // logs "Encrypted Client Unsupported". Marcin's symptom exactly.
    //
    // Our same-port WS shard (our @uo/server) accepts the in-place
    // continuation just fine — keep the legacy behaviour there since
    // bouncing the WS would otherwise add a needless 200 ms reconnect
    // round-trip. Detection: `this._mode === 'bridge'`.
    if (this._mode === 'bridge') {
      this._relayReconnect(info);
      return;
    }
    net.send(buildClientVersion('7.0.95.0'));
    net.send(buildSystemInfo());
    net.send(buildGameLogin(info.authKey, this._account, this._password));
  }

  async _relayReconnect(info) {
    // Decode IP — ServUO writes the relay's listen IP as u32 BE in the
    // 0x8C payload. We point the bridge at THAT IP:port so it opens a
    // fresh TCP socket to the game server (which is the same ServUO
    // process on classic single-port setups, but a different host in
    // a multi-server shard). authKey rides as the FIRST 4 bytes of the
    // new socket (bridge's auto-prepend bows out when buf[4]==0x91).
    const ipStr = `${(info.ip >>> 24) & 0xff}.${(info.ip >>> 16) & 0xff}.${(info.ip >>> 8) & 0xff}.${info.ip & 0xff}`;
    const url = `${this._bridgeUrl}${this._bridgeUrl.includes('?') ? '&' : '?'}target=${encodeURIComponent(ipStr + ':' + info.port)}`;
    try {
      net.close();
      await net.connect(url);
    } catch (e) {
      this._showPopup(`Relay reconnect failed: ${e.message}`, () => this._setStep(LoginSteps.Main));
      return;
    }
    // Send authKey as a 4-byte bare seed FUSED with 0x91 GameLogin in
    // a SINGLE WS message. ServUO's Encryption check expects:
    //   bytes 0..3 = u32 BE seed (= authKey)
    //   byte  4    = 0x91 / 0x80 / 0xEF (a known login opcode)
    // If we send them as two separate ws.send() calls the bridge sees
    // each WS frame as a chunk. The bridge's bare-seed auto-prepend
    // would then mis-fire on the FIRST 4-byte chunk (it's only 4
    // bytes, the "buf.length >= 5 && buf[4] === 0x91" detection can't
    // run yet) and prepend ANOTHER seed — ServUO sees gibberish at
    // byte 4 of the new TCP stream and rejects with "Encrypted Client
    // Unsupported". One concat -> single frame -> bridge sees
    // buf[4]===0x91 and bows out of prepending.
    const game = buildGameLogin(info.authKey, this._account, this._password);
    const fused = new Uint8Array(4 + game.length);
    fused[0] = (info.authKey >>> 24) & 0xff;
    fused[1] = (info.authKey >>> 16) & 0xff;
    fused[2] = (info.authKey >>>  8) & 0xff;
    fused[3] =  info.authKey         & 0xff;
    fused.set(game, 4);
    net.send(fused);
    // Do NOT send ClientVersion (0xBD) / SystemInfo (0xA4) here. ServUO
    // marks 0xBD as `ingame=true` in PacketHandlers — at the character-
    // list phase state.Mobile is null and ServUO rejects with "Packet
    // (0xBD) Requires State Mobile" + disconnect (Marcin's symptom on
    // the bridge path). ClassicUO actually sends ClientVersion only in
    // RESPONSE to a server-side 0xBD request, never proactively here.
    // We deferred the version push to the in-game phase — see the
    // 0xBD-from-server handler that echoes our version back.
  }

  // --------------------------------------------------------------------------
  // Step: CharacterSelection — 5 slots + Play / Delete / New

  _onCharList(info) {
    this._characters = info.characters ?? [];
    this._cities = info.cities ?? [];
    // Audit #46 P2 — slot count derived from 0xA9 flags by incoming.js.
    // Falls back to MAX_CHAR_SLOTS (7) when the server didn't specify.
    this._slotCount = Math.min(MAX_CHAR_SLOTS, Math.max(1, info.slotCount | 0 || MAX_CHAR_SLOTS));
    while (this._characters.length < this._slotCount) {
      this._characters.push({ name: '', slot: this._characters.length });
    }
    this._setStep(LoginSteps.CharacterSelection);
  }

  _renderCharacterSelection() {
    const slotCount = this._slotCount | 0 || MAX_CHAR_SLOTS;
    const slots = this._characters.slice(0, slotCount).map((c, i) => {
      const empty = !c?.name || !c.name.trim();
      return `
        <div class="uo-char-slot ${empty ? 'empty' : ''}" data-slot="${i}" tabindex="0">
          <div class="uo-slot-num">${String(i + 1).padStart(2, '0')}</div>
          <div class="uo-slot-avatar" aria-hidden="true">${empty ? '+' : '♟'}</div>
          <div class="uo-slot-copy">
            <strong class="uo-slot-name">${empty ? 'Empty character slot' : esc(c.name)}</strong>
            <small>${empty ? 'Create a new adventurer' : 'Ready to enter Britannia'}</small>
          </div>
          <span class="uo-slot-chevron">›</span>
        </div>
      `;
    }).join('');
    this._mountPanel(`
      <section class="uo-login-frame uo-login-frame--roster">
        <aside class="uo-login-aside uo-login-aside--compact">
          <div class="uo-brand-seal uo-brand-seal--small" aria-hidden="true"><span>UO</span></div>
          <div class="uo-eyebrow">YOUR LEGACY</div>
          <h1>Return to<br><em>Britannia</em></h1>
          <p>Choose an adventurer or begin a new story.</p>
          <div class="uo-roster-count"><strong>${this._characters.filter((c) => c?.name?.trim()).length}</strong><span>active characters</span></div>
        </aside>
        <main class="uo-login-content">
          <header class="uo-screen-heading">
            <div class="uo-eyebrow">STEP 3 · CHARACTER</div>
            <h2>Character roster</h2>
            <p>Double-click a character to enter immediately.</p>
          </header>
          <div class="uo-char-list uo-choice-list">${slots}</div>
          <div id="cs-msg" class="uo-status-line" role="status"></div>
          <footer class="uo-actions uo-actions--roster">
            <button id="cs-back" class="uo-button uo-button--quiet">← Back</button>
            <button id="cs-delete" class="uo-button uo-button--danger">Delete</button>
            <button id="cs-new" class="uo-button">New character</button>
            <button id="cs-play" class="uo-button primary" disabled>Enter world <span>→</span></button>
          </footer>
        </main>
      </section>
    `);
    this._injectStyles();
    let chosen = -1;
    const slotsEl = [...this._panel.querySelectorAll('.uo-char-slot')];
    const playBtn = this._panel.querySelector('#cs-play');
    const delBtn  = this._panel.querySelector('#cs-delete');
    const refresh = () => {
      slotsEl.forEach((r, j) => r.classList.toggle('selected', j === chosen));
      const c = this._characters[chosen];
      const isEmpty = !c?.name || !c.name.trim();
      playBtn.disabled = chosen < 0 || isEmpty;
      delBtn.disabled  = chosen < 0 || isEmpty;
    };
    slotsEl.forEach((r, i) => {
      r.addEventListener('click', () => { chosen = i; refresh(); });
      r.addEventListener('dblclick', () => {
        chosen = i; refresh();
        const c = this._characters[chosen];
        if (c?.name?.trim()) this._doPlay();
        else this._beginCreation();
      });
    });
    refresh();
    this._panel.querySelector('#cs-back').addEventListener('click', () => this._goBackToMain());
    this._panel.querySelector('#cs-new').addEventListener('click', () => this._beginCreation());
    this._panel.querySelector('#cs-delete').addEventListener('click', () => {
      if (chosen < 0) return;
      const c = this._characters[chosen];
      if (!c?.name?.trim()) return;
      this._showPopup(`Delete "${c.name}"?\nThis cannot be undone.`,
        () => this._setStep(LoginSteps.CharacterSelection),
        () => {
          // Client audit #6 #1 — actually send 0x83 DeleteCharacter so
          // the server clears the slot. Was bus-only → character
          // reappeared on next char-list refresh.
          try { net.send(buildDeleteCharacter(chosen, this._password ?? '')); }
          catch (e) { console.warn('[login] delete send failed', e); }
          bus.emit('login:delete-character', { slot: chosen, name: c.name });
          this._characters[chosen] = { name: '', slot: chosen };
          this._setStep(LoginSteps.Main);   // remount → re-renders char list
          this._setStep(LoginSteps.CharacterSelection);
        });
    });
    playBtn.addEventListener('click', () => { if (chosen >= 0) { this._chosenSlot = chosen; this._doPlay(); } });
  }

  _doPlay() {
    const slot = this._chosenSlot ?? 0;
    const c = this._characters[slot];
    // Diagnostic — surfaces the (slot, name) we're about to send so a
    // server-side "Invalid Character Selection" error is traceable
    // back to the wire payload without packet captures. Names dump
    // includes every slot ServUO advertised in 0xA9 so we can tell
    // whether the clicked index lines up.
    if (net?.tracePackets || import.meta?.env?.DEV) {
      const allNames = (this._characters ?? [])
        .map((cc, i) => `${i}:${cc?.name?.trim() || '—'}`).join(' ');
      console.log(`[login] PlayCharacter slot=${slot} name='${c?.name ?? ''}' | char list: ${allNames}`);
    }
    this._setStep(LoginSteps.EnteringBritania);
    void this._prepareWorld();
    net.send(buildPlayCharacter(c?.name ?? '', slot));
  }

  // --------------------------------------------------------------------------
  // Step: CharacterCreation — 4 sub-pages

  _beginCreation() {
    void assets.initCharacterCreation?.();
    this._creation = {
      name: '',
      sex: 0, race: 0,
      profession: 1, skipTrade: true,
      str: 45, dex: 35, int: 10,
      skills: normalizeCreationSkills(PROFESSIONS[0].skills),
      skinHue: creationSkinHues(0)[2].hue,
      hairId: creationHairStyles(0, 0)[1].id,
      hairHue: creationHairHues(0)[1].hue,
      beardId: 0,
      beardHue: creationHairHues(0)[1].hue,
      shirtHue: 0,
      pantsHue: 0,
      city: this._cities?.[0]?.index ?? 0,
      slot: this._characters.findIndex((c) => !c?.name?.trim()),
    };
    if (this._creation.slot < 0) this._creation.slot = 0;
    this._creationPage = 0;
    this._setStep(LoginSteps.CharacterCreation);
  }

  _renderCharacterCreation() {
    // Audit #46 P2 — CUO canonical char-create order is:
    //   0 = Appearance → 1 = Profession → 2 = Trade → 3 = City
    // (per `CharCreationGump.cs:27,160,174`). Was Profession-first
    // which forced the user to pick a class before knowing how the
    // avatar looks. Profession step also pre-fills Trade stats so it
    // still has to come BEFORE Trade — only Appearance and Profession
    // swap.
    switch (this._creationPage) {
      case 0: this._renderCcAppearance(); break;
      case 1: this._renderCcProfession(); break;
      case 2: this._renderCcTrade(); break;
      case 3: this._renderCcCity(); break;
    }
  }

  _creationHeader(page, title, subtitle) {
    const steps = ['Appearance', 'Profession', 'Skills', 'Starting city'];
    return `
      <header class="uo-creation-header">
        <div class="uo-creation-brand">
          <div class="uo-brand-seal uo-brand-seal--tiny" aria-hidden="true"><span>UO</span></div>
          <div><div class="uo-eyebrow">NEW CHARACTER</div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div>
        </div>
        <ol class="uo-creation-progress" aria-label="Character creation progress">
          ${steps.map((step, i) => `<li class="${i === page ? 'active' : ''} ${i < page ? 'done' : ''}"><span>${i < page ? '✓' : i + 1}</span><small>${step}</small></li>`).join('')}
        </ol>
      </header>
    `;
  }

  _renderCcProfession() {
    // Audit rev.4 P2 — merge custom shard professions from
    // `assets.professions` if present (Prof.txt extractor output).
    try {
      if (assets?.professions) _loadCustomProfessions(assets);
    } catch { /* noop */ }
    const profRows = PROFESSIONS.map((p) => `
      <div class="uo-prof-row" data-id="${p.id}" tabindex="0">
        <div class="uo-prof-mark" aria-hidden="true">${esc(p.name.slice(0, 1))}</div>
        <div class="uo-prof-copy"><div class="uo-prof-name">${esc(p.name)}</div><div class="uo-prof-desc">${esc(p.desc)}</div></div>
        <span class="uo-choice-check">✓</span>
      </div>
    `).join('');
    this._mountPanel(`
      <section class="uo-login-frame uo-login-frame--creation">
        ${this._creationHeader(1, 'Choose a profession', 'Start with a proven path or shape every skill yourself.')}
        <div class="uo-creation-content">
          <div class="uo-prof-list uo-choice-grid">${profRows}</div>
        </div>
        <footer class="uo-actions uo-creation-actions">
          <button id="cc-back" class="uo-button uo-button--quiet">← Appearance</button>
          <button id="cc-next" class="uo-button primary">Continue <span>→</span></button>
        </footer>
      </section>
    `);
    this._injectStyles();
    let chosen = this._creation.profession;
    const rows = [...this._panel.querySelectorAll('.uo-prof-row')];
    const refresh = () => rows.forEach((r) => r.classList.toggle('selected', +r.dataset.id === chosen));
    rows.forEach((r) => {
      r.addEventListener('click', () => { chosen = +r.dataset.id; refresh(); });
      r.addEventListener('dblclick', () => {
        chosen = +r.dataset.id;
        this._commitProfession(chosen);
        this._creationPage = this._creation.skipTrade ? 3 : 2;
        this._setStep(LoginSteps.Main); this._setStep(LoginSteps.CharacterCreation);
      });
    });
    refresh();
    // Audit #46 P2 — CUO order has Profession at page 1 (after Appearance).
    // Back returns to Appearance (page 0). Next advances to Trade (page 2).
    this._panel.querySelector('#cc-back').addEventListener('click', () => {
      this._creationPage = 0;
      this._setStep(LoginSteps.Main); this._setStep(LoginSteps.CharacterCreation);
    });
    this._panel.querySelector('#cc-next').addEventListener('click', () => {
      this._commitProfession(chosen);
      this._creationPage = this._creation.skipTrade ? 3 : 2;
      this._setStep(LoginSteps.Main); this._setStep(LoginSteps.CharacterCreation);
    });
  }

  _commitProfession(id) {
    const p = PROFESSIONS.find((x) => x.id === id) ?? PROFESSIONS[0];
    this._creation.profession = id;
    this._creation.str = p.str;
    this._creation.dex = p.dex;
    this._creation.int = p.int;
    this._creation.skills = normalizeCreationSkills(p.skills);
    this._creation.skipTrade = id !== ADVANCED_PROFESSION_ID;
  }

  /** Audit #46 P2 — live paperdoll preview during Appearance step.
   *  Renders body / hair / beard sprites from the extracted gump atlas
   *  PNGs (page + xy frame). Updates whenever a select changes. No
   *  Pixi dependency — vanilla DOM divs with `background-image` +
   *  `background-position` for sprite-sheet positioning.
   *
   *  Hue tinting via CSS filter (multiply-blend approximation). The
   *  full UO hue palette LUT is not used here — instead we map each
   *  preset hue to its perceptual RGB and apply via CSS variables.
   *  The preview is "accurate enough" for the user to compare styles;
   *  the in-world sprite uses the real palette downstream. */
  async _renderCcPreview(target) {
    if (!target) return;
    await assets.initCharacterCreation?.();
    if (!target.isConnected) return;
    const c = this._creation;
    const isFemale = c.sex === 1;
    const bodyGumpId = isFemale ? 0x000D : 0x000C;
    // Look up hair / beard paperdoll gump ids via tiledata animId +
    // 50000/60000 (matches PaperdollGump.resolveEquipGumpId).
    const hairGump = this._hairPaperdollId(c.hairId, isFemale);
    const beardGump = (!isFemale && c.beardId) ? this._hairPaperdollId(c.beardId, false) : 0;
    // Default shirt / pants gumps (CUO `Game/Data/Layer.cs` shirt=21
    // pants=22 — paperdoll uses 0x1518 shirt male / 0x1517 female,
    // 0x1539 pants). The preview shows these always-on so the user
    // sees colour changes.
    const shirtGump = this._itemPaperdollId(isFemale ? 0x1518 : 0x1517, isFemale);
    const pantsGump = this._itemPaperdollId(0x1539, isFemale);
    // Look up tile frame for each.
    const atlas = assets?.gumpAtlas ?? ((typeof globalThis !== 'undefined') && globalThis.__assets?.gumpAtlas);
    const tiles = atlas?.tiles;
    const lookup = (gid) => (tiles?.[gid] ?? null);
    const BASE = ((typeof window !== 'undefined') && window.__assetsBase) || '/assets';
    const skinRgb  = this._paletteHueRgb(c.skinHue);
    const hairRgb  = this._paletteHueRgb(c.hairHue);
    const shirtRgb = this._paletteHueRgb(c.shirtHue);
    const pantsRgb = this._paletteHueRgb(c.pantsHue);
    const token = ++this._previewPaintToken;
    target.innerHTML = `
      <div class="uo-preview-frame">
        <div class="uo-preview-halo"></div>
        <canvas class="uo-preview-canvas" width="260" height="237" aria-label="Live character preview"></canvas>
        <div class="uo-preview-ground"></div>
      </div>
      <div class="uo-preview-caption"><i></i> Live paperdoll preview</div>
    `;
    const canvas = target.querySelector('.uo-preview-canvas');
    const ctx = canvas?.getContext?.('2d', { willReadFrequently: true });
    if (!ctx) return;
    const loadPage = (page) => {
      if (this._previewImageCache.has(page)) return this._previewImageCache.get(page);
      const promise = new Promise((resolve, reject) => {
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = `${BASE}/gump-atlas-${String(page).padStart(3, '0')}.png`;
      });
      this._previewImageCache.set(page, promise);
      promise.catch(() => this._previewImageCache.delete(page));
      return promise;
    };
    const paintLayer = async (gump, tint) => {
      const meta = lookup(gump);
      if (!meta) return;
      const img = await loadPage(meta.page);
      if (token !== this._previewPaintToken || !canvas.isConnected) return;
      const layerCanvas = document.createElement('canvas');
      layerCanvas.width = meta.w;
      layerCanvas.height = meta.h;
      const layerCtx = layerCanvas.getContext('2d', { willReadFrequently: true });
      layerCtx.drawImage(img, meta.u ?? meta.x ?? 0, meta.v ?? meta.y ?? 0, meta.w, meta.h, 0, 0, meta.w, meta.h);
      if (tint != null) {
        const pixels = layerCtx.getImageData(0, 0, meta.w, meta.h);
        const tr = (tint >> 16) & 0xff, tg = (tint >> 8) & 0xff, tb = tint & 0xff;
        for (let i = 0; i < pixels.data.length; i += 4) {
          if (!pixels.data[i + 3]) continue;
          const lum = pixels.data[i] * 0.299 + pixels.data[i + 1] * 0.587 + pixels.data[i + 2] * 0.114;
          const shade = 0.28 + (lum / 255) * 0.72;
          pixels.data[i] = Math.min(255, tr * shade);
          pixels.data[i + 1] = Math.min(255, tg * shade);
          pixels.data[i + 2] = Math.min(255, tb * shade);
        }
        layerCtx.putImageData(pixels, 0, 0);
      }
      ctx.drawImage(layerCanvas, ((canvas.width - meta.w) / 2) | 0, 0);
    };
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const [gump, tint] of [
      [bodyGumpId, skinRgb], [shirtGump, shirtRgb], [pantsGump, pantsRgb],
      [hairGump, hairRgb], [beardGump, hairRgb],
    ]) {
      if (gump) await paintLayer(gump, tint);
    }
  }

  /** Approximate UO hue index → CSS-friendly RGB for the live preview
   *  filter. We don't have the full hue.mul LUT in the login scene's
   *  loader scope, so we synthesize a perceptual colour from common
   *  preset hues by a small lookup table + fall back to a hash-based
   *  hue rotation. */
  _paletteHueRgb(hueIndex) {
    if (!hueIndex) return null;
    const TABLE = {
      // Skin (selected presets near 0x83EA..0x83FD)
      0x83EA: 0xF4E0BD, 0x83EB: 0xE0C49A, 0x83F0: 0xC6A57D, 0x83F2: 0xA68760,
      0x83F5: 0x8B6A48, 0x83F7: 0x6F5238, 0x83FA: 0x4E3825, 0x83FD: 0x2E1F12,
      // Hair palette (rough mapping)
      1102: 0x111111, 1108: 0x2B1A0F, 1144: 0x5A3A1A, 1147: 0x8B3A1A,
      1148: 0xD8B070, 1153: 0xF2E2A0, 1158: 0xC02020, 1163: 0x801010,
      1175: 0x808080, 1185: 0xC0C0C0, 1190: 0xF0F0F0,
    };
    if (TABLE[hueIndex] != null) return TABLE[hueIndex];
    const rawHue = hueIndex & 0x3fff;
    const mix = (a, b, t) => {
      const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
      const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
      const r = Math.round(ar + (br - ar) * t);
      const g = Math.round(ag + (bg - ag) * t);
      const bl = Math.round(ab + (bb - ab) * t);
      return (r << 16) | (g << 8) | bl;
    };
    if (rawHue >= 1002 && rawHue <= 1058) return mix(0xF4E0BD, 0x2E1F12, (rawHue - 1002) / 56);
    const elfTone = ELF_SKIN_VALUES.indexOf(rawHue);
    if (elfTone >= 0) return mix(0xE5D0A8, 0x9BB88E, (elfTone % 16) / 15);
    if (rawHue >= 1755 && rawHue <= 1779) return mix(0xC3B6A0, 0x74685F, (rawHue - 1755) / 24);
    // Fallback — perceptual derivation from the hue index modulo.
    const h = (hueIndex * 137) & 0xFFFFFF;
    return h;
  }

  _hairPaperdollId(itemId, isFemale) {
    return this._itemPaperdollId(itemId, isFemale);
  }

  _itemPaperdollId(itemId, isFemale) {
    if (!itemId) return 0;
    const ASSETS = assets ?? ((typeof globalThis !== 'undefined') && globalThis.__assets);
    const animId = ASSETS?.tiledata?.statics?.[itemId]?.animId | 0;
    const tiles = ASSETS?.gumpAtlas?.tiles;
    if (animId <= 0) return tiles?.[itemId] ? itemId : 0;
    const base = isFemale ? 60000 : 50000;
    const preferred = animId + base;
    const fallback = animId + 50000;
    if (tiles?.[preferred]) return preferred;
    if (tiles?.[fallback]) return fallback;
    return tiles?.[itemId] ? itemId : preferred;
  }

  _renderCcAppearance() {
    const c = normalizeCreationAppearance(this._creation);
    const skinOpts = creationSkinHues(c.race).map((h) => `<option value="${h.hue}" ${h.hue === c.skinHue ? 'selected' : ''}>${esc(h.label)}</option>`).join('');
    const hairOpts = creationHairHues(c.race).map((h) => `<option value="${h.hue}" ${h.hue === c.hairHue ? 'selected' : ''}>${esc(h.label)}</option>`).join('');
    const clothingOpts = CLOTHING_HUES.map((h) => `<option value="${h.hue}" ${h.hue === c.shirtHue ? 'selected' : ''}>${esc(h.label)}</option>`).join('');
    const pantsOpts = CLOTHING_HUES.map((h) => `<option value="${h.hue}" ${h.hue === c.pantsHue ? 'selected' : ''}>${esc(h.label)}</option>`).join('');
    const styleList = creationHairStyles(c.race, c.sex);
    const styleOpts = styleList.map((s) => `<option value="${s.id}" ${s.id === c.hairId ? 'selected' : ''}>${esc(s.label)}</option>`).join('');
    const beardList = creationBeardStyles(c.race, c.sex);
    const beardOpts = beardList.map((s) => `<option value="${s.id}" ${s.id === c.beardId ? 'selected' : ''}>${esc(s.label)}</option>`).join('');
    const showBeard = beardList.length > 1;
    const showPants = c.race !== 2;
    const hairStyleLabel = c.race === 2 ? 'Horn Style' : 'Hair Style';
    const hairColorLabel = c.race === 2 ? 'Horn Color' : 'Hair Color';
    const beardLabel = c.race === 2 ? 'Facial Horns' : 'Beard Style';
    this._mountPanel(`
      <section class="uo-login-frame uo-login-frame--creation">
        ${this._creationHeader(0, 'Shape your adventurer', 'Choose a name and define how your character appears in the world.')}
        <div class="uo-creation-content uo-appearance-layout">
          <div class="uo-appearance-form">
            <div class="uo-field uo-field--wide">
              <label for="cc-name">Character name</label>
              <input id="cc-name" type="text" maxlength="16" value="${esc(c.name)}" autocomplete="off" placeholder="2–16 characters" />
            </div>
            <div class="uo-segment-row">
              <fieldset class="uo-segmented">
                <legend>Body</legend>
                <label><input type="radio" name="cc-sex" value="0" ${c.sex===0?'checked':''}><span>Male</span></label>
                <label><input type="radio" name="cc-sex" value="1" ${c.sex===1?'checked':''}><span>Female</span></label>
              </fieldset>
              <div class="uo-field">
                <label for="cc-race">Race</label>
                <select id="cc-race">
                  <option value="0" ${c.race===0?'selected':''}>Human</option>
                  <option value="1" ${c.race===1?'selected':''}>Elf</option>
                  <option value="2" ${c.race===2?'selected':''}>Gargoyle</option>
                </select>
              </div>
            </div>
            <div class="uo-appearance-grid">
              <div class="uo-field"><label for="cc-skin">Skin tone</label><select id="cc-skin">${skinOpts}</select></div>
              <div class="uo-field"><label for="cc-hair-id">${hairStyleLabel}</label><select id="cc-hair-id">${styleOpts}</select></div>
              <div class="uo-field"><label for="cc-hair-hue">${hairColorLabel}</label><select id="cc-hair-hue">${hairOpts}</select></div>
              <div id="cc-beard-block" class="uo-field" ${showBeard?'':'style="display:none"'}><label for="cc-beard-id">${beardLabel}</label><select id="cc-beard-id">${beardOpts}</select></div>
              <div class="uo-field"><label for="cc-shirt-hue">Shirt color</label><select id="cc-shirt-hue">${clothingOpts}</select></div>
              <div id="cc-pants-block" class="uo-field" ${showPants?'':'style="display:none"'}><label for="cc-pants-hue">Pants color</label><select id="cc-pants-hue">${pantsOpts}</select></div>
            </div>
            <div id="cc-msg" class="uo-status-line" role="status"></div>
          </div>
          <aside id="cc-preview" class="uo-character-preview"></aside>
        </div>
        <footer class="uo-actions uo-creation-actions">
          <button id="cc-back" class="uo-button uo-button--quiet">← Character list</button>
          <button id="cc-next" class="uo-button primary">Choose profession <span>→</span></button>
        </footer>
      </section>
    `);
    this._injectStyles();
    // Live-preview refresh: read every dropdown into _creation then
    // re-render. Wire to change events on every select.
    const previewEl = this._panel.querySelector('#cc-preview');
    const readAppearanceForm = () => {
      const cc = this._creation;
      cc.name = this._panel.querySelector('#cc-name')?.value ?? cc.name;
      const checkedSex = this._panel.querySelector('input[name="cc-sex"]:checked');
      if (checkedSex) cc.sex = +checkedSex.value;
      cc.race = +this._panel.querySelector('#cc-race')?.value || 0;
      cc.skinHue = +this._panel.querySelector('#cc-skin')?.value || cc.skinHue;
      const hairIdValue = this._panel.querySelector('#cc-hair-id')?.value;
      if (hairIdValue != null) cc.hairId = +hairIdValue;
      cc.hairHue = +this._panel.querySelector('#cc-hair-hue')?.value || cc.hairHue;
      cc.shirtHue = +this._panel.querySelector('#cc-shirt-hue')?.value || 0;
      cc.pantsHue = +this._panel.querySelector('#cc-pants-hue')?.value || 0;
      cc.beardId = +this._panel.querySelector('#cc-beard-id')?.value || 0;
      normalizeCreationAppearance(cc);
    };
    const refreshPreview = () => {
      try {
        readAppearanceForm();
        this._renderCcPreview(previewEl);
      } catch (err) {
        console.warn('[login] character preview failed', err);
        if (previewEl) {
          previewEl.innerHTML = `
            <div class="uo-preview-frame"><div class="uo-preview-halo"></div><div class="uo-preview-ground"></div></div>
            <div class="uo-preview-caption">Preview temporarily unavailable</div>
          `;
        }
      }
    };
    ['cc-skin', 'cc-hair-id', 'cc-hair-hue', 'cc-beard-id', 'cc-shirt-hue', 'cc-pants-hue']
      .forEach((id) => this._panel.querySelector('#' + id)?.addEventListener('change', refreshPreview));
    this._panel.querySelector('#cc-race')?.addEventListener('change', (ev) => {
      readAppearanceForm();
      this._creation.race = +(ev.currentTarget?.value ?? 0);
      normalizeCreationAppearance(this._creation);
      this._setStep(LoginSteps.Main); this._setStep(LoginSteps.CharacterCreation);
    });
    const sexRadios = this._panel.querySelectorAll('input[name="cc-sex"]');
    sexRadios.forEach((r) => r.addEventListener('change', () => {
      readAppearanceForm();
      this._creation.sex = +r.value;
      normalizeCreationAppearance(this._creation);
      this._setStep(LoginSteps.Main); this._setStep(LoginSteps.CharacterCreation);
    }));
    // Audit #46 P2 — CUO order: Appearance is page 0, so back returns
    // to CharacterSelection (not to a prior creation page). Next
    // advances to Profession (page 1).
    this._panel.querySelector('#cc-back').addEventListener('click', () => {
      this._setStep(LoginSteps.CharacterSelection);
    });
    this._panel.querySelector('#cc-next').addEventListener('click', () => {
      const c2 = this._creation;
      const rawName = this._panel.querySelector('#cc-name').value;
      const nameError = validateCreationName(rawName);
      if (nameError) {
        this._panel.querySelector('#cc-msg').textContent = nameError;
        return;
      }
      c2.name = rawName.trim();
      c2.race = +this._panel.querySelector('#cc-race').value;
      c2.skinHue = +this._panel.querySelector('#cc-skin').value;
      c2.hairId = +this._panel.querySelector('#cc-hair-id').value;
      c2.hairHue = +this._panel.querySelector('#cc-hair-hue').value;
      // Audit #46 P2 — shirt + pants hues (CUO `CreateCharAppearanceGump`).
      c2.shirtHue = +this._panel.querySelector('#cc-shirt-hue')?.value || 0;
      c2.pantsHue = +this._panel.querySelector('#cc-pants-hue')?.value || 0;
      c2.beardId = +this._panel.querySelector('#cc-beard-id')?.value || 0;
      c2.beardHue = c2.hairHue;
      normalizeCreationAppearance(c2);
      this._creationPage = 1;       // → Profession
      this._setStep(LoginSteps.Main); this._setStep(LoginSteps.CharacterCreation);
    });
    refreshPreview();
  }

  _renderCcTrade() {
    const c = this._creation;
    const skillOptions = creationSkillOptionsForRace(c.race);
    const skillRow = (i) => {
      const s = c.skills[i] ?? { id: skillOptions[0][0], val: 0 };
      const selectedId = skillOptions.some(([id]) => id === s.id) ? s.id : skillOptions[0][0];
      const opts = skillOptions.map(([id, name]) => `<option value="${id}" ${id===selectedId?'selected':''}>${esc(name)}</option>`).join('');
      return `
        <div class="uo-skill-row">
          <span class="uo-skill-index">${i + 1}</span>
          <select class="cc-skill-id" data-i="${i}" aria-label="Skill ${i + 1}">${opts}</select>
          <input class="cc-skill-val" data-i="${i}" type="number" min="0" max="50" value="${s.val|0}" aria-label="Skill ${i + 1} value"/>
          <span class="uo-skill-percent">%</span>
        </div>
      `;
    };
    this._mountPanel(`
      <section class="uo-login-frame uo-login-frame--creation">
        ${this._creationHeader(2, 'Tune stats & skills', `Distribute ${CREATE_STAT_TOTAL} stat points and 100 or 120 skill points.`)}
        <div class="uo-creation-content uo-trade-layout">
          <section class="uo-build-card">
            <div class="uo-section-heading"><span>01</span><div><h3>Core attributes</h3><p>Strength, dexterity and intelligence must total ${CREATE_STAT_TOTAL}.</p></div></div>
            <div class="uo-stat-grid">
              <label><span>STR</span><small>Strength</small><input id="cc-str" type="number" min="10" max="60" value="${c.str|0}" /></label>
              <label><span>DEX</span><small>Dexterity</small><input id="cc-dex" type="number" min="10" max="60" value="${c.dex|0}" /></label>
              <label><span>INT</span><small>Intelligence</small><input id="cc-int" type="number" min="10" max="60" value="${c.int|0}" /></label>
            </div>
          </section>
          <section class="uo-build-card">
            <div class="uo-section-heading"><span>02</span><div><h3>Starting skills</h3><p>Choose four unique skills, up to 50 points each.</p></div></div>
            <div class="uo-skill-list">${Array.from({ length: CREATE_SKILL_COUNT }, (_, i) => skillRow(i)).join('')}</div>
          </section>
          <div id="cc-totals" class="uo-total-meter"></div>
          <div id="cc-msg" class="uo-status-line" role="status"></div>
        </div>
        <footer class="uo-actions uo-creation-actions">
          <button id="cc-back" class="uo-button uo-button--quiet">← Profession</button>
          <button id="cc-next" class="uo-button primary">Choose city <span>→</span></button>
        </footer>
      </section>
    `);
    const totals = this._panel.querySelector('#cc-totals');
    const refresh = () => {
      const s = +this._panel.querySelector('#cc-str').value | 0;
      const d = +this._panel.querySelector('#cc-dex').value | 0;
      const it = +this._panel.querySelector('#cc-int').value | 0;
      let sk = 0;
      this._panel.querySelectorAll('.cc-skill-val').forEach((el) => sk += (+el.value | 0));
      const statsOk = s + d + it === CREATE_STAT_TOTAL;
      const skillsOk = CREATE_SKILL_TOTALS.has(sk);
      totals.innerHTML = `<span class="${statsOk ? 'ok' : ''}">Stats <b>${s + d + it}</b> / ${CREATE_STAT_TOTAL}</span><span class="${skillsOk ? 'ok' : ''}">Skills <b>${sk}</b> / 100 or 120</span>`;
    };
    normalizeCreationAppearance(this._creation);
    this._panel.querySelectorAll('input[type="number"], .cc-skill-id').forEach((el) => el.addEventListener('input', refresh));
    this._panel.querySelectorAll('.cc-skill-id').forEach((el) => el.addEventListener('change', refresh));
    refresh();
    this._panel.querySelector('#cc-back').addEventListener('click', () => {
      this._creationPage = 1;
      this._setStep(LoginSteps.Main); this._setStep(LoginSteps.CharacterCreation);
    });
    this._panel.querySelector('#cc-next').addEventListener('click', () => {
      const c2 = this._creation;
      c2.str = clamp(+this._panel.querySelector('#cc-str').value, 10, 60);
      c2.dex = clamp(+this._panel.querySelector('#cc-dex').value, 10, 60);
      c2.int = clamp(+this._panel.querySelector('#cc-int').value, 10, 60);
      if (c2.str + c2.dex + c2.int !== CREATE_STAT_TOTAL) {
        this._panel.querySelector('#cc-msg').textContent = `Stats must total ${CREATE_STAT_TOTAL} (got ${c2.str + c2.dex + c2.int}).`;
        return;
      }
      const skills = [];
      const picked = new Set();
      let sum = 0;
      let duplicate = false;
      this._panel.querySelectorAll('.cc-skill-id').forEach((sel, i) => {
        const id = +sel.value;
        const val = clamp(+this._panel.querySelector(`.cc-skill-val[data-i="${i}"]`).value, 0, 50);
        if (picked.has(id)) duplicate = true;
        picked.add(id);
        sum += val;
        if (val > 0) skills.push({ id, val });
      });
      if (duplicate) {
        this._panel.querySelector('#cc-msg').textContent = 'Skill picks must be unique.';
        return;
      }
      if (!CREATE_SKILL_TOTALS.has(sum)) {
        this._panel.querySelector('#cc-msg').textContent = `Skill total must be 100 or 120 (got ${sum}).`;
        return;
      }
      c2.skills = skills;
      this._creationPage = 3;
      this._setStep(LoginSteps.Main); this._setStep(LoginSteps.CharacterCreation);
    });
  }

  _renderCcCity() {
    const c = this._creation;
    const cities = (this._cities && this._cities.length) ? this._cities :
      [{ index: 0, name: 'Britain', area: 'a faded map' }];
    // Audit #46 P2 — per-city lore blurb. CUO ships a paragraph per
    // city via the server's `0xA9::cities` payload (`description` /
    // `descTrue`). When the shard provides one we render it under the
    // area string; otherwise fall back to a generic line.
    const CITY_LORE = {
      Britain: 'The mercantile heart of Britannia, ruled by Lord British himself.',
      Trinsic: 'A walled city of paladins on Britannia\'s southern coast.',
      Yew: 'A wooded community famed for the Empath Abbey.',
      Moonglow: 'Centre of magery study on the island of Verity.',
      Skara: 'Skara Brae — village of rangers between river and bay.',
      Minoc: 'A mining town nestled in the northern mountains.',
      Vesper: 'Trading port at the mouth of the Tokuno Strait.',
      Magincia: 'Once-proud island city, rebuilt after the Daemon raid.',
      Jhelom: 'Warriors\' isle south of Cape of Heroes.',
      'New Haven': 'Modern starter town with training NPCs for every skill.',
      // Audit rev.9 P3 #3 — extra canonical cities the 0xA9 list may
      // include depending on the shard's expansion set.
      Cove:           'A small fishing village on the east coast of Britannia.',
      'Nujel\'m':     'Island gem of poets and royalty — the Justice shrine.',
      'Serpent\'s Hold': 'Stone fortress of the Britannian army on Verity Isle.',
      Wind:           'High-mountain mage colony, hidden behind Lord Wind\'s veil.',
      Buccaneer:      'A pirate refuge — Buccaneer\'s Den, off Trinsic\'s coast.',
      Delucia:        'Lost Lands trading outpost ringed by hostile fauna.',
      Papua:          'Ish Naka-Tan jungle port at the south of the Lost Lands.',
      Zento:          'Tokuno samurai academy on the Isle of Makoto.',
      'Royal City':   'The TerMur capital — gargoyle dynasty seat at the Stygian Abyss gate.',
      Heartwood:      'Elven village deep within the Twin Oaks woodland.',
    };
    const rows = cities.map((city, i) => {
      const blurb = city.description ?? city.descTrue ?? CITY_LORE[city.name] ?? '';
      return `
      <div class="uo-city-row" data-i="${i}" tabindex="0">
        <div class="uo-city-pin" aria-hidden="true">⌖</div>
        <div class="uo-city-copy">
          <div class="uo-city-name">${esc(city.name)}</div>
          <div class="uo-city-area">${esc(city.area ?? 'Britannia')}</div>
          <div class="uo-city-lore">${esc(blurb)}</div>
        </div>
        <span class="uo-choice-check">✓</span>
      </div>`;
    }).join('');
    this._mountPanel(`
      <section class="uo-login-frame uo-login-frame--creation">
        ${this._creationHeader(3, 'Choose a starting city', 'Select where your first chapter in Britannia begins.')}
        <div class="uo-creation-content">
          <div class="uo-city-list uo-city-grid">${rows}</div>
        </div>
        <footer class="uo-actions uo-creation-actions">
          <button id="cc-back" class="uo-button uo-button--quiet">← Previous step</button>
          <button id="cc-finish" class="uo-button primary">Create character <span>→</span></button>
        </footer>
      </section>
    `);
    this._injectStyles();
    let chosen = Math.max(0, cities.findIndex((cc) => cc.index === c.city));
    const rowsEl = [...this._panel.querySelectorAll('.uo-city-row')];
    const refresh = () => rowsEl.forEach((r, j) => r.classList.toggle('selected', j === chosen));
    rowsEl.forEach((r, i) => {
      r.addEventListener('click', () => { chosen = i; refresh(); });
      r.addEventListener('dblclick', () => { chosen = i; this._submitCreation(cities[chosen].index); });
    });
    refresh();
    this._panel.querySelector('#cc-back').addEventListener('click', () => {
      this._creationPage = c.skipTrade ? 1 : 2;
      this._setStep(LoginSteps.Main); this._setStep(LoginSteps.CharacterCreation);
    });
    this._panel.querySelector('#cc-finish').addEventListener('click', () => this._submitCreation(cities[chosen].index));
  }

  _submitCreation(cityIndex) {
    const c = this._creation;
    c.city = cityIndex;
    this._setStep(LoginSteps.CharacterCreationDone);
    void this._prepareWorld();
    net.send(buildCreateCharacter({
      name: c.name, sex: c.sex, race: c.race, profession: c.profession,
      str: c.str, dex: c.dex, int: c.int,
      skills: c.skills.map((s) => ({ id: s.id, value: s.val })),
      skinHue: c.skinHue, hairId: c.hairId, hairHue: c.hairHue,
      beardId: c.beardId, beardHue: c.beardHue,
      shirtHue: c.shirtHue | 0, pantsHue: c.pantsHue | 0,
      city: c.city, slot: c.slot,
    }));
  }

  // --------------------------------------------------------------------------
  // Step: Loading screens

  _renderLoading(label) {
    const initialProgress = ({
      [LoginSteps.Connecting]: 0.12,
      [LoginSteps.VerifyingAccount]: 0.32,
      [LoginSteps.LoginInToServer]: 0.54,
      [LoginSteps.CharacterCreationDone]: 0.58,
      [LoginSteps.EnteringBritania]: 0.08,
    })[this._step] ?? 0.1;
    const initialDetail = ({
      [LoginSteps.Connecting]: 'Opening a secure shard connection',
      [LoginSteps.VerifyingAccount]: 'Checking account credentials',
      [LoginSteps.LoginInToServer]: 'Requesting character roster',
      [LoginSteps.CharacterCreationDone]: 'Creating your character',
      [LoginSteps.EnteringBritania]: 'Preparing world resources',
    })[this._step] ?? 'Preparing the next stage';
    this._mountPanel(`
      <section class="uo-loading-card">
        <div class="uo-brand-seal uo-brand-seal--small" aria-hidden="true"><span>UO</span></div>
        <div class="uo-spinner"><i></i></div>
        <div class="uo-eyebrow">WORLD GATEWAY</div>
        <h2>${esc(label)}</h2>
        <p>Please wait while the next gate opens.</p>
        <div class="uo-loading-status">
          <span id="uo-loading-detail">${esc(initialDetail)}</span>
          <b id="uo-loading-percent">${Math.round(initialProgress * 100)}%</b>
        </div>
        <div class="uo-loading-track" id="uo-loading-track" role="progressbar"
             aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100"
             aria-valuenow="${Math.round(initialProgress * 100)}">
          <span id="uo-loading-progress"></span>
        </div>
        <div class="uo-loading-heartbeat" aria-live="polite">
          <i></i><span id="uo-loading-elapsed">Gateway active · 0s</span>
        </div>
      </section>
    `);
    this._injectStyles();
    this._setLoadingProgress(initialProgress, initialDetail);
    this._startLoadingHeartbeat();
  }

  _setLoadingProgress(progress, detail = null) {
    if (!this._panel?.classList?.contains('uo-loading-card') && !this._panel?.querySelector?.('#uo-loading-track')) return;
    const p = Math.max(0, Math.min(1, Number(progress) || 0));
    // Never visually move backwards when two parallel preload jobs report in
    // a different order. New loading panels reset `_loadingProgress` below.
    this._loadingProgress = Math.max(Number(this._loadingProgress) || 0, p);
    const pct = Math.round(this._loadingProgress * 100);
    const fill = this._panel.querySelector('#uo-loading-progress');
    const track = this._panel.querySelector('#uo-loading-track');
    const percent = this._panel.querySelector('#uo-loading-percent');
    const detailEl = this._panel.querySelector('#uo-loading-detail');
    if (fill) fill.style.setProperty('--uo-loading-progress', String(this._loadingProgress));
    if (track) track.setAttribute('aria-valuenow', String(pct));
    if (percent) percent.textContent = `${pct}%`;
    if (detail && detailEl) detailEl.textContent = String(detail);
  }

  _startLoadingHeartbeat() {
    if (this._loadingHeartbeat) clearInterval(this._loadingHeartbeat);
    this._loadingHeartbeat = null;
    this._loadingStartedAt = performance.now();
    this._loadingHeartbeat = setInterval(() => {
      const elapsed = Math.max(0, Math.floor((performance.now() - this._loadingStartedAt) / 1000));
      const node = this._panel?.querySelector?.('#uo-loading-elapsed');
      if (node) node.textContent = `Gateway active · ${elapsed}s`;
    }, 500);
  }

  _stopLoadingHeartbeat() {
    if (this._loadingHeartbeat) clearInterval(this._loadingHeartbeat);
    this._loadingHeartbeat = null;
    this._loadingStartedAt = 0;
    this._loadingProgress = 0;
  }

  _onWorldBootstrapProgress(info) {
    if (this._step !== LoginSteps.EnteringBritania) return;
    const p = Math.max(0, Math.min(1, Number(info?.progress) || 0));
    this._setLoadingProgress(0.1 + p * 0.56, info?.label || 'Preparing world resources');
  }

  // --------------------------------------------------------------------------
  // Step: Popup (errors, confirmations, disclaimer)

  _showPopup(message, onCancel = null, onOk = null) {
    this._popupOnDismiss = { onCancel, onOk };
    this._setStep(LoginSteps.PopUpMessage, message);
  }

  _renderPopup(message) {
    const hasOk = !!this._popupOnDismiss?.onOk;
    const hasCancel = !!this._popupOnDismiss?.onCancel;
    this._mountPanel(`
      <section class="uo-dialog-card">
        <div class="uo-dialog-icon">!</div>
        <div class="uo-eyebrow">NOTICE</div>
        <h2>One moment</h2>
        <div class="uo-dialog-message">${esc(message ?? '')}</div>
        <footer class="uo-actions">
          ${hasCancel ? '<button id="p-cancel" class="uo-button uo-button--quiet">Cancel</button>' : ''}
          <button id="p-ok" class="uo-button primary">${hasCancel && hasOk ? 'Confirm' : 'Continue'}</button>
        </footer>
      </section>
    `);
    if (hasCancel) {
      this._panel.querySelector('#p-cancel').addEventListener('click', () => {
        const cb = this._popupOnDismiss?.onCancel;
        this._popupOnDismiss = null;
        cb?.();
      });
    }
    this._panel.querySelector('#p-ok').addEventListener('click', () => {
      const cb = this._popupOnDismiss?.onOk ?? this._popupOnDismiss?.onCancel;
      this._popupOnDismiss = null;
      cb?.();
    });
  }

  // --------------------------------------------------------------------------
  // Bus event handlers

  _onRejected(info) {
    const reason = ({
      0: 'Invalid account or credentials.',
      1: 'Someone is using this account.',
      2: 'Your account has been blocked.',
      3: 'Bad password.',
      4: 'Idle for too long.',
      5: 'Bad communication.',
    })[info.reason | 0] ?? `Login rejected (code ${info.reason}).`;
    this._showPopup(reason, () => this._setStep(LoginSteps.Main));
  }

  _onSocketClosed() {
    if (this._step === LoginSteps.Main) return;
    if (this._step === LoginSteps.PopUpMessage || this._reconnectCancelled) return;
    const enabled = loginProfileSetting('login.autoReconnect', true) !== false;
    if (!enabled) {
      this._showPopup('Connection lost.', () => this._setStep(LoginSteps.Main));
      return;
    }
    this._scheduleReconnect();
  }

  _clearReconnectTimers() {
    clearTimeout(this._reconnectTimer);
    clearInterval(this._reconnectTicker);
    this._reconnectTimer = null;
    this._reconnectTicker = null;
  }

  _cancelReconnect({ returnToMain = true } = {}) {
    this._reconnectCancelled = true;
    this._clearReconnectTimers();
    this._reconnectTryCounter = 0;
    if (returnToMain && this._step !== LoginSteps.Main) this._setStep(LoginSteps.Main);
  }

  _scheduleReconnect({ immediateFailure = '' } = {}) {
    const intervalMs = (loginProfileSetting('login.reconnectIntervalMs', 5000) | 0) || 5000;
    const maxTries   = (loginProfileSetting('login.reconnectMaxTries', 12) | 0) || 12;
    this._reconnectTryCounter = (this._reconnectTryCounter | 0) + 1;
    if (this._reconnectTryCounter > maxTries) {
      this._clearReconnectTimers();
      this._reconnectTryCounter = 0;
      this._showPopup('Connection lost (max retries reached).', () => this._setStep(LoginSteps.Main));
      return;
    }
    this._reconnectCancelled = false;
    this._clearReconnectTimers();
    this._setStep(LoginSteps.Main);
    this._setStep(LoginSteps.Reconnecting, {
      attempt: this._reconnectTryCounter,
      maxTries,
      waitMs: intervalMs,
      error: immediateFailure,
    });
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      clearInterval(this._reconnectTicker);
      this._reconnectTicker = null;
      if (this._reconnectCancelled) return;
      this._doConnect({
        host: this._host,
        port: this._port,
        account: this._account,
        password: this._password,
        mode: this._mode,
        bridgeUrl: this._bridgeUrl,
      });
    }, intervalMs);
  }

  /** Audit #46 P2 — AutoLogin (CUO `LoginScene.cs:79-97`). When the
   *  profile flag is on AND we have a saved username + password, skip
   *  the Main panel and submit immediately on scene mount. Called once
   *  from _load() after the initial _setStep(Main). */
  _tryAutoLogin() {
    if (!loginProfileSetting('login.autoLogin', false)) return false;
    const acc = localStorage.getItem(LS_PREFIX + 'account');
    if (!acc) return false;
    // Wait one tick so the Main panel is fully mounted, then submit.
    setTimeout(() => { try { this._doConnect?.(); } catch { /* ignore */ } }, 80);
    return true;
  }

  async _onLoginConfirm() {
    // Keep the several-hundred-kilobyte world renderer out of the login and
    // character-creation payload. Vite now emits GameScene (and its renderer
    // graph) as a separate async chunk that is fetched only after the server
    // has accepted a character. This materially improves cold login without
    // changing the UO network flow.
    this._setLoadingProgress(0.68, 'Shard accepted · warming nearby terrain');
    const { GameScene } = await this._prepareWorld();
    try {
      const warmup = this._warmInitialTerrain().then(
        () => ({ completed: true }),
        (error) => ({ error }),
      );
      let timeoutId;
      const outcome = await Promise.race([
        warmup,
        new Promise((resolve) => {
          timeoutId = setTimeout(
            () => resolve({ timedOut: true }),
            INITIAL_TERRAIN_WARMUP_BUDGET_MS,
          );
        }),
      ]);
      clearTimeout(timeoutId);
      if (outcome.error) throw outcome.error;
      if (outcome.timedOut) {
        this._setLoadingProgress(0.98, 'Entering world · terrain continues streaming');
        console.warn(`[login] terrain warm-up exceeded ${INITIAL_TERRAIN_WARMUP_BUDGET_MS}ms; continuing in background`);
      }
    } catch (error) {
      // Streaming can recover inside GameScene, so a corrupt optional static
      // block must not strand the user on the gateway forever.
      console.warn('[login] initial terrain warm-up failed', error?.message ?? error);
    }
    this._setLoadingProgress(1, 'Britannia is ready');
    // Allow the completed bar to paint once before the DOM scene is swapped.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await this.gc.setScene(new GameScene(this.gc));
  }

  /** Warm the 5×5 chunk neighbourhood centred on the confirmed player.
   *  Range requests are coalesced by AssetManager, so this is normally five
   *  compact terrain/static reads rather than fifty individual HTTP calls.
   *  Land atlas pages are resolved before GameScene mounts, eliminating the
   *  large blue diamonds around the avatar on a cold cache. */
  async _warmInitialTerrain() {
    const p = world.player;
    const meta = assets.mapMeta;
    if (!p || !meta?.blocksWide || !meta?.blocksTall) return;
    const centerCx = Math.floor((p.x | 0) / 8);
    const centerCy = Math.floor((p.y | 0) / 8);
    const radius = 2;
    const coords = [];
    for (let cx = centerCx - radius; cx <= centerCx + radius; cx++) {
      for (let cy = centerCy - radius; cy <= centerCy + radius; cy++) {
        if (cx < 0 || cy < 0 || cx >= meta.blocksWide || cy >= meta.blocksTall) continue;
        coords.push([cx, cy]);
      }
    }
    if (!coords.length) return;

    let settled = 0;
    const ioTotal = coords.length * 2;
    const markIo = () => {
      settled++;
      this._setLoadingProgress(
        0.70 + 0.16 * (settled / ioTotal),
        `Streaming nearby world · ${settled}/${ioTotal}`,
      );
    };
    const ioJobs = [];
    for (const [cx, cy] of coords) {
      ioJobs.push(assets.fetchBlock(cx, cy, world.mapId).finally(markIo));
      ioJobs.push(assets.fetchStatics(cx, cy, world.mapId).finally(markIo));
    }
    await Promise.allSettled(ioJobs);

    // Prime only unique land graphics. A typical city neighbourhood uses a
    // few dozen IDs, all sharing a handful of atlas pages; statics continue
    // asynchronously after opaque terrain is present.
    const landIds = new Set();
    for (const [cx, cy] of coords) {
      for (let dy = 0; dy < 8; dy++) {
        for (let dx = 0; dx < 8; dx++) {
          const tile = assets.landAt(cx * 8 + dx, cy * 8 + dy, world.mapId);
          if (tile) landIds.add(tile.id | 0);
        }
      }
    }
    const ids = [...landIds];
    if (!ids.length) return;
    let texturesReady = 0;
    await Promise.allSettled(ids.map((id) => assets.landTexture(id).finally(() => {
      texturesReady++;
      this._setLoadingProgress(
        0.86 + 0.12 * (texturesReady / ids.length),
        `Preparing terrain art · ${texturesReady}/${ids.length}`,
      );
    })));
  }

  _prepareWorld() {
    this._gameSceneModulePromise ??= Promise.all([
      this.gc.prepareWorld?.(),
      import('./game-scene.js'),
    ]).then(([, gameSceneModule]) => gameSceneModule);
    return this._gameSceneModulePromise;
  }

  _goBackToMain() {
    net.close();
    this._setStep(LoginSteps.Main);
    // Audit #46 P2 — try AutoLogin AFTER the Main panel mounts.
    try { this._tryAutoLogin?.(); } catch { /* ignore */ }
  }

  // --------------------------------------------------------------------------
  // Bootstrap helpers

  _sub(topic, fn) { this._unsubs.push(bus.on(topic, fn)); }

  /** Inject step-specific styling once per scene mount. */
  _injectStyles() {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;
    if (document.getElementById?.('uo-login-styles')) return;
    const style = document.createElement('style');
    style.id = 'uo-login-styles';
    style.textContent = `
      :root {
        --uo-gold: #d8af62; --uo-gold-bright: #f0d69a; --uo-copper: #9d6235;
        --uo-ink: #080b0f; --uo-slate: #10151b; --uo-line: rgba(229,190,113,.2);
        --uo-muted: #8c9298; --uo-text: #ece6d8; --uo-danger: #d27767;
      }
      .uo-login-ambient { position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;
        background:
          radial-gradient(circle at 18% 22%,rgba(120,78,36,.18),transparent 28%),
          radial-gradient(circle at 82% 78%,rgba(64,88,85,.12),transparent 32%),
          linear-gradient(135deg,#05070a 0%,#0c1014 48%,#080805 100%); }
      .uo-login-ambient::before { content:"";position:absolute;inset:0;opacity:.26;
        background-image:linear-gradient(rgba(255,255,255,.018) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.018) 1px,transparent 1px);
        background-size:48px 48px;mask-image:radial-gradient(circle at center,#000,transparent 78%); }
      .uo-login-ambient::after { content:"";position:absolute;inset:0;box-shadow:inset 0 0 180px 55px #000; }
      .uo-login-orb { position:absolute;width:min(62vw,920px);aspect-ratio:1;left:50%;top:48%;transform:translate(-50%,-50%);border-radius:50%;
        background:radial-gradient(circle,rgba(202,151,75,.13) 0%,rgba(121,72,31,.06) 34%,transparent 68%);animation:uo-breathe 8s ease-in-out infinite; }
      .uo-login-runes { position:absolute;left:50%;bottom:6vh;transform:translateX(-50%);color:rgba(216,175,98,.15);font:18px/1 Georgia,serif;letter-spacing:18px;white-space:nowrap; }
      .uo-login-horizon { position:absolute;left:10%;right:10%;bottom:12%;height:1px;background:linear-gradient(90deg,transparent,rgba(216,175,98,.17),transparent); }
      @keyframes uo-breathe { 50% { transform:translate(-50%,-50%) scale(1.08);opacity:.75 } }

      .uo-panel.uo-login-surface { box-sizing:border-box;width:min(1060px,calc(100vw - 48px));min-width:0;max-height:calc(100vh - 48px);padding:0;margin:0;
        color:var(--uo-text);background:linear-gradient(145deg,rgba(16,20,25,.985),rgba(7,9,12,.99));border:1px solid rgba(216,175,98,.38);border-radius:18px;
        box-shadow:0 34px 90px rgba(0,0,0,.72),0 0 0 1px rgba(0,0,0,.8),inset 0 1px rgba(255,255,255,.035);overflow:hidden;
        font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;animation:uo-panel-in .32s cubic-bezier(.2,.8,.2,1); }
      @keyframes uo-panel-in { from { opacity:0;transform:translate(-50%,calc(-50% + 12px)) scale(.985) } }
      .uo-login-surface *, .uo-login-surface *::before, .uo-login-surface *::after { box-sizing:border-box; }
      .uo-login-frame { width:100%;height:min(650px,calc(100vh - 48px));display:grid;grid-template-columns:360px minmax(0,1fr); }
      .uo-login-frame--auth { height:min(640px,calc(100vh - 48px)); }
      .uo-login-aside { position:relative;display:flex;flex-direction:column;justify-content:center;padding:52px 46px;overflow:hidden;
        background:linear-gradient(155deg,rgba(135,82,36,.28),rgba(34,26,18,.72)),radial-gradient(circle at 20% 10%,rgba(239,196,112,.18),transparent 42%);border-right:1px solid var(--uo-line); }
      .uo-login-aside::before { content:"";position:absolute;width:360px;height:360px;right:-180px;bottom:-170px;border:1px solid rgba(216,175,98,.14);border-radius:50%;box-shadow:0 0 0 34px rgba(216,175,98,.025),0 0 0 68px rgba(216,175,98,.018); }
      .uo-login-aside h1 { margin:14px 0 18px;font:500 48px/.93 Georgia,"Times New Roman",serif;letter-spacing:-1.5px;color:#f4ecdc; }
      .uo-login-aside h1 em { color:var(--uo-gold);font-weight:400; }
      .uo-login-aside p { max-width:265px;margin:0;color:#b9b5aa;font-size:14px;line-height:1.7; }
      .uo-login-aside--compact h1 { font-size:42px; }
      .uo-brand-seal { width:76px;height:76px;display:grid;place-items:center;border:1px solid rgba(230,190,112,.55);border-radius:50%;margin-bottom:28px;position:relative;color:var(--uo-gold-bright);font:700 23px Georgia,serif; }
      .uo-brand-seal::before,.uo-brand-seal::after { content:"";position:absolute;border:1px solid rgba(216,175,98,.2);border-radius:50%;inset:6px; }.uo-brand-seal::after{inset:-7px;border-style:dotted;}
      .uo-brand-seal--small { width:58px;height:58px;font-size:18px;margin-bottom:24px }.uo-brand-seal--tiny{width:44px;height:44px;font-size:14px;margin:0 15px 0 0;flex:0 0 auto}
      .uo-eyebrow { color:var(--uo-gold);font-size:10px;line-height:1.2;font-weight:750;letter-spacing:2.3px;text-transform:uppercase; }
      .uo-aside-status { margin-top:36px;display:flex;align-items:center;gap:9px;color:#9fa69f;font-size:12px; }.uo-aside-status i{width:7px;height:7px;border-radius:50%;background:#71b88a;box-shadow:0 0 12px #71b88a}
      .uo-roster-count { margin-top:32px;display:flex;align-items:baseline;gap:10px }.uo-roster-count strong{font:36px Georgia,serif;color:var(--uo-gold-bright)}.uo-roster-count span{color:var(--uo-muted);font-size:12px}
      .uo-login-content { min-width:0;display:flex;flex-direction:column;padding:52px 58px 38px; }
      .uo-screen-heading { margin-bottom:28px }.uo-screen-heading h2,.uo-loading-card h2,.uo-dialog-card h2 { margin:8px 0 7px;font:500 34px/1.08 Georgia,"Times New Roman",serif;color:#f2eee4;letter-spacing:-.5px }.uo-screen-heading p,.uo-loading-card p{margin:0;color:var(--uo-muted);font-size:13px}
      .uo-form-grid,.uo-settings-grid { display:grid;grid-template-columns:minmax(0,1fr) 105px;gap:15px 12px }.uo-field--wide{grid-column:1/-1}.uo-field--host{grid-column:1}.uo-field--port{grid-column:2}
      .uo-login-surface .uo-field label { display:block;margin:0 0 7px;color:#bcb6a9;font-size:11px;font-weight:650;letter-spacing:.35px; }
      .uo-login-surface input,.uo-login-surface select { width:100%;height:44px;padding:0 13px;margin:0;background:rgba(2,4,6,.7);color:var(--uo-text);border:1px solid rgba(216,175,98,.24);border-radius:8px;font:14px Inter,ui-sans-serif,sans-serif;transition:border-color .18s,box-shadow .18s,background .18s; }
      .uo-login-surface input:hover,.uo-login-surface select:hover{border-color:rgba(216,175,98,.46)}.uo-login-surface input:focus,.uo-login-surface select:focus{outline:none;border-color:var(--uo-gold);box-shadow:0 0 0 3px rgba(216,175,98,.1);background:#080b0e}
      .uo-login-surface input::placeholder{color:#5f6469}.uo-login-surface select{appearance:auto}
      .uo-connection-settings { margin-top:1px;border:1px solid rgba(216,175,98,.14);border-radius:9px;background:rgba(0,0,0,.14);overflow:hidden }.uo-connection-settings summary{height:43px;padding:0 13px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;color:#bcb6a9;font-size:12px;list-style:none}.uo-connection-settings summary::-webkit-details-marker{display:none}.uo-connection-settings summary::before{content:"+";margin-right:8px;color:var(--uo-gold)}.uo-connection-settings[open] summary::before{content:"−"}.uo-connection-settings summary small{margin-left:auto;color:#777d82}.uo-settings-grid{padding:13px;border-top:1px solid rgba(216,175,98,.12)}
      .uo-status-line { min-height:20px;margin:10px 0 0;color:#d49c70;font-size:12px;line-height:20px;text-align:left; }
      .uo-actions { display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:auto;padding-top:20px;border-top:1px solid rgba(216,175,98,.12) }
      .uo-login-surface button.uo-button { min-width:126px;height:44px;margin:0;padding:0 18px;border:1px solid rgba(216,175,98,.26);border-radius:8px;background:rgba(255,255,255,.025);color:#d7d2c6;font:650 12px Inter,ui-sans-serif,sans-serif;letter-spacing:.15px;cursor:pointer;transition:transform .15s,background .15s,border-color .15s,box-shadow .15s; }
      .uo-login-surface button.uo-button:hover:not(:disabled){transform:translateY(-1px);border-color:rgba(216,175,98,.55);background:rgba(216,175,98,.08)}.uo-login-surface button.uo-button:active:not(:disabled){transform:translateY(0)}
      .uo-login-surface button.primary { min-width:190px;border-color:#b68143;background:linear-gradient(135deg,#b77b3d,#7e4927);color:#fff5df;box-shadow:0 9px 24px rgba(91,48,22,.3) }.uo-login-surface button.primary:hover:not(:disabled){background:linear-gradient(135deg,#c68d4b,#92572e);box-shadow:0 11px 28px rgba(116,66,29,.4)}.uo-login-surface button.primary span{margin-left:12px;font-size:16px}
      .uo-login-surface button.uo-button--quiet{margin-right:auto;color:#989b9c}.uo-login-surface button.uo-button--danger{color:#cf8b7f;border-color:rgba(207,120,105,.25)}.uo-login-surface button:disabled{opacity:.38;cursor:not-allowed;filter:saturate(.3)}

      .uo-choice-list { min-height:0;overflow:auto;padding:5px;border:1px solid rgba(216,175,98,.13);border-radius:11px;background:rgba(0,0,0,.19);scrollbar-width:thin;scrollbar-color:#6b4a27 transparent }
      .uo-server-row,.uo-char-slot,.uo-prof-row,.uo-city-row { position:relative;display:flex;align-items:center;gap:14px;padding:14px 16px;border:1px solid transparent;border-radius:8px;cursor:pointer;user-select:none;transition:background .14s,border-color .14s,transform .14s }
      .uo-server-row:hover,.uo-char-slot:hover,.uo-prof-row:hover,.uo-city-row:hover{background:rgba(216,175,98,.055);border-color:rgba(216,175,98,.12)}
      .uo-server-row.selected,.uo-char-slot.selected,.uo-prof-row.selected,.uo-city-row.selected{background:linear-gradient(90deg,rgba(162,103,52,.25),rgba(216,175,98,.07));border-color:rgba(216,175,98,.42);box-shadow:inset 3px 0 #c38b4d}
      .uo-server-icon{width:36px;height:36px;display:grid;place-items:center;border-radius:8px;background:rgba(216,175,98,.08);color:var(--uo-gold)}.uo-server-copy,.uo-slot-copy{display:flex;flex:1;min-width:0;flex-direction:column;gap:4px}.uo-server-name,.uo-slot-name,.uo-prof-name,.uo-city-name{color:#e9e3d6;font-size:14px;font-weight:680}.uo-server-copy small,.uo-slot-copy small{color:#70767b;font-size:10px}.uo-server-load,.uo-server-ping{min-width:68px;display:flex;flex-direction:column;align-items:flex-end;gap:3px}.uo-server-load b,.uo-server-ping b{font-size:12px;color:#c9c1b1}.uo-server-load small,.uo-server-ping small{font-size:9px;color:#656b70;text-transform:uppercase;letter-spacing:1px}.uo-server-ping b{color:#82b999}
      .uo-char-list{min-height:0}.uo-char-slot{min-height:62px}.uo-slot-num{width:25px;color:#665a49;font:11px ui-monospace,monospace}.uo-slot-avatar{width:34px;height:34px;display:grid;place-items:center;border:1px solid rgba(216,175,98,.17);border-radius:50%;color:#c79a5a;background:#12100c}.uo-char-slot.empty .uo-slot-avatar{border-style:dashed;background:transparent;color:#75644d}.uo-char-slot.empty .uo-slot-name{color:#85817a;font-weight:500}.uo-slot-chevron{color:#655b4d;font-size:24px}.uo-char-slot.selected .uo-slot-chevron{color:var(--uo-gold)}.uo-actions--roster button{min-width:105px!important}.uo-actions--roster button.primary{min-width:158px!important}

      .uo-login-frame--creation{height:min(680px,calc(100vh - 48px));display:flex;flex-direction:column}.uo-creation-header{display:flex;align-items:center;gap:30px;padding:25px 34px 21px;border-bottom:1px solid var(--uo-line);background:linear-gradient(90deg,rgba(120,70,29,.12),transparent)}.uo-creation-brand{display:flex;align-items:center;min-width:330px}.uo-creation-brand h2{margin:3px 0 2px;font:500 24px/1.1 Georgia,serif;color:#f1ecdf}.uo-creation-brand p{margin:0;color:#777e84;font-size:11px}.uo-creation-progress{display:flex;align-items:flex-start;justify-content:flex-end;flex:1;margin:0;padding:0;list-style:none}.uo-creation-progress li{position:relative;display:flex;flex:1;max-width:135px;flex-direction:column;align-items:center;gap:6px;color:#62686d}.uo-creation-progress li:not(:last-child)::after{content:"";position:absolute;top:13px;left:calc(50% + 17px);right:calc(-50% + 17px);height:1px;background:#343536}.uo-creation-progress li span{position:relative;z-index:1;width:27px;height:27px;display:grid;place-items:center;border:1px solid #414348;border-radius:50%;background:#101318;font-size:10px}.uo-creation-progress li small{font-size:9px;white-space:nowrap}.uo-creation-progress li.active{color:var(--uo-gold-bright)}.uo-creation-progress li.active span{border-color:var(--uo-gold);background:#704724;box-shadow:0 0 0 4px rgba(216,175,98,.08)}.uo-creation-progress li.done{color:#9c835e}.uo-creation-progress li.done span{border-color:#80623c;color:#d9bb7b}.uo-creation-progress li.done::after{background:#785a37}
      .uo-creation-content{flex:1;min-height:0;padding:24px 34px;overflow:auto}.uo-creation-actions{margin:0;padding:17px 34px;border-top:1px solid var(--uo-line);background:rgba(0,0,0,.13)}
      .uo-appearance-layout{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:35px;overflow:hidden}.uo-appearance-form{min-width:0;overflow:auto;padding-right:3px}.uo-segment-row{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:15px 0}.uo-segmented{display:grid;grid-template-columns:1fr 1fr;align-content:end;margin:0;padding:0;border:0}.uo-segmented legend{grid-column:1/-1;margin:0 0 7px;color:#bcb6a9;font-size:11px;font-weight:650}.uo-segmented label{display:block;width:auto;margin:0!important}.uo-segmented input{position:absolute;opacity:0;pointer-events:none}.uo-segmented span{height:44px;display:grid;place-items:center;border:1px solid rgba(216,175,98,.22);color:#888d90;font-size:12px;cursor:pointer}.uo-segmented label:first-of-type span{border-radius:8px 0 0 8px}.uo-segmented label:last-of-type span{border-left:0;border-radius:0 8px 8px 0}.uo-segmented input:checked+span{color:#f1dfbd;background:rgba(176,112,53,.23);border-color:#a97640;box-shadow:inset 0 0 20px rgba(211,160,83,.05)}.uo-appearance-grid{display:grid;grid-template-columns:1fr 1fr;gap:13px 14px}
      .uo-character-preview{position:relative;min-height:370px;display:flex;flex-direction:column;align-items:center;justify-content:center;border:1px solid rgba(216,175,98,.15);border-radius:13px;overflow:hidden;background:radial-gradient(circle at 50% 42%,rgba(207,154,77,.16),transparent 48%),linear-gradient(180deg,#101216,#090b0e)}.uo-character-preview::before{content:"PREVIEW";position:absolute;left:16px;top:14px;color:#68645b;font-size:9px;font-weight:700;letter-spacing:2px}.uo-preview-frame{position:relative;width:280px;height:300px;display:flex;align-items:flex-end;justify-content:center}.uo-preview-halo{position:absolute;width:245px;height:245px;left:50%;top:18px;transform:translateX(-50%);border:1px solid rgba(216,175,98,.12);border-radius:50%;box-shadow:0 0 0 24px rgba(216,175,98,.018)}.uo-preview-canvas{position:relative;z-index:2;width:260px;height:237px;image-rendering:auto;filter:drop-shadow(0 13px 13px rgba(0,0,0,.7))}.uo-preview-ground{position:absolute;z-index:1;left:32px;right:32px;bottom:4px;height:26px;border-radius:50%;background:radial-gradient(ellipse,rgba(0,0,0,.85),transparent 68%)}.uo-preview-caption{display:flex;align-items:center;gap:7px;color:#7e8588;font-size:10px}.uo-preview-caption i{width:6px;height:6px;border-radius:50%;background:#6cb083;box-shadow:0 0 8px #6cb083}
      .uo-choice-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;max-height:none;overflow:visible}.uo-prof-row{min-height:78px}.uo-prof-mark{width:42px;height:42px;display:grid;place-items:center;border-radius:9px;background:linear-gradient(145deg,#32251a,#17130f);border:1px solid rgba(216,175,98,.2);color:#d4ad6c;font:20px Georgia,serif}.uo-prof-copy{min-width:0;flex:1}.uo-prof-desc{margin-top:5px;color:#777c7f;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.uo-choice-check{width:21px;height:21px;display:grid;place-items:center;border:1px solid #3e4244;border-radius:50%;color:transparent;font-size:10px}.selected>.uo-choice-check{background:#9a6435;border-color:#c99252;color:#fff1d2}
      .uo-trade-layout{display:grid;grid-template-columns:1fr 1.22fr;gap:15px;align-content:start}.uo-build-card{padding:18px;border:1px solid rgba(216,175,98,.14);border-radius:11px;background:rgba(0,0,0,.16)}.uo-section-heading{display:flex;gap:12px;align-items:flex-start;margin-bottom:16px}.uo-section-heading>span{width:25px;height:25px;display:grid;place-items:center;border-radius:50%;background:rgba(216,175,98,.1);color:var(--uo-gold);font-size:9px}.uo-section-heading h3{margin:1px 0 4px;color:#e3ddd0;font-size:13px}.uo-section-heading p{margin:0;color:#71777b;font-size:10px}.uo-stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:9px}.uo-stat-grid label{padding:12px;border:1px solid rgba(216,175,98,.12);border-radius:8px;text-align:center}.uo-stat-grid label>span{display:block;color:#d7b577;font-size:11px;font-weight:750;letter-spacing:1px}.uo-stat-grid label>small{display:block;margin:3px 0 8px;color:#646b70;font-size:9px}.uo-stat-grid input{text-align:center;font-weight:700}.uo-skill-list{display:flex;flex-direction:column;gap:7px}.uo-skill-row{display:grid;grid-template-columns:24px minmax(0,1fr) 64px 13px;align-items:center;gap:7px}.uo-skill-index{color:#5f6468;font:10px ui-monospace,monospace}.uo-skill-row input{padding:0;text-align:center}.uo-skill-percent{color:#656b6e;font-size:10px}.uo-total-meter{grid-column:1/-1;display:flex;gap:10px}.uo-total-meter span{flex:1;padding:9px 12px;border:1px solid rgba(216,175,98,.13);border-radius:7px;color:#94816b;font-size:10px}.uo-total-meter span b{color:#d39668}.uo-total-meter span.ok{border-color:rgba(103,173,128,.3);color:#7da98c}.uo-total-meter span.ok b{color:#91c3a2}.uo-trade-layout .uo-status-line{grid-column:1/-1;margin:0}
      .uo-city-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;overflow:visible}.uo-city-row{min-height:94px;align-items:flex-start}.uo-city-pin{width:38px;height:38px;display:grid;place-items:center;border:1px solid rgba(216,175,98,.2);border-radius:50%;color:var(--uo-gold);background:rgba(216,175,98,.05);font-size:18px}.uo-city-copy{min-width:0;flex:1}.uo-city-area{margin:4px 0 6px;color:#aa8c61;font-size:9px;text-transform:uppercase;letter-spacing:1px}.uo-city-lore{color:#73797d;font-size:10px;line-height:1.45}
      .uo-loading-card,.uo-dialog-card{width:min(440px,calc(100vw - 36px));padding:40px;text-align:center}.uo-loading-card .uo-brand-seal{margin:0 auto 28px}.uo-loading-card .uo-spinner{position:relative;width:58px;height:58px;margin:0 auto 25px;border:1px solid rgba(216,175,98,.16);border-radius:50%}.uo-loading-card .uo-spinner::before,.uo-loading-card .uo-spinner i{content:"";position:absolute;inset:5px;border-top:2px solid var(--uo-gold);border-radius:50%;animation:uo-spin 1.1s linear infinite}.uo-loading-card .uo-spinner i{inset:13px;border-top-color:#7f5a32;animation-direction:reverse;animation-duration:1.8s}.uo-loading-status{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:27px;color:#7f858a;font:600 10px/1.3 Inter,ui-sans-serif,sans-serif;letter-spacing:.04em}.uo-loading-status span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}.uo-loading-status b{color:#d7b474;font:700 11px/1 ui-monospace,monospace}.uo-loading-track{position:relative;height:6px;margin-top:9px;overflow:hidden;border:1px solid rgba(216,175,98,.12);border-radius:999px;background:#17191c;box-shadow:inset 0 1px 3px rgba(0,0,0,.65)}.uo-loading-track span{display:block;height:100%}#uo-loading-progress{position:relative;width:100%;overflow:hidden;transform:scaleX(var(--uo-loading-progress,0));transform-origin:left center;background:linear-gradient(90deg,#80552d,#d5a85f 72%,#f1d59b);box-shadow:0 0 12px rgba(216,175,98,.28);transition:transform .24s cubic-bezier(.2,.8,.2,1)}#uo-loading-progress::after{content:"";position:absolute;inset:0;width:42%;background:linear-gradient(90deg,transparent,rgba(255,249,224,.7),transparent);animation:uo-progress-shine 1.25s ease-in-out infinite}.uo-loading-heartbeat{display:flex;align-items:center;justify-content:center;gap:7px;margin-top:12px;color:#5f666b;font:550 9px/1 Inter,ui-sans-serif,sans-serif;letter-spacing:.08em;text-transform:uppercase}.uo-loading-heartbeat i{width:5px;height:5px;border-radius:50%;background:#8bb999;box-shadow:0 0 0 0 rgba(139,185,153,.45);animation:uo-heartbeat 1.4s ease-out infinite}.uo-reconnect-track span{width:0;background:linear-gradient(90deg,#80552d,#d5a85f);transition:width .1s linear}.uo-dialog-card .uo-dialog-icon{width:50px;height:50px;display:grid;place-items:center;margin:0 auto 20px;border:1px solid rgba(216,175,98,.35);border-radius:50%;color:var(--uo-gold);font:24px Georgia,serif}.uo-dialog-message{margin:18px 0 8px;white-space:pre-line;color:#bab5aa;font-size:13px;line-height:1.65}.uo-dialog-card .uo-actions{justify-content:center}.uo-dialog-card .uo-button--quiet{margin-right:0!important}
      @keyframes uo-spin{to{transform:rotate(360deg)}}@keyframes uo-progress-shine{from{transform:translateX(-130%)}to{transform:translateX(340%)}}@keyframes uo-heartbeat{0%{box-shadow:0 0 0 0 rgba(139,185,153,.45)}70%,100%{box-shadow:0 0 0 7px rgba(139,185,153,0)}}

      @media (max-width:820px){.uo-panel.uo-login-surface{width:calc(100vw - 24px);max-height:calc(100vh - 24px)}.uo-login-frame{height:calc(100vh - 24px);grid-template-columns:1fr;overflow:auto}.uo-login-aside{min-height:190px;padding:28px 30px;justify-content:flex-end;border-right:0;border-bottom:1px solid var(--uo-line)}.uo-login-aside h1{font-size:34px;margin:8px 0}.uo-login-aside p,.uo-aside-status,.uo-roster-count{display:none}.uo-brand-seal{position:absolute;right:28px;top:28px;width:52px;height:52px;margin:0}.uo-login-content{padding:30px}.uo-screen-heading{margin-bottom:22px}.uo-login-frame--creation{height:calc(100vh - 24px)}.uo-creation-header{display:block;padding:19px 22px}.uo-creation-brand{min-width:0}.uo-creation-brand .uo-brand-seal{display:none}.uo-creation-progress{margin-top:17px}.uo-creation-progress li small{display:none}.uo-creation-content{padding:20px 22px}.uo-appearance-layout{grid-template-columns:1fr;overflow:auto}.uo-character-preview{min-height:330px}.uo-choice-grid,.uo-city-grid,.uo-trade-layout{grid-template-columns:1fr}.uo-creation-actions{padding:14px 22px}.uo-trade-layout .uo-total-meter{grid-column:1}.uo-actions--roster{flex-wrap:wrap}.uo-actions--roster button{flex:1}.uo-actions--roster .uo-button--quiet{flex-basis:100%}}
      @media (max-width:520px){.uo-login-content{padding:24px 20px}.uo-screen-heading h2{font-size:29px}.uo-form-grid,.uo-settings-grid{grid-template-columns:1fr}.uo-field--host,.uo-field--port{grid-column:1}.uo-actions{gap:7px}.uo-login-surface button.uo-button{min-width:0;flex:1;padding:0 11px}.uo-login-surface button.primary{min-width:0}.uo-appearance-grid,.uo-segment-row{grid-template-columns:1fr}.uo-stat-grid{grid-template-columns:1fr}.uo-total-meter{flex-direction:column}.uo-creation-brand p{display:none}.uo-prof-desc{white-space:normal}.uo-login-runes{display:none}}
      @media (prefers-reduced-motion:reduce){.uo-login-orb,.uo-login-surface,.uo-loading-card .uo-spinner::before,.uo-loading-card .uo-spinner i,#uo-loading-progress::after,.uo-loading-heartbeat i{animation:none!important}}
    `;
    document.head?.appendChild?.(style);
  }

  _renderReconnect({ attempt = 1, maxTries = 12, waitMs = 5000, error = '' } = {}) {
    this._mountPanel(`
      <section class="uo-loading-card uo-reconnect-card" role="status" aria-live="polite">
        <div class="uo-brand-seal uo-brand-seal--small" aria-hidden="true"><span>UO</span></div>
        <div class="uo-eyebrow">CONNECTION RECOVERY</div>
        <h2>Reconnecting</h2>
        <p id="uo-reconnect-copy">Attempt ${attempt} of ${maxTries}</p>
        ${error ? `<small class="uo-reconnect-error">${esc(error)}</small>` : ''}
        <div class="uo-loading-track uo-reconnect-track"><span id="uo-reconnect-progress"></span></div>
        <button id="uo-reconnect-cancel" class="uo-button uo-button--quiet">Cancel reconnect</button>
      </section>
    `);
    this._injectStyles();
    this._panel.querySelector('#uo-reconnect-cancel')?.addEventListener('click', () => {
      this._cancelReconnect({ returnToMain: true });
    });
    const started = performance.now();
    const update = () => {
      const ratio = Math.min(1, (performance.now() - started) / Math.max(1, waitMs));
      const bar = this._panel?.querySelector('#uo-reconnect-progress');
      const copy = this._panel?.querySelector('#uo-reconnect-copy');
      if (bar) bar.style.width = `${Math.round(ratio * 100)}%`;
      if (copy) copy.textContent = `Attempt ${attempt} of ${maxTries} · retry in ${Math.max(0, Math.ceil((waitMs - (performance.now() - started)) / 1000))}s`;
    };
    update();
    clearInterval(this._reconnectTicker);
    this._reconnectTicker = setInterval(update, 100);
  }
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n | 0));
}
