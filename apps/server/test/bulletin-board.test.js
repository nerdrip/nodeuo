import { describe, it, expect } from 'vitest';
import { PacketWriter } from '@uo/protocol';
import {
  getBoard, createPost, handleBulletinPacket,
  buildBoardSummaryPacket, buildBoardBodyPacket,
} from '../src/systems/bulletin-board.js';

const fakeState = (mobile) => {
  const sent = [];
  return {
    mobile,
    send(b) { sent.push(b); },
    sentPackets: sent,
  };
};

describe('bulletin-board', () => {
  it('createPost adds to head, caps at 50', () => {
    const board = getBoard(7000);
    board.posts.length = 0;
    for (let i = 0; i < 60; i++) {
      createPost(7000, { subject: `s${i}`, author: 'me', body: `b${i}` });
    }
    expect(board.posts.length).toBe(50);
    expect(board.posts[0].subject).toBe('s59'); // newest first
  });

  it('summary packet round-trip', () => {
    const board = getBoard(8000);
    board.posts.length = 0;
    createPost(8000, { subject: 'hello', author: 'alice', body: 'world' });
    const pkt = buildBoardSummaryPacket(8000, board.posts);
    expect(pkt[0]).toBe(0x71);
    expect(pkt[3]).toBe(0x00); // sub
    // Length matches header u16.
    const len = (pkt[1] << 8) | pkt[2];
    expect(len).toBe(pkt.length);
  });

  it('body packet shape', () => {
    const board = getBoard(8500);
    board.posts.length = 0;
    const post = createPost(8500, { subject: 'hi', author: 'bob', body: 'longer text here' });
    const pkt = buildBoardBodyPacket(8500, post);
    expect(pkt[0]).toBe(0x71);
    expect(pkt[3]).toBe(0x02);
    const len = (pkt[1] << 8) | pkt[2];
    expect(len).toBe(pkt.length);
  });

  it('handleBulletinPacket new-post action stores + replies summary', () => {
    const board = getBoard(9000);
    board.posts.length = 0;
    const state = fakeState({ name: 'tester' });

    // Build inbound 0x71 0x03 the same way the client builder does:
    //   subjLen(2) + subject ASCII (no null) + null(1) + bodyLen(2) + body + null(1)
    const subj = 'subj', body = 'body';
    const total = 1 + 2 + 1 + 4 + 2 + subj.length + 1 + 2 + body.length + 1;
    const w = new PacketWriter(total);
    w.writeU8(0x71); w.writeU16(total);
    w.writeU8(0x03); w.writeU32(9000);
    w.writeU16(subj.length);
    for (const c of subj) w.writeU8(c.charCodeAt(0));
    w.writeU8(0);
    w.writeU16(body.length);
    for (const c of body) w.writeU8(c.charCodeAt(0));
    w.writeU8(0);

    const r = handleBulletinPacket(state, w.bytes());
    expect(r.action).toBe(0x03);
    expect(board.posts.length).toBe(1);
    expect(board.posts[0].subject).toBe('subj');
    expect(board.posts[0].author).toBe('tester');
    // Server replied with a summary packet.
    expect(state.sentPackets.length).toBe(1);
    expect(state.sentPackets[0][0]).toBe(0x71);
  });

  it('handleBulletinPacket request-body returns body packet', () => {
    const board = getBoard(9100);
    board.posts.length = 0;
    const post = createPost(9100, { subject: 's', author: 'me', body: 'big content' });
    const state = fakeState({ name: 'reader' });

    const w = new PacketWriter(10);
    w.writeU8(0x71); w.writeU16(10);
    w.writeU8(0x05); w.writeU32(9100); w.writeU32(post.serial);

    const r = handleBulletinPacket(state, w.bytes());
    expect(r.action).toBe(0x05);
    expect(state.sentPackets.length).toBe(1);
    expect(state.sentPackets[0][3]).toBe(0x02); // body sub
  });
});
