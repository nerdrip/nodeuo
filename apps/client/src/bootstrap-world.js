// World-only client services.
//
// The login and character-creation flow is DOM-first and does not need these
// managers. Keeping their imports behind one async boundary makes the cold
// login payload smaller while preserving a single deterministic install
// point before GameScene takes ownership.

import { camera } from './renderer/camera.js';
import { profile } from './managers/profile-manager.js';
import { diagnosticsManager } from './managers/diagnostics-manager.js';
import { dragCursor } from './managers/drag-cursor.js';
import { targetCursor } from './managers/target-cursor.js';
import { messageManager } from './managers/message-manager.js';
import { commandManager } from './managers/command-manager.js';
import { journalManager } from './managers/journal-manager.js';
import './managers/journal-watch.js';
import { delayedClickManager } from './managers/delayed-click-manager.js';
import { houseManager } from './managers/house-manager.js';
import { boatMovingManager } from './managers/boat-moving-manager.js';
import { auraManager } from './managers/aura-manager.js';
import { activeIcons } from './managers/active-icons-manager.js';
import { ignoreManager } from './managers/ignore-manager.js';
import { infoBar } from './managers/info-bar-manager.js';
import { seasonManager } from './managers/season-manager.js';
import { skillsGroupManager } from './managers/skills-group-manager.js';
import { worldMapEntities } from './managers/world-map-entity-manager.js';
import { anchorManager } from './managers/anchor-manager.js';
import { hotkeys } from './managers/hotkeys-manager.js';
import { afkManager } from './managers/afk-manager.js';
import { autoloot } from './managers/autoloot-manager.js';
import { installMenuGumpListener } from './ui/gumps/menu-gump.js';

let installed = false;

export function installWorldServices(bus) {
  if (installed) return { camera, diagnosticsManager };
  installed = true;

  dragCursor.install();
  targetCursor.install();
  messageManager.install();
  void commandManager;
  void journalManager;
  delayedClickManager.install();
  houseManager.install();
  boatMovingManager.install();
  auraManager.install();
  void activeIcons;
  ignoreManager.install();
  infoBar.install();
  seasonManager.install();
  skillsGroupManager.install();
  worldMapEntities.install();
  worldMapEntities.setEnabled(false);
  anchorManager.install();
  try { globalThis.__anchorManager = anchorManager; } catch { /* SSR */ }

  try { camera.applyProfileViewport?.(profile); } catch { /* SSR */ }
  bus.on('camera:resized', ({ w, h }) => {
    try {
      profile.set?.('ui.gameWindowW', w | 0);
      profile.set?.('ui.gameWindowH', h | 0);
    } catch { /* ignore */ }
  });
  bus.on('camera:moved', ({ x, y }) => {
    try {
      profile.set?.('ui.gameWindowX', x | 0);
      profile.set?.('ui.gameWindowY', y | 0);
    } catch { /* ignore */ }
  });

  hotkeys.install();
  afkManager.start();
  autoloot.install();
  installMenuGumpListener();
  return { camera, diagnosticsManager };
}
