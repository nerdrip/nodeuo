import { NodeUONpcDialogMessage } from '@uo/nodeuo-protocol';

const loadNpcDialogGump = () => import('../ui/gumps/npc-dialog-gump.js').then((module) => module.NpcDialogGump);

/** Install the scene-owned Visual Novel dialog subscription. The closure keeps
 * lazy-load races local and rejects callbacks after the scene is unloaded. */
export function installNpcDialogUi(scene) {
  let pending = null;
  scene._sub('nodeuo:npc-dialog', (message) => {
    if (!scene.loaded || !scene._ui || !message) return;
    const npcSerial = message.payload?.npcSerial >>> 0;
    const key = `npc-dialog:${npcSerial}`;
    const existing = scene._ui.findGump((gump) => gump.type === 'npc-dialog');
    if (message.kind === NodeUONpcDialogMessage.Close) {
      if ((pending?.requestId >>> 0) === (message.requestId >>> 0)) pending = null;
      if (existing && (existing.requestId >>> 0) === (message.requestId >>> 0)) existing.closeFromServer?.();
      return;
    }
    if (message.kind !== NodeUONpcDialogMessage.Open || !npcSerial) return;
    if (existing) {
      if ((existing.npcSerial >>> 0) === npcSerial) {
        existing.applyMessage?.(message);
        return;
      }
      existing._closeSent = true;
      scene._ui.removeGump(existing);
    }
    pending = message;
    loadNpcDialogGump().then((NpcDialogGump) => {
      if (!scene.loaded || !scene._ui || pending !== message) return;
      pending = null;
      const current = scene._ui.findGump((gump) => gump.type === 'npc-dialog');
      if (current) {
        if ((current.npcSerial >>> 0) === npcSerial) {
          current.applyMessage?.(message);
          return;
        }
        current._closeSent = true;
        scene._ui.removeGump(current);
      }
      const gump = new NpcDialogGump(message);
      gump._toggleKey = key;
      scene._ui.addGump(gump);
    }).catch((error) => console.error('[npc-dialog] lazy load failed:', error));
  });
}
