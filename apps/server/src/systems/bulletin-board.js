// Bulletin-board server logic — 0x71 packet hub.
//
// Boards live as items with `kind:'bulletin'` in the world. Posts use a
// sidecar snapshot because they are not ordinary item fields; main.js saves
// and restores that snapshot together with the other auxiliary world state.
//
// Outbound packets we build:
//   0x71 0x00 board header + summary list (sent on board open)
//   0x71 0x01 single message header (compact)
//   0x71 0x02 full message body
//
// Inbound:
//   0x71 0x03 new post   (author + subject + body)
//   0x71 0x04 delete     (post serial)
//   0x71 0x05 request    (post serial → reply with body)

import { PacketWriter, PacketReader } from '@uo/protocol';

const _boards = new Map(); // boardSerial → { posts: [{serial, subject, author, body, createdAt}] }
let _nextPostSerial = 1;

export function getBoard(serial) {
  let b = _boards.get(serial >>> 0);
  if (!b) { b = { posts: [] }; _boards.set(serial >>> 0, b); }
  return b;
}

export function deleteBoard(serial) { _boards.delete(serial >>> 0); }

/** Snapshot every board's posts for persistence. Bug-hunt/parity #9 #10:
 *  restart used to wipe all player-authored posts. */
export function serializeBoards() {
  return {
    nextPostSerial: _nextPostSerial,
    boards: [..._boards.entries()].map(([serial, b]) => ({
      serial, posts: b.posts.map((p) => ({ ...p })),
    })),
  };
}
export function deserializeBoards(snap) {
  if (!snap || !Array.isArray(snap.boards)) return 0;
  _boards.clear();
  if (Number.isFinite(snap.nextPostSerial)) _nextPostSerial = snap.nextPostSerial;
  for (const row of snap.boards) {
    if (!Number.isFinite(row.serial)) continue;
    _boards.set(row.serial >>> 0, {
      posts: Array.isArray(row.posts) ? row.posts.map((p) => ({ ...p })) : [],
    });
  }
  return _boards.size;
}

export function createPost(boardSerial, { subject, author, body, replyTo = 0 }) {
  const board = getBoard(boardSerial);
  const post = {
    serial: _nextPostSerial++,
    subject: String(subject ?? '').slice(0, 60),
    author:  String(author ?? '').slice(0, 30),
    body:    String(body ?? '').slice(0, 1024),
    createdAt: Date.now(),
    replyTo: replyTo >>> 0,
  };
  board.posts.unshift(post);
  if (board.posts.length > 50) board.posts.length = 50; // cap
  return post;
}

/** Walk the parent chain of a post and return its thread (root → leaf). */
export function threadOf(boardSerial, postSerial) {
  const board = _boards.get(boardSerial >>> 0);
  if (!board) return [];
  const out = [];
  const byId = new Map(board.posts.map((p) => [p.serial, p]));
  let cur = byId.get(postSerial >>> 0);
  while (cur) {
    out.unshift(cur);
    if (!cur.replyTo) break;
    cur = byId.get(cur.replyTo);
  }
  // Append direct children (one level deep).
  const children = board.posts.filter((p) => p.replyTo === (postSerial >>> 0));
  out.push(...children);
  return out;
}

// ---- Outbound builders ----------------------------------------------------

export function buildBoardSummaryPacket(boardSerial, posts) {
  // Sub 0x00: header — count + per-post summary (serial + subject + author).
  let total = 1 + 2 + 1 + 4 + 2; // op + len + sub + serial + count
  const subj = posts.map((p) => p.subject + '\0');
  const auth = posts.map((p) => p.author + '\0');
  for (let i = 0; i < posts.length; i++) {
    total += 4 + 2 + subj[i].length + 2 + auth[i].length;
  }
  const w = new PacketWriter(total);
  w.writeU8(0x71); w.writeU16(total);
  w.writeU8(0x00);
  w.writeU32(boardSerial >>> 0);
  w.writeU16(posts.length & 0xffff);
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    w.writeU32(p.serial >>> 0);
    w.writeU16(subj[i].length & 0xffff);
    for (let k = 0; k < subj[i].length; k++) w.writeU8(subj[i].charCodeAt(k) & 0x7f);
    w.writeU16(auth[i].length & 0xffff);
    for (let k = 0; k < auth[i].length; k++) w.writeU8(auth[i].charCodeAt(k) & 0x7f);
  }
  return w.bytes();
}

export function buildBoardBodyPacket(boardSerial, post) {
  const body = String(post.body ?? '') + '\0';
  const total = 1 + 2 + 1 + 4 + 4 + 2 + body.length;
  const w = new PacketWriter(total);
  w.writeU8(0x71); w.writeU16(total);
  w.writeU8(0x02);
  w.writeU32(boardSerial >>> 0);
  w.writeU32(post.serial >>> 0);
  w.writeU16(body.length & 0xffff);
  for (let i = 0; i < body.length; i++) w.writeU8(body.charCodeAt(i) & 0x7f);
  return w.bytes();
}

// ---- Inbound 0x71 dispatch ------------------------------------------------

/** Parse and route a 0x71 packet. Returns the action sub-byte or null. */
export function handleBulletinPacket(state, pkt) {
  const r = new PacketReader(pkt);
  r.readU8(); r.readU16();
  const action = r.readU8();
  const boardSerial = r.readU32();
  const board = _boards.get(boardSerial);
  if (!board) return null;
  switch (action) {
    case 0x03: { // new post (or reply when subject starts with "Re: ")
      const subjLen = r.readU16();
      let subject = ''; for (let i = 0; i < subjLen; i++) subject += String.fromCharCode(r.readU8() & 0x7f);
      r.readU8(); // null
      const bodyLen = r.readU16();
      let body = ''; for (let i = 0; i < bodyLen; i++) body += String.fromCharCode(r.readU8() & 0x7f);
      // Reply detection — when the subject is "Re: <existing>", look up
      // the parent post by exact subject match and link them. The first
      // line of the body may also carry "@parentSerial" (a hidden
      // marker the new client emits) — strip that and use as authoritative.
      let replyTo = 0;
      const m = body.match(/^@(\d+)\n/);
      if (m) {
        replyTo = parseInt(m[1], 10) >>> 0;
        body = body.slice(m[0].length);
      } else if (subject.startsWith('Re: ')) {
        const parent = board.posts.find((p) => p.subject === subject.slice(4));
        if (parent) replyTo = parent.serial;
      }
      const post = createPost(boardSerial, {
        subject, body, author: state.mobile?.name ?? 'unknown',
        replyTo,
      });
      // Notify the poster (their gump refreshes); broadcasting to all
      // open viewers is a job for the higher-level handler above this.
      state.send(buildBoardSummaryPacket(boardSerial, board.posts));
      return { action, post };
    }
    case 0x04: { // delete
      const postSerial = r.readU32();
      const idx = board.posts.findIndex((p) => p.serial === postSerial);
      if (idx >= 0) {
        // Author or staff only.
        const p = board.posts[idx];
        if (p.author === state.mobile?.name || state.mobile?.accessLevel >= 1) {
          board.posts.splice(idx, 1);
        }
      }
      state.send(buildBoardSummaryPacket(boardSerial, board.posts));
      return { action };
    }
    case 0x05: { // request body
      const postSerial = r.readU32();
      const post = board.posts.find((p) => p.serial === postSerial);
      if (post) state.send(buildBoardBodyPacket(boardSerial, post));
      return { action };
    }
    default:
      return null;
  }
}
