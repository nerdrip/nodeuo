import { WindowGump } from '../ui/gumps/window-gump.js';
import { Label } from '../ui/controls/label.js';
import { Button, ButtonAction } from '../ui/controls/button.js';
import { ScrollArea } from '../ui/controls/scroll-area.js';
import { net } from '../net/net-client.js';

class StructuredUiGump extends WindowGump {
  constructor(view) {
    const width = Math.max(280, Math.min(720, Number(view.width) | 0 || 460));
    const height = Math.max(200, Math.min(620, Number(view.height) | 0 || 380));
    super({ title: String(view.title ?? 'Shard').slice(0, 96), width, height, x: 160, y: 110 });
    this.view = view;
    this.revision = Math.max(0, Number(view.revision) | 0);
    this.viewId = String(view.id ?? 'view').slice(0, 64);
    const scroll = new ScrollArea({ width: width - 28, height: height - 105 });
    this.addContent(scroll, 14, 32);
    let y = 0;
    for (const block of (view.blocks ?? [{ kind: 'text', text: view.text ?? '' }]).slice(0, 64)) {
      const text = String(block?.text ?? '').slice(0, 8192);
      if (!text) continue;
      const label = new Label(text, {
        fontSize: Math.max(9, Math.min(22, block.size | 0 || 12)),
        hue: Number(block.hue) || 0xffefc0, maxWidth: width - 52, wordWrap: true, lineHeight: 17,
      });
      label.setPosition(0, y); scroll.add(label);
      y += Math.max(20, label.height + 8);
    }
    scroll.setContentHeight(y);
    let x = 14;
    for (const action of (view.actions ?? []).slice(0, 8)) {
      const button = new Button({
        normalGumpId: 0, pressedGumpId: 0, flat: true,
        width: Math.max(72, Math.min(150, String(action.label ?? '').length * 8 + 20)),
        height: 24, label: String(action.label ?? 'OK').slice(0, 64), action: ButtonAction.Activate,
      });
      button.setPosition(x, height - 58);
      button.enabled = action.enabled !== false;
      button.onClick = () => {
        if (!button.enabled) return;
        if (action.command) net.sendCommand(String(action.command).slice(0, 256));
        else if (action.rpc?.targetFeature && action.rpc?.method) {
          void net.sendNodeUORpc?.(
            String(action.rpc.targetFeature).slice(0, 128),
            String(action.rpc.method).slice(0, 64),
            action.rpc.params && typeof action.rpc.params === 'object' ? action.rpc.params : {},
          ).catch(() => {});
        } else if (action.feature && net.supportsNodeUO?.(String(action.feature))) {
          void net.sendNodeUORequest?.({
            capability: String(action.feature).slice(0, 128),
            payload: action.payload && typeof action.payload === 'object' ? action.payload : {},
            ttlMs: 5000,
          }).catch(() => {});
        }
        if (action.close !== false) this.close();
      };
      this.add(button); x += button.width + 8;
      if (x + 72 > width) break;
    }
  }
  get type() { return 'nodeuo-structured-ui'; }
  get positionKey() { return `nodeuo-view:${this.viewId}`; }
}

export function installStructuredUi(scene) {
  scene._sub('nodeuo:structured-ui', (payload) => {
    const incoming = payload?.view;
    if (!scene.loaded || !scene._ui || !incoming || typeof incoming !== 'object') return;
    const id = String(incoming.id ?? 'view').slice(0, 64);
    const previous = scene._ui.findGump((gump) => gump.type === 'nodeuo-structured-ui' && gump.viewId === id);
    const operation = String(payload.operation ?? incoming.operation ?? 'replace').toLowerCase();
    if (operation === 'close') {
      if (previous) scene._ui.removeGump(previous);
      return;
    }
    if (previous && Number(incoming.revision) > 0 && Number(incoming.revision) <= previous.revision) return;
    const view = operation === 'patch' && previous ? {
      ...previous.view,
      ...incoming,
      blocks: Array.isArray(incoming.blocks) ? incoming.blocks : previous.view.blocks,
      actions: Array.isArray(incoming.actions) ? incoming.actions : previous.view.actions,
    } : incoming;
    if (previous) scene._ui.removeGump(previous);
    const gump = new StructuredUiGump(view);
    gump._toggleKey = `nodeuo-view:${id}`;
    scene._ui.addGump(gump);
  });
}

export { StructuredUiGump };
