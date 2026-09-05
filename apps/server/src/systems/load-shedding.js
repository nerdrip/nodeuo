export class AdmissionController {
  constructor({ maxConnections = 4096, rejectPressure = .97 } = {}) {
    this.maxConnections = Math.max(1, maxConnections | 0);
    this.rejectPressure = Math.max(.5, Math.min(1, Number(rejectPressure) || .97));
    this.active = new Set();
    this.pressure = 0;
    this.stats = { accepted: 0, rejected: 0, released: 0, cosmeticDropped: 0 };
  }

  setPressure(value) {
    this.pressure = Math.max(0, Math.min(1, Number(value) || 0));
    return this.pressure;
  }

  acquire(id) {
    const key = String(id);
    if (this.active.has(key)) return true;
    if (this.active.size >= this.maxConnections || this.pressure >= this.rejectPressure) {
      this.stats.rejected++;
      return false;
    }
    this.active.add(key); this.stats.accepted++;
    return true;
  }

  release(id) {
    if (!this.active.delete(String(id))) return false;
    this.stats.released++;
    return true;
  }

  shouldDropCosmetic(pendingBytes = 0, softLimit = Infinity) {
    const drop = this.pressure >= .9 && Number(pendingBytes) > Math.max(0, Number(softLimit) || 0) * .5;
    if (drop) this.stats.cosmeticDropped++;
    return drop;
  }

  snapshot() {
    return { ...this.stats, active: this.active.size, pressure: this.pressure,
      maxConnections: this.maxConnections, rejectPressure: this.rejectPressure };
  }
}

export const runtimeAdmission = new AdmissionController({
  maxConnections: Number(process.env.UO_MAX_CONNECTIONS ?? 4096),
  rejectPressure: Number(process.env.UO_ADMISSION_REJECT_PRESSURE ?? .97),
});
