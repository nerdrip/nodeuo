import { bus } from '../core/event-bus.js';
import { net } from '../net/net-client.js';
import { requestNodeUOInteractionCatalog } from '../net/nodeuo-services.js';
import { PopupMenuGump } from '../ui/gumps/popup-menu-gump.js';

/** Start a latest-wins modern interaction lookup. Returns false when the
 * negotiated feature is absent so the caller can send the classic request. */
export function openInteractionCatalog(scene, targetSerial, screenX, screenY, fallback) {
  if (!net.supportsNodeUO?.('interaction.catalog')) return false;
  const serial = Number(targetSerial) >>> 0;
  const token = {};
  scene._interactionCatalogToken = token;
  const classicFallback = () => {
    if (scene.loaded && scene._interactionCatalogToken === token) fallback?.();
  };
  requestNodeUOInteractionCatalog(net, serial).then((catalog) => {
    if (scene._interactionCatalogToken !== token || !scene.loaded || !scene._ui) return;
    if (!catalog?.ok || !catalog.actions?.length) return classicFallback();
    const entries = catalog.actions.map((action, index) => ({
      responseId: 0x10000 + index, label: action.label,
      flags: action.enabled === false ? 0x01 : 0,
      onClick: async () => {
        const result = await requestNodeUOInteractionCatalog(net, serial, {
          actionId: action.id, expectedRevision: catalog.revision,
        });
        if (result?.entity) bus.emit('chat:system', {
          text: `${result.entity.name || result.entity.type}: ${result.entity.type}`,
        });
        return result;
      },
    }));
    const existing = scene._ui.findGump((gump) => gump._toggleKey === 'popup-menu');
    if (existing) scene._ui.removeGump(existing);
    const anchor = scene._ui.screenToLogical?.(screenX, screenY) ?? { x: screenX, y: screenY };
    const menu = new PopupMenuGump({ serial, entries }, anchor.x, anchor.y);
    menu._toggleKey = 'popup-menu';
    const logicalW = (window.innerWidth || 1024) / (scene._ui.scale || 1);
    const logicalH = (window.innerHeight || 768) / (scene._ui.scale || 1);
    menu.setPosition(Math.max(4, Math.min(anchor.x, logicalW - menu.width - 4)),
      Math.max(4, Math.min(anchor.y, logicalH - menu.height - 4)));
    scene._ui.addGump(menu);
  }).catch(classicFallback);
  return true;
}
