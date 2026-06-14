import { destroyItemBySerial } from '../../../_items.js';
import { nearbyClients } from '../../../_spatial.js';

const DIR_OFFSETS = [
  { x: 0, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 0 }, { x: 1, y: 1 },
  { x: 0, y: 1 }, { x: -1, y: 1 }, { x: -1, y: 0 }, { x: -1, y: -1 },
];

function normaliseChoices(item) {
  const raw = item.addonNames ?? item.addons ?? item.data?.addonNames;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return Object.entries(raw)
      .filter(([, value]) => typeof value === 'string' && value)
      .map(([label, addonName]) => ({ label, addonName }));
  }
  if (Array.isArray(raw)) {
    return raw
      .filter((value) => typeof value === 'string' && value)
      .map((addonName) => ({ label: addonName, addonName }));
  }
  const addonName = item.addonName ?? item.addon ?? item.data?.addonName;
  return addonName ? [{ label: 'default', addonName }] : [];
}

function chooseByFacing(choices, user) {
  if (choices.length <= 1) return choices[0]?.addonName ?? null;
  const dir = (user?.direction ?? user?.dir ?? user?.facing ?? 0) & 7;
  const wantsEast = dir >= 1 && dir <= 3;
  const preferred = choices.find((c) => String(c.label).toLowerCase() === (wantsEast ? 'east' : 'south'));
  return (preferred ?? choices[0]).addonName;
}

function labelText(label) {
  return String(label ?? 'default').replace(/-/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function stampAddonDeedClasses(item) {
  const choices = normaliseChoices(item);
  const classes = new Set(item.servuoClasses ?? []);
  classes.add('BaseAddonDeed');
  classes.add('InternalTarget');
  if (choices.length > 1) {
    classes.add('InternalGump');
    classes.add('FacingGump');
  }
  item.servuoClasses = [...classes];
}

function selectAddon(api, item, user, cb) {
  const choices = normaliseChoices(item);
  if (!choices.length) { cb(null); return; }
  if (choices.length === 1 || !api.gumps?.send || !user?.client) {
    cb(chooseByFacing(choices, user));
    return;
  }

  const layout = [
    '{ resizepic 0 0 5054 220 120 }',
    '{ text 24 18 1152 0 }',
  ];
  const texts = ['Choose a facing:'];
  choices.slice(0, 8).forEach((choice, i) => {
    const y = 46 + i * 24;
    layout.push(`{ button 24 ${y} 4005 4007 1 0 ${i + 1} }`);
    layout.push(`{ text 56 ${y - 2} 1152 ${texts.length} }`);
    texts.push(labelText(choice.label));
  });
  layout.push('{ button 24 96 4017 4018 1 0 0 }');
  try {
    api.gumps.send(user.client, {
      gumpId: 0xAD0DED,
      x: 120,
      y: 90,
      layout: layout.join(' '),
      texts,
    }, (resp) => {
      const idx = (resp?.buttonId | 0) - 1;
      cb(idx >= 0 && idx < choices.length ? choices[idx].addonName : null);
    });
  } catch {
    cb(chooseByFacing(choices, user));
  }
}

function defaultLocation(user) {
  const dir = (user?.direction ?? user?.dir ?? user?.facing ?? 2) & 7;
  const off = DIR_OFFSETS[dir] ?? DIR_OFFSETS[2];
  return {
    x: (user.x | 0) + off.x,
    y: (user.y | 0) + off.y,
    z: user.z | 0,
    map: user.map ?? 1,
  };
}

function selectLocation(api, user, cb) {
  const state = user?.client;
  if (!api.targeting?.request || !state) {
    cb(defaultLocation(user));
    return;
  }
  user.client?.sendSystemMessage?.('Target where to place the addon.');
  try {
    api.targeting.request(state, (picked) => {
      if (!picked) { cb(null); return; }
      cb({
        x: picked.x | 0,
        y: picked.y | 0,
        z: picked.z ?? (user.z | 0),
        map: user.map ?? 1,
      });
    }, { kind: 0 });
  } catch {
    cb(defaultLocation(user));
  }
}

export default function buildAddonDeed(api) {
  function place(world, item, user, addonName, loc) {
    const sys = api.systems?.addons;
    if (!addonName || !sys?.placeAddon) {
      user.client?.sendSystemMessage?.('This deed is missing its addon definition.');
      return true;
    }
    if (!loc) {
      user.client?.sendSystemMessage?.('Addon placement canceled.');
      return true;
    }
    const placed = sys.placeAddon(world, addonName, loc);
    if (!placed.length) {
      user.client?.sendSystemMessage?.('That addon cannot be placed here.');
      return true;
    }
    for (const piece of placed) {
      const pkt = api.protocol?.worldItemSA?.({
        serial: piece.serial,
        itemId: piece.itemId,
        hue: piece.hue,
        amount: 1,
        x: piece.x,
        y: piece.y,
        z: piece.z,
      });
      if (pkt) for (const mob of nearbyClients(world, piece)) mob.client?.send?.(pkt);
    }
    try { destroyItemBySerial(api, item.serial); }
    catch { /* already gone */ }
    if (user.client && api.protocol?.removeEntity) {
      try { user.client.send(api.protocol.removeEntity(item.serial)); }
      catch { /* advisory */ }
    }
    user.client?.sendSystemMessage?.(`You place ${String(addonName).replace(/-/g, ' ')}.`);
    return true;
  }

  return {
    name: 'addon-deed',
    onCreate(_world, item) {
      stampAddonDeedClasses(item);
    },
    onUse(world, item, user) {
      if (!user) return false;
      stampAddonDeedClasses(item);
      selectAddon(api, item, user, (addonName) => {
        selectLocation(api, user, (loc) => place(world, item, user, addonName, loc));
      });
      return true;
    },
  };
}
