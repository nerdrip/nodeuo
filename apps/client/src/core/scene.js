// Abstract scene base. Mirrors ClassicUO's Scene (Game/Scenes/Scene.cs).
// A scene owns Pixi containers for world + UI, receives ticker updates,
// and handles its own load/unload lifecycle.

export class Scene {
  /** @param {import('./game-controller.js').GameController} gc */
  constructor(gc) {
    this.gc = gc;
    this.loaded = false;
  }

  /** Called once when entering the scene. Override to init pixi state. */
  async load() { this.loaded = true; }

  /** Called once when leaving. Override to dispose pixi state + DOM. */
  unload() { this.loaded = false; }

  /** Per-frame logic. dt = seconds since last frame. */
  update(/* dt */) {}

  /** Per-frame draw hook. Most rendering happens via Pixi's scene graph. */
  draw() {}

  /** Optional resize hook (window resize / DPR change). */
  resize(/* w, h */) {}
}
