import { describe, expect, it } from 'vitest';
import {
  extNodeUOCapabilities,
  extNodeUOMovementHint,
  extNodeUOSpellComposer,
  extNodeUOSpecialization,
  extNodeUOCooldown,
  extNodeUONaval,
  extNodeUOHouseTools,
  NODEUO_CAPABILITIES_CURRENT,
  NODEUO_EXT_SUBCOMMAND,
  NODEUO_PROTOCOL_MAJOR,
  NodeUOCapability,
  NodeUOCapabilityMessage,
  NodeUOSpellComposerMessage,
  NodeUOSpecializationMessage,
  NodeUOCooldownMessage,
  NodeUONavalMessage,
  NodeUOHouseToolsMessage,
} from '../src/index.js';

describe('NodeUO capability envelope', () => {
  it('encodes a versioned offer in the private extended-command namespace', () => {
    const pkt = extNodeUOCapabilities();
    expect(pkt.length).toBe(13);
    expect(Array.from(pkt.subarray(0, 9))).toEqual([
      0xBF, 0x00, 0x0D,
      (NODEUO_EXT_SUBCOMMAND >>> 8) & 0xff, NODEUO_EXT_SUBCOMMAND & 0xff,
      NodeUOCapabilityMessage.Offer, NODEUO_PROTOCOL_MAJOR, 0, 0,
    ]);
    const mask = ((pkt[9] << 24) | (pkt[10] << 16) | (pkt[11] << 8) | pkt[12]) >>> 0;
    expect(mask).toBe(NODEUO_CAPABILITIES_CURRENT);
    expect(mask & NodeUOCapability.SpellComposer).toBe(NodeUOCapability.SpellComposer);
  });

  it('can accept only the intersection selected by a client', () => {
    const selected = NodeUOCapability.RichGumps | NodeUOCapability.SpawnPalette;
    const pkt = extNodeUOCapabilities({
      kind: NodeUOCapabilityMessage.Accept,
      capabilities: selected,
    });
    expect(pkt[5]).toBe(NodeUOCapabilityMessage.Accept);
    const mask = ((pkt[9] << 24) | (pkt[10] << 16) | (pkt[11] << 8) | pkt[12]) >>> 0;
    expect(mask).toBe(selected);
  });

  it('encodes an encumbrance pacing hint without JSON overhead', () => {
    const pkt = extNodeUOMovementHint({
      weight: 342, capacity: 300, paceMultiplier: 1.6,
      staminaCost: 12, overloaded: true,
    });
    expect(pkt.length).toBe(13);
    expect(Array.from(pkt.subarray(5))).toEqual([
      0x01, 0x56, 0x01, 0x2C, 0x06, 0x40, 0x0C, 0x01,
    ]);
  });

  it('encodes a bounded spell-composer JSON envelope', () => {
    const pkt = extNodeUOSpellComposer({
      kind: NodeUOSpellComposerMessage.Save,
      requestId: 42,
      payload: { name: 'Arc Flash', mana: 12 },
    });
    expect(pkt[5]).toBe(NodeUOSpellComposerMessage.Save);
    expect(Array.from(pkt.subarray(6, 10))).toEqual([0, 0, 0, 42]);
    const len = (pkt[10] << 8) | pkt[11];
    expect(JSON.parse(new TextDecoder().decode(pkt.subarray(12, 12 + len))))
      .toEqual({ name: 'Arc Flash', mana: 12 });
  });

  it('encodes a bounded specialization JSON envelope', () => {
    const pkt = extNodeUOSpecialization({
      kind: NodeUOSpecializationMessage.Allocate,
      requestId: 42,
      payload: { nodeId: 'mana-flow' },
    });
    expect(pkt[5]).toBe(NodeUOSpecializationMessage.Allocate);
    expect(Array.from(pkt.subarray(6, 10))).toEqual([0, 0, 0, 42]);
    const len = (pkt[10] << 8) | pkt[11];
    expect(JSON.parse(new TextDecoder().decode(pkt.subarray(12, 12 + len))))
      .toEqual({ nodeId: 'mana-flow' });
  });

  it('encodes a server-authoritative cooldown envelope', () => {
    const pkt = extNodeUOCooldown({
      kind: NodeUOCooldownMessage.Start,
      requestId: 7,
      payload: { id: 'spell:7', durationMs: 1250 },
    });
    expect(pkt[5]).toBe(NodeUOCooldownMessage.Start);
    const len = (pkt[10] << 8) | pkt[11];
    expect(JSON.parse(new TextDecoder().decode(pkt.subarray(12, 12 + len))))
      .toEqual({ id: 'spell:7', durationMs: 1250 });
  });

  it('keeps naval visualization inside the negotiated private envelope', () => {
    const pkt = extNodeUONaval({
      kind: NodeUONavalMessage.ShowRange,
      requestId: 9,
      payload: { boatSerial: 0x40000001, cannons: [{ dx: 1, dy: 0, range: 18 }] },
    });
    expect(pkt[5]).toBe(NodeUONavalMessage.ShowRange);
    const len = (pkt[10] << 8) | pkt[11];
    expect(JSON.parse(new TextDecoder().decode(pkt.subarray(12, 12 + len))))
      .toMatchObject({ boatSerial: 0x40000001 });
    expect(NODEUO_CAPABILITIES_CURRENT & NodeUOCapability.NavalPreview)
      .toBe(NodeUOCapability.NavalPreview);
  });

  it('encodes rich house tools without changing standard 0xD7', () => {
    const pkt = extNodeUOHouseTools({
      kind: NodeUOHouseToolsMessage.Copy,
      requestId: 10,
      payload: { x1: 10, y1: 10, x2: 20, y2: 20 },
    });
    expect(pkt[0]).toBe(0xBF);
    expect(pkt[5]).toBe(NodeUOHouseToolsMessage.Copy);
    expect(NODEUO_CAPABILITIES_CURRENT & NodeUOCapability.HouseTools)
      .toBe(NodeUOCapability.HouseTools);
  });
});
