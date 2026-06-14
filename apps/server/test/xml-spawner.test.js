import { describe, expect, it } from 'vitest';
import { World } from '../src/world/world.js';
import { Spawner } from '../src/spawner.js';
import {
  applySpawnDirectives,
  parseXmlObjectSpec,
} from '../src/systems/xml-spawner.js';
import { dispatch as dispatchXmlAttachment } from '../src/systems/world/xml-attachments.js';

describe('XmlSpawner runtime parity', () => {
  it('parses ServUO object strings into properties, attachments and actions', () => {
    const spec = parseXmlObjectSpec('Orc/Name/Dread guard/Hue/1150/ATTACH/XmlStr,5/MSG/hello');

    expect(spec.typeName).toBe('Orc');
    expect(spec.props).toMatchObject({ name: 'Dread guard', hue: 1150 });
    expect(spec.attachments).toMatchObject([{ type: 'str', opts: { amount: 5 } }]);
    expect(spec.actions).toMatchObject([{ type: 'message', text: 'hello' }]);
  });

  it('applies spawn directives and dispatches persisted attachment hooks', () => {
    const world = new World();
    const mob = world.createMobile({ name: 'orc', hp: 20, hpMax: 50, str: 10 });
    const attacker = world.createMobile({ name: 'attacker', hp: 100, hpMax: 100 });
    const messages = [];
    attacker.client = { sendSystemMessage: (msg) => messages.push(msg) };

    applySpawnDirectives(mob, {
      world,
      trigMob: attacker,
      entry: {
        raw: 'Orc/Name/Dread guard/Hue/1150/ATTACH/XmlStr,5/ATTACH/XmlLifeDrain,pct=0.20/MSG/hello',
      },
    });

    expect(mob.name).toBe('Dread guard');
    expect(mob.hue).toBe(1150);
    expect(mob.str).toBe(15);
    expect(messages).toEqual(['hello']);

    // Simulate a save/load round trip where JSON kept only data, not methods.
    mob._xmlAttach['life-drain'] = JSON.parse(JSON.stringify(mob._xmlAttach['life-drain']));
    dispatchXmlAttachment(mob, 'onAttacked', { attacker });
    expect(attacker.hp).toBe(80);
    expect(mob.hp).toBe(40);
  });

  it('lets Spawner entries carry raw XmlSpawner metadata', () => {
    const world = new World();
    const created = [];
    const spawner = new Spawner(world, (w, kind, pos) => {
      const mob = w.createMobile({ kind, name: kind, x: pos.x, y: pos.y, z: pos.z, map: pos.map });
      created.push(mob);
      return mob;
    });
    spawner.add({
      id: 'xml-meta',
      map: 1,
      rect: { x1: 10, y1: 10, x2: 10, y2: 10 },
      maxCount: 1,
      respawnMs: [0, 0],
      kinds: [{ kind: 'orc', weight: 1, raw: 'Orc/Name/Dread guard/Z/9/ATTACH/XmlHue,hue=1153' }],
    });

    spawner.tick(Date.now() + 1);

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      kind: 'orc',
      name: 'Dread guard',
      z: 9,
      hue: 1153,
    });
    expect(created[0]._xmlAttach?.hue?.type).toBe('hue');
  });
});
