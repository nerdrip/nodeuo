// BulletinBoardGump — town message-board display + post composer.
//
// 0x71 protocol: variable-length packet with sub-actions:
//   0x00 BulletinBoard header (server → client): list metadata.
//   0x01 BulletinBoardMessage header (server → client): post summary.
//   0x02 BulletinBoardMessageBody (server → client): full post text.
//   0x03 NewMessage (client → server): submit a new post.
//   0x04 RemoveMessage (client → server): delete (own/admin).
//   0x05 RequestMessage (client → server): expand a summary into the body.
//
// We ship two builders below + this gump. Server-side dispatch lives in
// `apps/server/src/systems/bulletin-board.js`.

import { WindowGump } from './window-gump.js';
import { Label } from '../controls/label.js';
import { ScrollArea } from '../controls/scroll-area.js';
import { TextInput } from '../controls/text-input.js';
import { Button, ButtonAction } from '../controls/button.js';
import { net } from '../../net/net-client.js';
import { PacketWriter } from '@uo/protocol';
import { bus } from '../../core/event-bus.js';

function buildBulletinPost(boardSerial, subject, body, replyTo = 0) {
  const subj = String(subject ?? '');
  // Embed reply marker as first line of the body — the server strips
  // `@<serial>\n` before storing. Backward-compatible with old clients
  // that don't include it (server treats the post as a top-level entry).
  const ascii = (replyTo ? `@${replyTo >>> 0}\n` : '') + String(body ?? '');
  const total = 1 + 2 + 1 + 4 + 2 + subj.length + 1 + 2 + ascii.length + 1;
  const w = new PacketWriter(total);
  w.writeU8(0x71); w.writeU16(total);
  w.writeU8(0x03);                       // action = new message
  w.writeU32(boardSerial >>> 0);
  w.writeU16(subj.length & 0xffff);
  for (let i = 0; i < subj.length; i++) w.writeU8(subj.charCodeAt(i) & 0x7f);
  w.writeU8(0);
  w.writeU16(ascii.length & 0xffff);
  for (let i = 0; i < ascii.length; i++) w.writeU8(ascii.charCodeAt(i) & 0x7f);
  w.writeU8(0);
  return w.bytes();
}

function buildBulletinRequest(boardSerial, postSerial) {
  const w = new PacketWriter(10);
  w.writeU8(0x71); w.writeU16(10);
  w.writeU8(0x05);
  w.writeU32(boardSerial >>> 0);
  w.writeU32(postSerial >>> 0);
  return w.bytes();
}

function buildBulletinDelete(boardSerial, postSerial) {
  const w = new PacketWriter(10);
  w.writeU8(0x71); w.writeU16(10);
  w.writeU8(0x04);
  w.writeU32(boardSerial >>> 0);
  w.writeU32(postSerial >>> 0);
  return w.bytes();
}

export class BulletinBoardGump extends WindowGump {
  constructor(boardSerial, title = 'Bulletin Board') {
    super({ title, width: 420, height: 360, x: 200, y: 130 });
    this.boardSerial = boardSerial >>> 0;
    /** @type {Array<{serial:number, subject:string, author:string, body?:string}>} */
    this.posts = [];

    this._scroll = new ScrollArea({ width: 396, height: 220 });
    this.addContent(this._scroll, 12, 30);

    // Composer.
    this._compSubj = new TextInput({ width: 180, height: 22, multiLine: false, maxLength: 60, placeholder: 'Subject' });
    this.addContent(this._compSubj, 12, 260);
    this._compBody = new TextInput({ width: 250, height: 22, multiLine: true, maxLength: 512, placeholder: 'Message' });
    this.addContent(this._compBody, 12, 290);
    const post = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 60, height: 22, label: 'Post', action: ButtonAction.Activate,
    });
    post.setPosition(280, 290);
    post.onClick = () => {
      const s = this._compSubj.value, b = this._compBody.value;
      if (!s || !b) return;
      net.send(buildBulletinPost(this.boardSerial, s, b, this._replyTo ?? 0));
      this._compSubj.setValue(''); this._compBody.setValue('');
      this._replyTo = 0;
      if (this._replyHint) this._replyHint.setText?.('');
    };
    this.add(post);

    // Reply / Delete buttons next to the Post button.
    const reply = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 60, height: 22, label: 'Reply', action: ButtonAction.Activate,
    });
    reply.setPosition(345, 290);
    reply.onClick = () => {
      // Use the currently-selected post (subject pre-populated in
      // _showBody) as the parent. We mark `_replyTo` and prefix the
      // subject with "Re: " so the user knows the next Post will be
      // a child message.
      const sel = this._lastViewedSerial ?? 0;
      if (!sel) return;
      this._replyTo = sel;
      if (this._compSubj.value && !this._compSubj.value.startsWith('Re: ')) {
        this._compSubj.setValue?.(`Re: ${this._compSubj.value}`);
      }
      this._replyHint?.setText?.(`replying to #${sel}`);
    };
    this.add(reply);

    const del = new Button({
      normalGumpId: 0x0481, pressedGumpId: 0x0482,
      width: 60, height: 22, label: 'Delete', action: ButtonAction.Activate,
    });
    del.setPosition(345, 260);
    del.onClick = () => {
      const sel = this._lastViewedSerial ?? 0;
      if (!sel) return;
      net.send(buildBulletinDelete(this.boardSerial, sel));
      this._lastViewedSerial = 0;
    };
    this.add(del);

    this._replyHint = new Label('', { fontSize: 10, hue: 0xa08868 });
    this._replyHint.setPosition(280, 320);
    this.add(this._replyHint);

    this._unsubs = [
      bus.on('bbs:posts',   (info) => { if (info.boardSerial === this.boardSerial) this._onPosts(info.posts); }),
      bus.on('bbs:body',    (info) => { if (info.boardSerial === this.boardSerial) this._inflateBody(info); }),
    ];
  }

  get type() { return `bulletin:${this.boardSerial}`; }
  get positionKey() { return 'bulletin'; }

  dispose() { for (const u of this._unsubs) u(); super.dispose(); }

  _onPosts(posts) {
    this.posts = posts;
    this._renderList();
  }

  _renderList() {
    // Drop existing rows.
    if (this._rows) for (const r of this._rows) r.dispose?.();
    this._rows = [];

    // Build a thread tree: top-level posts first, then their replies
    // immediately below indented +14px. Server stores `replyTo` on the
    // post when the body started with `@<serial>\n` marker — we can
    // safely reorder client-side by walking the parent chain.
    const byId = new Map(this.posts.map((p) => [p.serial, p]));
    const ordered = [];
    const seen = new Set();
    const walk = (post, depth) => {
      if (!post || seen.has(post.serial)) return;
      seen.add(post.serial);
      ordered.push({ post, depth });
      // Direct children, sorted by serial ascending (chronological).
      const kids = this.posts
        .filter((p) => (p.replyTo | 0) === post.serial)
        .sort((a, b) => a.serial - b.serial);
      for (const k of kids) walk(k, depth + 1);
    };
    // Roots = posts whose parent is missing or 0.
    for (const p of this.posts) {
      if ((p.replyTo | 0) === 0 || !byId.has(p.replyTo | 0)) walk(p, 0);
    }
    // Orphan reply (parent purged) — append at depth 0 so they're not lost.
    for (const p of this.posts) if (!seen.has(p.serial)) walk(p, 0);

    let y = 0;
    for (const { post: p, depth } of ordered) {
      const indent = depth * 14;
      const prefix = depth > 0 ? '↳ ' : '';
      const hue = depth === 0 ? 0xfff0c0 : (depth === 1 ? 0xc0c0a0 : 0xa09080);
      const row = new Label(`${prefix}${p.subject} — ${p.author || 'unknown'}`,
        { fontSize: 11, hue });
      row.setPosition(indent, y);
      row.acceptMouseInput = true;
      row.onClick = () => {
        if (!p.body) net.send(buildBulletinRequest(this.boardSerial, p.serial));
        else this._showBody(p);
      };
      this._scroll.add(row);
      this._rows.push(row);
      y += 16;
    }
    this._scroll.setContentSize?.(380, y);
  }

  _inflateBody({ postSerial, body }) {
    const p = this.posts.find((x) => x.serial === postSerial);
    if (!p) return;
    p.body = body;
    this._showBody(p);
  }

  _showBody(p) {
    // Quick "modal" — re-use QuestionGump-like inline window via the
    // composer textbox so we don't ship another gump file. Mark the
    // selected post serial so Reply/Delete know what to operate on.
    this._compSubj.setValue(p.subject);
    this._compBody.setValue(p.body ?? '');
    this._lastViewedSerial = p.serial;
  }
}
