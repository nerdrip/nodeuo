// JournalWatch — audit rev.4 P3 #21. Watches incoming entity events
// and logs lines to the journal when the user has opted-in via
// `profile.showNewMobileName` / `showNewCorpseName`. Mirrors CUO
// `Profile.cs::ShowNewMobileName/CorpseName` semantics.

import { bus } from '../core/event-bus.js';
import { profile } from './profile-manager.js';

const CORPSE_ITEM_ID = 0x2006;

bus.on('mobile:incoming', (m) => {
  if (!profile.get?.('showNewMobileName')) return;
  if (!m?.name) return;
  bus.emit('message:journal', {
    text: `Sighted: ${m.name}`,
    textType: 1,
    hue: 0xc0e0ff,
  });
});

bus.on('item:placed', (it) => {
  if (!it) return;
  if ((it.itemId | 0) !== CORPSE_ITEM_ID) return;
  if (!profile.get?.('showNewCorpseName')) return;
  bus.emit('message:journal', {
    text: it.name ? `Corpse spotted: ${it.name}` : 'A corpse appears nearby.',
    textType: 1,
    hue: 0xc0a8a0,
  });
});
