const loadGameSystemsGump = () => import('../ui/gumps/game-systems-gump.js')
  .then((module) => module.GameSystemsGump);

export function installGameSystemsUi(scene) {
  let pending = null;
  scene._sub('game:systems', (payload) => {
    if (!scene.loaded || !scene._ui || !payload) return;
    const existing = scene._ui.findGump((gump) => gump.type === 'game-systems');
    if (existing) { existing.applyMessage?.(payload); return; }
    if (!['open', 'catalog'].includes(payload.operation)) return;
    pending = payload;
    loadGameSystemsGump().then((GameSystemsGump) => {
      if (!scene.loaded || !scene._ui || pending !== payload) return;
      pending = null;
      const current = scene._ui.findGump((gump) => gump.type === 'game-systems');
      if (current) return current.applyMessage?.(payload);
      const gump = new GameSystemsGump(payload);
      gump._toggleKey = 'game-systems';
      scene._ui.addGump(gump);
    }).catch((error) => console.error('[game-systems] lazy load failed:', error));
  });
}
