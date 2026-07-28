export function ensureGameDomUiStyles() {
  const id = 'uo-game-ui-styles';
  if (document.getElementById?.(id) || document.querySelector?.(`#${id}`)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = `
    #dom-ui .uo-game-panel {
      box-sizing: border-box;
      color: #f2e7c8;
      background: linear-gradient(180deg, rgba(24, 27, 31, 0.94), rgba(12, 14, 17, 0.92));
      border: 1px solid rgba(226, 180, 92, 0.44);
      border-radius: 6px;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.42), inset 0 1px 0 rgba(255, 255, 255, 0.06);
      backdrop-filter: blur(5px);
    }
    #dom-ui .uo-hud-panel {
      width: 300px;
      max-width: 300px;
      max-height: none;
      overflow-y: auto;
      padding: 10px 12px;
      font: 500 12px/1.4 "Segoe UI Variable Text", "Segoe UI", Inter, system-ui, sans-serif;
      scrollbar-color: rgba(226, 180, 92, 0.55) rgba(0, 0, 0, 0.2);
    }
    #dom-ui .uo-hud-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin: 0 0 8px;
      color: #ffd98a;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    #dom-ui .uo-hud-title > span:first-child {
      flex: 1 1 auto;
    }
    #dom-ui .uo-hud-title::after {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #75d5ff;
      box-shadow: 0 0 12px rgba(117, 213, 255, 0.75);
    }
    #dom-ui .uo-hud-grid {
      display: grid;
      gap: 4px;
    }
    #dom-ui .uo-hud-row {
      display: grid;
      grid-template-columns: 104px 1fr;
      gap: 8px;
      align-items: baseline;
    }
    #dom-ui .uo-hud-row span {
      color: rgba(242, 231, 200, 0.62);
    }
    #dom-ui .uo-hud-row b {
      color: #f8f1dc;
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    #dom-ui .uo-hud-row.uo-hud-wide {
      grid-template-columns: 1fr;
      gap: 2px;
      margin-top: 4px;
      padding-top: 6px;
      border-top: 1px solid rgba(226, 180, 92, 0.18);
    }
    #dom-ui .uo-hud-row.uo-hud-section {
      display: block;
      margin-top: 7px;
      padding-top: 7px;
      border-top: 1px solid rgba(226, 180, 92, 0.2);
      color: #ffd98a;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    #dom-ui .uo-journal-panel {
      width: min(300px, calc(100vw - 28px));
      min-height: 112px;
      max-height: 184px;
      padding: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      line-height: 1.35;
      font: 500 12px/1.45 "Segoe UI Variable Text", "Segoe UI", Inter, system-ui, sans-serif;
      opacity: 0.96;
    }
    #dom-ui .uo-journal-head {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 30px;
      padding: 0 7px 0 11px;
      color: #ffd98a;
      background: rgba(255, 255, 255, 0.025);
      border-bottom: 1px solid rgba(226, 180, 92, 0.2);
      font-size: 10px;
      font-weight: 750;
      letter-spacing: 0.09em;
      text-transform: uppercase;
    }
    #dom-ui .uo-journal-open {
      display: inline-grid;
      place-items: center;
      width: 25px;
      min-width: 25px;
      height: 22px;
      padding: 0;
      margin: 0;
      color: #f4dfad;
      background: rgba(226, 180, 92, 0.09);
      border: 1px solid rgba(226, 180, 92, 0.26);
      border-radius: 4px;
      cursor: pointer;
      font: 700 10px/22px "Segoe UI Variable Text", "Segoe UI", sans-serif;
      text-align: center;
      vertical-align: middle;
    }
    #dom-ui .uo-journal-open:hover {
      color: #fff6dc;
      background: rgba(226, 180, 92, 0.18);
    }
    #dom-ui .uo-journal-lines {
      flex: 1 1 auto;
      min-height: 0;
      padding: 8px 11px 9px;
      overflow-y: auto;
      white-space: pre-wrap;
      color: #f2e7c8;
      scrollbar-color: rgba(226, 180, 92, 0.55) rgba(0, 0, 0, 0.2);
    }
    #dom-ui .uo-journal-lines.is-empty {
      display: grid;
      place-items: center;
      color: rgba(242, 231, 200, 0.48);
      font-style: italic;
      text-align: center;
    }
    #dom-ui .uo-chatbar {
      display: grid;
      grid-template-columns: minmax(108px, 140px) minmax(0, 1fr);
      gap: 8px;
      padding: 7px;
      border-color: rgba(117, 213, 255, 0.34);
    }
    #dom-ui .uo-chat-mode,
    #dom-ui .uo-chat-input {
      height: 36px;
      box-sizing: border-box;
      color: #fff3ce;
      background: rgba(6, 9, 13, 0.88);
      border: 1px solid rgba(226, 180, 92, 0.44);
      border-radius: 4px;
      outline: none;
      font: 500 13px "Segoe UI Variable Text", "Segoe UI", Inter, system-ui, sans-serif;
    }
    #dom-ui .uo-chat-mode {
      padding: 0 8px;
    }
    #dom-ui .uo-chat-input {
      width: 100%;
      padding: 8px 11px;
    }
    #dom-ui .uo-chat-input::placeholder {
      color: rgba(242, 231, 200, 0.5);
    }
    #dom-ui .uo-chat-mode:focus,
    #dom-ui .uo-chat-input:focus {
      border-color: rgba(117, 213, 255, 0.8);
      box-shadow: 0 0 0 2px rgba(117, 213, 255, 0.16), 0 0 18px rgba(117, 213, 255, 0.18);
    }
    #dom-ui .uo-popup-menu {
      background: linear-gradient(180deg, rgba(25, 23, 20, 0.98), rgba(12, 12, 13, 0.98));
    }
    @media (max-width: 720px) {
      #dom-ui .uo-hud-panel {
        min-width: 210px;
        width: min(300px, calc(100vw - 22px));
        max-width: calc(100vw - 22px);
      }
      #dom-ui .uo-chatbar {
        grid-template-columns: 104px minmax(0, 1fr);
        left: 6px !important;
        right: 6px !important;
      }
    }
  `;
  (document.head || document.body || document.documentElement)?.appendChild(style);
}

export function sideRailOccupancy(ui, viewLeft, viewRight) {
  if (!ui?.gumps?.length) return { left: false, right: false };
  const scale = ui.scale || 1;
  let left = false;
  let right = false;
  for (const gump of ui.gumps) {
    if (!gump?.node?.visible || gump._toggleKey === 'topbar' || gump._toggleKey === 'actionbar') continue;
    const gx = (Number(gump.node.x) || 0) * scale;
    const gw = Math.max(1, (Number(gump.width) || Number(gump.node.width) || 1) * scale);
    if (gx + gw <= viewLeft + 12) left = true;
    if (gx >= viewRight - 12) right = true;
    if (left && right) break;
  }
  return { left, right };
}


