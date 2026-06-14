import { describe, expect, it, vi } from 'vitest';

import { buildHandlers } from '../src/net/handlers.js';
import { Stage } from '../src/net/net-state.js';
import { SKILL_TO_COMMAND } from '../src/net/skill-actions.js';

function writeU16(buf, off, value) {
  buf[off] = (value >>> 8) & 0xff;
  buf[off + 1] = value & 0xff;
}

function writeU32(buf, off, value) {
  buf[off] = (value >>> 24) & 0xff;
  buf[off + 1] = (value >>> 16) & 0xff;
  buf[off + 2] = (value >>> 8) & 0xff;
  buf[off + 3] = value & 0xff;
}

function statusRequest(serial, kind = 5) {
  const pkt = new Uint8Array(10);
  pkt[0] = 0x34;
  pkt[1] = 0xED; pkt[2] = 0xED; pkt[3] = 0xED; pkt[4] = 0xED;
  pkt[5] = kind & 0xff;
  writeU32(pkt, 6, serial >>> 0);
  return pkt;
}

function skillLockPacket(clientSkillId, lock) {
  const pkt = new Uint8Array(6);
  pkt[0] = 0x3A;
  writeU16(pkt, 1, 6);
  writeU16(pkt, 3, clientSkillId);
  pkt[5] = lock & 0xff;
  return pkt;
}

function useSkillPacket(skillId) {
  const text = `${skillId} 0`;
  const pkt = new Uint8Array(5 + text.length);
  pkt[0] = 0x12;
  writeU16(pkt, 1, pkt.length);
  pkt[3] = 0x24;
  for (let i = 0; i < text.length; i++) pkt[4 + i] = text.charCodeAt(i);
  pkt[pkt.length - 1] = 0;
  return pkt;
}

function readSkillsPacket(pkt) {
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  const type = pkt[3] | 0;
  const withCaps = type === 0x02 || type === 0xDF;
  const single = type === 0xFF || type === 0xDF;
  const entries = [];
  let off = 4;
  while (off + 1 < pkt.length) {
    const id = dv.getUint16(off); off += 2;
    if (id === 0) break;
    const value = dv.getUint16(off); off += 2;
    const base = dv.getUint16(off); off += 2;
    const lock = pkt[off++];
    let cap = 1000;
    if (withCaps) { cap = dv.getUint16(off); off += 2; }
    entries.push({ id, value, base, lock, cap });
    if (single) break;
  }
  return { type, entries };
}

describe('skill wire parity', () => {
  it('sends full skill snapshots with canonical 1-based ids, values, caps and locks', () => {
    const handlers = buildHandlers();
    const sent = [];
    const mobile = {
      serial: 0x100001,
      skills: { 1: 25, 8: 50, 26: 100 },
      skillCaps: { 26: 120 },
      skillLocks: { 8: 'down', 26: 'locked' },
    };
    const state = {
      stage: Stage.InWorld,
      mobile,
      ctx: { world: { mobiles: new Map([[mobile.serial, mobile]]) } },
      send: (pkt) => sent.push(pkt),
    };

    handlers[0x34](state, statusRequest(mobile.serial, 5));

    expect(sent).toHaveLength(1);
    const { type, entries } = readSkillsPacket(sent[0]);
    expect(type).toBe(0x02);
    expect(entries).toHaveLength(58);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    expect(byId.get(1)).toMatchObject({ value: 250, base: 250, lock: 0, cap: 1000 });
    expect(byId.get(8)).toMatchObject({ value: 500, base: 500, lock: 1, cap: 1000 });
    expect(byId.get(26)).toMatchObject({ value: 1000, base: 1000, lock: 2, cap: 1200 });
  });

  it('stores skill locks on canonical ids and echoes the changed skill', () => {
    const handlers = buildHandlers();
    const sent = [];
    const mobile = {
      serial: 0x100002,
      skills: { 26: 100 },
      skillCaps: { 26: 120 },
    };
    const state = {
      stage: Stage.InWorld,
      mobile,
      send: (pkt) => sent.push(pkt),
    };

    handlers[0x3A](state, skillLockPacket(25, 1));

    expect(mobile.skillLocks[26]).toBe('down');
    expect(sent).toHaveLength(1);
    const { type, entries } = readSkillsPacket(sent[0]);
    expect(type).toBe(0xDF);
    expect(entries).toEqual([
      { id: 26, value: 1000, base: 1000, lock: 1, cap: 1200 },
    ]);
  });

  it.each(Object.entries(SKILL_TO_COMMAND).map(([skillId, command]) => [Number(skillId), command]))(
    'routes UseSkill %i to %s',
    (skillId, expectedCommand) => {
      const handlers = buildHandlers();
      const dispatch = vi.fn(() => true);
      const state = {
        stage: Stage.InWorld,
        mobile: { serial: 0x100003 },
        ctx: {
          world: {},
          commands: { dispatch },
        },
        sendSystemMessage: vi.fn(),
      };

      handlers[0x12](state, useSkillPacket(skillId));

      expect(dispatch).toHaveBeenCalledWith(expectedCommand, {
        sender: state.mobile,
        state,
        world: state.ctx.world,
      });
    },
  );

  it.each([6, 26, 27, 28, 32, 41, 42, 43, 44, 50, 51, 52, 53, 54, 55, 56, 58])(
    'does not dispatch passive UseSkill %i',
    (skillId) => {
      const handlers = buildHandlers();
      const dispatch = vi.fn(() => true);
      const sendSystemMessage = vi.fn();
      const state = {
        stage: Stage.InWorld,
        mobile: { serial: 0x100004 },
        ctx: {
          world: {},
          commands: { dispatch },
        },
        sendSystemMessage,
      };

      handlers[0x12](state, useSkillPacket(skillId));

      expect(dispatch).not.toHaveBeenCalled();
      expect(sendSystemMessage).toHaveBeenCalledWith(
        `Skill ${skillId} is passive — it trains during combat or use.`,
      );
    },
  );
});
