// Singleton accessor for the current scene's UIManager. Gumps that need
// to spawn other gumps (drag-out hotbar, popup chooser) need a stable
// reference; the UIManager is owned by GameScene and re-created on each
// scene swap, so we expose a tiny indirection here.
//
// Usage:
//   GameScene.load:  uiManagerInstance.set(this._ui);
//   GameScene.unload: uiManagerInstance.set(null);
//   Anywhere:        const ui = uiManagerInstance.get();

let current = null;

export const uiManagerInstance = {
  get: () => current,
  set: (mgr) => { current = mgr; },
};
