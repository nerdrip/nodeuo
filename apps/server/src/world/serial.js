// Monotonic serial allocator.
//
// UO serials:
//   - Mobile serials: 0x00000001 .. 0x3FFFFFFF
//   - Item serials:   0x40000000 .. 0x7FFFFFFF
//   - 0xFFFFFFFF is reserved as "no target" / broadcast
//
// On load from save, the allocator is seeded with (maxExistingSerial + 1).

export class SerialAllocator {
  constructor() {
    this.nextMobile = 0x00000001;
    this.nextItem   = 0x40000000;
  }

  allocMobile() {
    if (this.nextMobile >= 0x40000000) throw new Error('Mobile serial space exhausted');
    return this.nextMobile++;
  }

  allocItem() {
    if (this.nextItem >= 0x80000000) throw new Error('Item serial space exhausted');
    return this.nextItem++;
  }

  observe(serial) {
    const s = serial >>> 0;
    if (s < 0x40000000) {
      if (s >= this.nextMobile) this.nextMobile = s + 1;
    } else if (s < 0x80000000) {
      if (s >= this.nextItem) this.nextItem = s + 1;
    }
  }
}

export function isMobileSerial(serial) { return (serial >>> 0) < 0x40000000; }
export function isItemSerial(serial)   { const s = serial >>> 0; return s >= 0x40000000 && s < 0x80000000; }
