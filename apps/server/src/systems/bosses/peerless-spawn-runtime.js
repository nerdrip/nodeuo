function randomNear(boss) {
  return {
    x: boss.x + Math.floor(Math.random() * 5) - 2,
    y: boss.y + Math.floor(Math.random() * 5) - 2,
    z: boss.z,
    map: boss.map,
  };
}

/** Build the peerless add factory without growing the server orchestrator. */
export function createPeerlessAddSpawner({ world, protocol, query, monsters, ai, spawnKind }) {
  function broadcast(mob) {
    const incoming = protocol.mobileIncoming({
      serial: mob.serial, body: mob.body, x: mob.x, y: mob.y, z: mob.z,
      direction: mob.direction, hue: mob.hue, flags: mob.flags,
      notoriety: mob.notoriety, equipment: [],
    });
    const health = protocol.healthUpdate?.({
      serial: mob.serial,
      current: mob.hp ?? mob.hpMax ?? 1,
      max: mob.hpMax ?? mob.hp ?? 1,
    });
    for (const other of query.clientsNear(mob, 18)) {
      other.client.send(incoming);
      if (health) other.client.send(health);
    }
  }

  return function spawnPeerlessAddNear(boss, spec) {
    const pos = randomNear(boss);
    if (typeof spec === 'string') return spawnKind?.(spec, pos) ?? null;
    if (!spec || typeof spec !== 'object') return null;
    const cfg = spec.kind ? monsters.get(spec.kind) : null;
    const mob = world.createMobile({
      name: spec.name ?? cfg?.name ?? 'a summoned creature',
      body: spec.body ?? cfg?.body ?? 0x0190,
      hue: spec.hue ?? cfg?.hue ?? 0,
      x: pos.x, y: pos.y, z: pos.z, map: pos.map,
      notoriety: spec.notoriety ?? cfg?.notoriety ?? 6,
      hp: spec.hp ?? cfg?.hp ?? 50,
      hpMax: spec.hpMax ?? spec.hp ?? cfg?.hp ?? 50,
      str: spec.str ?? cfg?.str ?? 50,
      dex: spec.dex ?? cfg?.dex ?? 50,
      int: spec.int ?? cfg?.int ?? 50,
      mana: spec.mana ?? cfg?.mana ?? cfg?.manaMax ?? 50,
      manaMax: spec.manaMax ?? cfg?.manaMax ?? spec.mana ?? 50,
    });
    Object.assign(mob, spec);
    mob.x = pos.x; mob.y = pos.y; mob.z = pos.z; mob.map = pos.map;
    if (spec.kind) mob.kind = spec.kind;
    mob.homeX = pos.x; mob.homeY = pos.y;
    const desiredAi = spec.ai ?? cfg?.ai ?? 'aggressive';
    const behavior = ai.behaviors.has(desiredAi) ? desiredAi
      : (ai.behaviors.has('aggressive') ? 'aggressive' : null);
    if (behavior) {
      mob.aiBehavior = behavior;
      try {
        ai.attach(mob, behavior, {
          targetSerial: 0, nextAttackAt: 0, nextStepAt: 0, nextCastAt: 0,
          home: { x: mob.x, y: mob.y }, kind: mob.kind,
        });
      } catch { /* advisory */ }
    }
    broadcast(mob);
    return mob;
  };
}
