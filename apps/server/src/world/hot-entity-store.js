function nextCapacity(value) {
  let capacity = 64;
  while (capacity < value) capacity *= 2;
  return capacity;
}

/** Dense structure-of-arrays view of fields used by movement, AI and AOI.
 * Rich script objects remain authoritative; this registry removes property
 * chasing from numeric scans without changing the scripting API. */
export class HotEntityStore {
  constructor(capacity = 1024) {
    this.capacity = nextCapacity(capacity);
    this.length = 0;
    this.slotBySerial = new Map();
    this._allocate(this.capacity);
    this.stats = { upserts: 0, removals: 0, grows: 0 };
  }

  _allocate(capacity, previous = null) {
    const fields = {
      serial: Uint32Array, x: Int16Array, y: Int16Array, z: Int16Array,
      map: Uint8Array, direction: Uint8Array, flags: Uint8Array,
      notoriety: Uint8Array, body: Uint16Array, hue: Uint16Array,
      hp: Int32Array, hpMax: Int32Array, mana: Int32Array, manaMax: Int32Array,
      stamina: Int32Array, staminaMax: Int32Array,
      combatant: Uint32Array, controlMaster: Uint32Array,
      stateBits: Uint8Array,
    };
    for (const [name, Type] of Object.entries(fields)) {
      const next = new Type(capacity);
      if (previous?.[name]) next.set(previous[name].subarray(0, this.length));
      this[name] = next;
    }
  }

  _grow(required) {
    if (required <= this.capacity) return;
    const previous = Object.fromEntries(['serial', 'x', 'y', 'z', 'map', 'direction', 'flags',
      'notoriety', 'body', 'hue', 'hp', 'hpMax', 'mana', 'manaMax', 'stamina', 'staminaMax',
      'combatant', 'controlMaster', 'stateBits'].map((name) => [name, this[name]]));
    this.capacity = nextCapacity(required);
    this._allocate(this.capacity, previous);
    this.stats.grows++;
  }

  upsert(mobile) {
    const serial = Number(mobile?.serial) >>> 0;
    if (!serial) return -1;
    let slot = this.slotBySerial.get(serial);
    if (slot == null) {
      this._grow(this.length + 1);
      slot = this.length++;
      this.slotBySerial.set(serial, slot);
    }
    this.serial[slot] = serial;
    this.x[slot] = mobile.x | 0; this.y[slot] = mobile.y | 0; this.z[slot] = mobile.z | 0;
    this.map[slot] = mobile.map | 0; this.direction[slot] = mobile.direction | 0;
    this.flags[slot] = mobile.flags | 0; this.notoriety[slot] = mobile.notoriety | 0;
    this.body[slot] = mobile.body | 0; this.hue[slot] = mobile.hue | 0;
    this.hp[slot] = mobile.hp | 0; this.hpMax[slot] = mobile.hpMax | 0;
    this.mana[slot] = mobile.mana | 0; this.manaMax[slot] = mobile.manaMax | 0;
    this.stamina[slot] = mobile.stam | 0; this.staminaMax[slot] = mobile.stamMax | 0;
    this.combatant[slot] = mobile.combatant >>> 0;
    this.controlMaster[slot] = mobile.controlMaster >>> 0;
    this.stateBits[slot] = (mobile.client ? 1 : 0) | (mobile.isPlayer ? 2 : 0)
      | (mobile.mounted ? 4 : 0) | ((mobile.hp ?? 1) <= 0 ? 8 : 0);
    this.stats.upserts++;
    return slot;
  }

  updatePosition(mobile) {
    const serial = Number(mobile?.serial) >>> 0;
    const slot = this.slotBySerial.get(serial);
    if (slot == null) return this.upsert(mobile);
    this.x[slot] = mobile.x | 0; this.y[slot] = mobile.y | 0; this.z[slot] = mobile.z | 0;
    this.map[slot] = mobile.map | 0; this.direction[slot] = mobile.direction | 0;
    this.stats.upserts++;
    return slot;
  }

  updateVitals(mobile) {
    const serial = Number(mobile?.serial) >>> 0;
    const slot = this.slotBySerial.get(serial);
    if (slot == null) return this.upsert(mobile);
    this.hp[slot] = mobile.hp | 0; this.hpMax[slot] = mobile.hpMax | 0;
    this.mana[slot] = mobile.mana | 0; this.manaMax[slot] = mobile.manaMax | 0;
    this.stamina[slot] = mobile.stam | 0; this.staminaMax[slot] = mobile.stamMax | 0;
    this.flags[slot] = mobile.flags | 0;
    this.combatant[slot] = mobile.combatant >>> 0;
    this.stateBits[slot] = (mobile.client ? 1 : 0) | (mobile.isPlayer ? 2 : 0)
      | (mobile.mounted ? 4 : 0) | ((mobile.hp ?? 1) <= 0 ? 8 : 0);
    this.stats.upserts++;
    return slot;
  }

  remove(serialLike) {
    const serial = Number(serialLike) >>> 0;
    const slot = this.slotBySerial.get(serial);
    if (slot == null) return false;
    const last = --this.length;
    this.slotBySerial.delete(serial);
    if (slot !== last) {
      const movedSerial = this.serial[last];
      for (const name of ['serial', 'x', 'y', 'z', 'map', 'direction', 'flags',
        'notoriety', 'body', 'hue', 'hp', 'hpMax', 'mana', 'manaMax', 'stamina', 'staminaMax',
        'combatant', 'controlMaster', 'stateBits']) this[name][slot] = this[name][last];
      this.slotBySerial.set(movedSerial, slot);
    }
    this.stats.removals++;
    return true;
  }

  get(serialLike) {
    const slot = this.slotBySerial.get(Number(serialLike) >>> 0);
    if (slot == null) return null;
    return { serial: this.serial[slot], x: this.x[slot], y: this.y[slot], z: this.z[slot],
      map: this.map[slot], direction: this.direction[slot], flags: this.flags[slot],
      notoriety: this.notoriety[slot], body: this.body[slot], hue: this.hue[slot],
      hp: this.hp[slot], hpMax: this.hpMax[slot], mana: this.mana[slot], manaMax: this.manaMax[slot],
      stam: this.stamina[slot], stamMax: this.staminaMax[slot], combatant: this.combatant[slot],
      controlMaster: this.controlMaster[slot], stateBits: this.stateBits[slot] };
  }

  rebuild(mobiles) {
    this.length = 0; this.slotBySerial.clear();
    for (const mobile of mobiles?.values?.() ?? mobiles ?? []) this.upsert(mobile);
    return this.snapshot();
  }

  snapshot() { return { size: this.length, capacity: this.capacity, ...this.stats }; }
}
