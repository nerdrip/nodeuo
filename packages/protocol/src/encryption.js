// Encryption layer for legacy UO clients. Pure JS port of ClassicUO's
// `Network/Encryption/*`. Used by `apps/bridge` when proxying a browser
// WebSocket session to an OSI / ServUO shard that requires encryption.
//
// Two stages exist on the wire:
//   1. **LoginCrypt** — applied to the login connection (account login
//      → server list → relay). XOR stream cipher with a client-version
//      derived key triple `(k1, k2, k3)` plus a per-session seed.
//   2. **GameCrypt** — applied to the game-server connection after the
//      relay handoff. Either Blowfish (older clients) or Twofish-MD5
//      (modern clients). We currently ship the LoginCrypt half plus a
//      pluggable interface for GameCrypt — the Blowfish/Twofish bodies
//      are heavy (~400 LOC each) and most shards bypass them via the
//      `Encryption=No` server flag.
//
// Bridge usage:
//   const enc = new LoginCrypt(seed, clientVersion);
//   socket.on('data', (buf) => {
//     const dec = enc.decrypt(buf);
//     ...
//   });
//   socket.write(enc.encrypt(plaintext));
//
// Browser-direct usage: not supported by the Web client today (it
// connects via `apps/bridge` and inherits the bridge's clear channel).
// Putting the keys in the browser would also be a security regression
// — encryption is link-layer obfuscation, not auth, and the seed is
// trivially observable on the client.

/**
 * Compute the (k1,k2,k3) triple ServUO/OSI clients use to seed the
 * LoginCrypt stream. Mirrors ClassicUO `Encryption.CalculateEncryption`.
 *
 * @param {{ a:number, b:number, c:number, d:number }} version
 *        Four-octet client version (e.g. 7.0.95.0 → {a:7,b:0,c:95,d:0}).
 * @returns {[number, number, number]}
 */
export function calculateLoginKeys(version) {
  const { a = 7, b = 0, c = 95, d: _d = 0 } = version ?? {};
  const temp1 = ((((a << 9) | b) << 10) | c) ^ ((c * c) << 5);
  const key2  = (((temp1 << 4) ^ (b * b) ^ (b * 0x0B000000) ^ (c * 0x380000) ^ 0x2C13A5FD) >>> 0);
  const temp2 = (((((a << 9) | c) << 10) | b) * 8) ^ (c * c * 0x0c00);
  const key3  = ((temp2 ^ (b * b) ^ (b * 0x6800000) ^ (c * 0x1c0000) ^ 0x0A31D527F) >>> 0);
  const key1  = (key2 - 1) >>> 0;
  return [key1, key2, key3];
}

/**
 * Stream cipher used between the client and the login server. The
 * algorithm is just an XOR of each byte with the low octet of `_key[0]`,
 * after which both halves of the 64-bit key are rotated through the
 * three constants. Both directions of the stream use the same algorithm
 * in lock-step; if the keys diverge the stream becomes garbage.
 *
 * Mirrors ClassicUO `LoginCryptBehaviour.Encrypt`.
 */
export class LoginCrypt {
  /**
   * @param {number} seed   per-session seed (the 4-byte preamble the
   *                        client sends before the 0x80 packet).
   * @param {{a,b,c,d}} version  client version triple.
   */
  constructor(seed, version) {
    const [k1, k2, k3] = calculateLoginKeys(version);
    this._k1 = k1 >>> 0;
    this._k2 = k2 >>> 0;
    this._k3 = k3 >>> 0;
    this._seed = seed >>> 0;
    this._key = new Uint32Array(2);
    this._key[0] = ((~this._seed ^ 0x00001357) << 16) | ((this._seed ^ 0xFFFFAAAA) & 0x0000FFFF);
    this._key[1] = ((this._seed ^ 0x43210000) >>> 16) | ((~this._seed ^ 0xABCDFFFF) & 0xFFFF0000);
  }

  /** Encrypt-or-decrypt (the operation is symmetric). Mutates `dst`. */
  transform(src, dst = new Uint8Array(src.length)) {
    for (let i = 0; i < src.length; i++) {
      dst[i] = src[i] ^ (this._key[0] & 0xFF);
      const t0 = this._key[0] >>> 0;
      const t1 = this._key[1] >>> 0;
      this._key[1] = (((((t1 >>> 1) | (t0 << 31)) ^ this._k1) >>> 1) | (t0 << 31)) ^ this._k2;
      this._key[0] = ((t0 >>> 1) | (t1 << 31)) ^ this._k3;
    }
    return dst;
  }

  encrypt(src) { return this.transform(src); }
  decrypt(src) { return this.transform(src); }
}

/**
 * GameCrypt — placeholder for the post-login Blowfish/Twofish layer.
 * Implements the no-op variant most modern shards run with. Plug in
 * a real BlowfishEncryption / TwofishMd5Encryption via `selectGameCrypt`.
 */
export class GameCryptNone {
  encrypt(buf) { return buf; }
  decrypt(buf) { return buf; }
}

/**
 * Detect which game-encryption profile a client wants. ServUO / OSI
 * negotiate this via the client-version field in the login packet.
 *
 * Returns the string identifier ('none' | 'blowfish' | 'twofish-md5').
 */
export function detectGameCryptVariant(version) {
  if (!version) return 'none';
  const { a = 0, b = 0, c = 0 } = version;
  if (a < 1 || (a === 1 && b < 25)) return 'old-blowfish';
  if (a === 1 && b === 25 && c <= 36) return 'blowfish-1.25.36';
  if (a < 2) return 'blowfish';
  if (a === 2 && b === 0 && c < 4) return 'blowfish-2.0.3';
  return 'twofish-md5';
}

/**
 * Audit #46 P2 — KR-mode handshake factory. Returns an active
 * GameCrypt instance for the negotiated variant. Falls back to
 * GameCryptNone when the version field requests a no-op channel.
 *
 * The bridge calls this after receiving the 0x91 GameLogin (the
 * preamble + client version are visible in plaintext). Returned
 * object exposes `encrypt(buf)` / `decrypt(buf)` and is symmetric
 * across the wire.
 *
 * @param {number} seed         per-session seed (u32 preamble).
 * @param {{a:number,b:number,c:number,d:number}} version
 * @param {string} [forceVariant]  override the detector (test hook).
 */
export async function selectGameCrypt(seed, version, forceVariant = null) {
  const variant = forceVariant ?? detectGameCryptVariant(version);
  if (variant === 'none') return { variant, cipher: new GameCryptNone() };
  // Lazy-import the heavy modules so projects that ship `none` don't
  // pay the parse cost of Blowfish + Twofish + MD5.
  if (variant.startsWith('blowfish')) {
    const { BlowfishEncryption } = await import('./blowfish.js');
    return { variant, cipher: new BlowfishEncryption(seed) };
  }
  if (variant === 'twofish-md5') {
    const { TwofishMd5Encryption } = await import('./twofish.js');
    return { variant, cipher: new TwofishMd5Encryption(seed, version) };
  }
  return { variant: 'none', cipher: new GameCryptNone() };
}

/**
 * KR handshake reply. CUO `Network/Encryption/CryptManager.cs`
 * recognises the modern KR (Kingdom Reborn) client by the magic
 * preamble byte 0xE3 from the server. The client must reply with a
 * 0xE3 containing the negotiated `authId` echoed back. We construct
 * the reply here so the bridge can forward it.
 *
 * @param {number} authId  4-byte echo from the 0xE3 prompt body.
 * @returns {Uint8Array}   16-byte response packet.
 */
export function buildKrHandshakeReply(authId) {
  const out = new Uint8Array(16);
  out[0] = 0xE3;
  out[1] = 0; out[2] = 16;          // u16 size
  out[3] = (authId >>> 24) & 0xff;
  out[4] = (authId >>> 16) & 0xff;
  out[5] = (authId >>> 8)  & 0xff;
  out[6] =  authId         & 0xff;
  // Trailing 9 bytes: 0x00..0x08 (CUO sends a sequence ack).
  for (let i = 0; i < 9; i++) out[7 + i] = i;
  return out;
}
