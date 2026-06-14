// ServUO P1 services parity: anniversary gifts, assistant negotiation,
// daily rares, Sphynx fortune, Test Center helpers, and service items.

import { createItem, destroyItemBySerial } from '../_items.js';
import { allItems, allMobiles, sendToClientsNear } from '../_spatial.js';

export const SERVUO_P1_SERVICE_CLASSES = Object.freeze([
  'AnniversaryCard',
  'EnchantedTimepiece',
  'Anniversary22GiftToken',
  'CopperPortrait1',
  'CopperPortrait2',
  'CopperShipReliefComponent',
  'CopperSunflower',
  'Assistants',
  'Negotiator',
  'BeginHandshake',
  'DailyRock',
  'DailyFullJars',
  'DailySeaweed',
  'AncientWall',
  'SphynxFortuneArray',
  'SphynxFortune',
  'TestCenter',
]);

const PORTRAIT_NAMES = [
  'Long Tooth Riccia', 'Long Leg Topaz', 'Glass Tongue Takako', 'Iron Fist Riccia',
  'Fat Eye Takako', 'Bloody Back Greg', 'Cursed Powder Mercury', 'Lone Tongue Erebus',
  'Mad Powder Sarah', 'Long Beard Jim', 'Lazy Eye Thrixx', 'Cursed Patch Artemis',
  'Mad Back Aeon', 'Glass Tooth Asiantam', 'Iron Mouth Artemis', 'Stink Back Elizabella',
  'Lost Blade Mercury', 'Lazy Mouth Malachi', 'Glass Back Nekomata', 'Tooth Silver Fox',
];

const SUNFLOWER_NAMES = ['Trinsic', 'Jhelom', 'Vesper', 'Ocllo', 'Yew', 'Britain', 'Minoc', 'Moonglow', 'Skara Brae', 'Delucia'];

const SERVICE_TEMPLATES = [
  {
    name: 'anniversary-card',
    label: 'Anniversary Card',
    itemId: 0x9C14,
    hue: 124,
    script: 'anniversary-card',
    servuoClasses: ['AnniversaryCard'],
  },
  {
    name: 'enchanted-timepiece',
    label: 'Enchanted Timepiece',
    itemId: 0x9BC6,
    script: 'enchanted-timepiece',
    _timepiece: true,
    servuoClasses: ['EnchantedTimepiece'],
  },
  {
    name: 'anniversary-22-gift-token',
    label: '22nd Anniversary Gift Token',
    itemId: 0x4BC6,
    hue: 1286,
    blessed: true,
    script: 'anniversary-22-token',
    servuoClasses: ['Anniversary22GiftToken'],
  },
  {
    name: 'copper-portrait-1',
    label: 'Copper Portrait',
    itemId: 0xA3E0,
    script: 'copper-anniversary-deco',
    displayName: 'Long Tooth Riccia',
    servuoClasses: ['CopperPortrait1'],
  },
  {
    name: 'copper-portrait-2',
    label: 'Copper Portrait',
    itemId: 0xA3E3,
    script: 'copper-anniversary-deco',
    displayName: 'Long Leg Topaz',
    servuoClasses: ['CopperPortrait2'],
  },
  {
    name: 'copper-ship-relief-component',
    label: 'Copper Ship Relief',
    itemId: 0xA3E1,
    script: 'copper-anniversary-deco',
    displayName: 'HMS Cape',
    servuoClasses: ['CopperShipReliefComponent'],
  },
  {
    name: 'copper-sunflower',
    label: 'Copper Sunflower',
    itemId: 0xA35D,
    script: 'copper-anniversary-deco',
    displayName: 'Trinsic',
    servuoClasses: ['CopperSunflower'],
  },
  {
    name: 'daily-rock',
    label: 'Daily Rock',
    itemId: 0x1368,
    movable: true,
    _dailyRare: true,
    servuoClasses: ['DailyRock'],
  },
  {
    name: 'daily-full-jars',
    label: 'Daily Full Jars',
    itemId: 0x0E48,
    movable: true,
    _dailyRare: true,
    servuoClasses: ['DailyFullJars'],
  },
  {
    name: 'daily-seaweed',
    label: 'Daily Seaweed',
    itemId: 0x0DBA,
    movable: true,
    _dailyRare: true,
    servuoClasses: ['DailySeaweed'],
  },
  {
    name: 'ancient-wall',
    label: 'Ancient Wall',
    itemId: 0x0175,
    movable: false,
    script: 'ancient-wall',
    _ancientWall: true,
    servuoClasses: ['AncientWall'],
  },
];

const DAILY_RARES = [
  { template: 'daily-rock', x: 5511, y: 3116, z: -4, map: 0 },
  { template: 'daily-rock', x: 5511, y: 3116, z: -4, map: 1 },
  { template: 'daily-full-jars', x: 3656, y: 2506, z: 0, map: 0 },
  { template: 'daily-seaweed', x: 4548, y: 2400, z: -5, map: 0 },
  { template: 'daily-seaweed', x: 4548, y: 2400, z: -5, map: 1 },
];

const ASSISTANT_FEATURES = Object.freeze({
  FilterWeather: 1n << 0n,
  FilterLight: 1n << 1n,
  SmartTarget: 1n << 2n,
  RangedTarget: 1n << 3n,
  AutoOpenDoors: 1n << 4n,
  DequipOnCast: 1n << 5n,
  AutoPotionEquip: 1n << 6n,
  PoisonedChecks: 1n << 7n,
  LoopedMacros: 1n << 8n,
  UseOnceAgent: 1n << 9n,
  RestockAgent: 1n << 10n,
  SellAgent: 1n << 11n,
  BuyAgent: 1n << 12n,
  PotionHotkeys: 1n << 13n,
  RandomTargets: 1n << 14n,
  ClosestTargets: 1n << 15n,
  OverheadHealth: 1n << 16n,
  AutolootAgent: 1n << 17n,
  BoneCutterAgent: 1n << 18n,
  JScriptMacros: 1n << 19n,
  AutoRemount: 1n << 20n,
});

const SPHYNX_EFFECTS = [
  ['Physical', 1, 10, 'Your endurance shall protect you from your enemies blows.'],
  ['Physical', -15, -1, 'Your wounds in battle shall run deep.'],
  ['Fire', 1, 10, 'A smile will be upon your lips, as you gaze into the infernos.'],
  ['Fire', -15, -1, 'The fires of the abyss shall tear asunder your flesh!'],
  ['Cold', 1, 10, 'The ice of ages will embrace you.'],
  ['Cold', -15, -1, "Winter's touch shall be your undoing."],
  ['Poison', 1, 10, 'Your blood runs pure and strong.'],
  ['Poison', -15, -1, "Your veins will freeze with poison's chill."],
  ['Energy', 1, 10, 'Your flesh shall endure the power of storms.'],
  ['Energy', -15, -1, 'The wise will avoid the anger of storms.'],
  ['Luck', 10, 50, 'Seek riches and they will seek you.'],
  ['Luck', -50, -10, 'Only fools take risks in fate shadow.'],
  ['EnhancePotions', 5, 25, 'The power of alchemy shall thrive within you.'],
  ['EnhancePotions', -25, -5, 'The strength of alchemy will fail you.'],
  ['DefendChance', 1, 10, 'A keen mind in battle will help you avoid injury.'],
  ['DefendChance', -10, -1, 'Your lack of focus in battle shall be your undoing.'],
  ['RegenMana', 1, 3, 'The flow of the ether is strong within you.'],
  ['RegenMana', -3, -1, 'Your connection with the ether is weak, take heed.'],
];

function pick(arr) {
  return arr[(Math.random() * arr.length) | 0];
}

function rand(min, max) {
  return min + ((Math.random() * (max - min + 1)) | 0);
}

function upsertTemplate(disposers, api, tmpl) {
  const templates = api.templates;
  if (!templates?.registerTemplate) return;
  const prev = templates.getTemplate?.(tmpl.name) ?? templates.get?.(tmpl.name);
  templates.registerTemplate({
    ...tmpl,
    servuoClass: tmpl.servuoClasses?.[0] ?? tmpl.servuoClass,
  });
  disposers.push(() => {
    if (prev) templates.registerTemplate(prev);
    else templates.unregisterTemplate?.(tmpl.name);
  });
}

function give(api, mob, data) {
  return api.game?.mobile?.giveItem?.(mob, data, { randomGrid: true, requireBackpack: false })
    ?? createItem(api, api.world, {
      ...data,
      x: mob.x,
      y: mob.y,
      z: mob.z,
      map: mob.map ?? 1,
      parent: mob.serial,
    });
}

function sendItem(api, item) {
  if (!item || !api.protocol?.worldItemSA) return;
  const pkt = api.protocol.worldItemSA({
    serial: item.serial,
    itemId: item.itemId,
    hue: item.hue ?? 0,
    amount: item.amount ?? 1,
    x: item.x, y: item.y, z: item.z,
  });
  sendToClientsNear(api, item, pkt, null, 18);
}

function currentTimepieceId() {
  const hour = new Date().getHours();
  const h12 = hour > 12 ? hour - 12 : Math.max(1, hour);
  return 0x9BBA + Math.max(0, h12 - 1);
}

function registerItemScripts(api, disposers) {
  const itemScripts = api.itemScripts;
  if (!itemScripts?.register) return;

  itemScripts.register({
    name: 'anniversary-card',
    onCreate(_world, item) {
      item.args ??= `Ultima Online\t${item.ownerName ?? 'you'}`;
      item.servuoClasses = ['AnniversaryCard'];
    },
    onUse(_world, item, user) {
      user.client?.sendSystemMessage?.(`A personally written anniversary card: ${item.args ?? 'Ultima Online to you'}.`);
      return true;
    },
  });

  itemScripts.register({
    name: 'enchanted-timepiece',
    hasTick: true,
    onCreate(_world, item) {
      item._timepiece = true;
      item.servuoClasses = ['EnchantedTimepiece'];
    },
    onUse(_world, _item, user) {
      const d = new Date();
      user.client?.sendSystemMessage?.(`It is ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} to be exact.`);
      return true;
    },
    onTick(_world, item) {
      if (item.movable || item.parent != null) return;
      item.itemId = currentTimepieceId();
    },
  });

  itemScripts.register({
    name: 'anniversary-22-token',
    onUse(world, item, user) {
      const rareHue = Math.random() < 0.1 ? 2951 : 0;
      const choice = item.anniversaryChoice || pick(['wings', 'portraits', 'ship', 'sunflower']);
      if (choice === 'portraits') {
        const p1 = give(api, user, rewardDef('copper-portrait-1', rareHue));
        const p2 = give(api, user, rewardDef('copper-portrait-2', rareHue));
        if (p1) p1.displayName = pick(PORTRAIT_NAMES);
        if (p2) p2.displayName = pick(PORTRAIT_NAMES);
      } else if (choice === 'ship') {
        const ship = give(api, user, rewardDef('copper-ship-relief-component', rareHue));
        if (ship) ship.displayName = `Maiden Voyage of ${user.name ?? 'Britannia'}`;
      } else if (choice === 'sunflower') {
        const flower = give(api, user, rewardDef('copper-sunflower', rareHue));
        if (flower) flower.displayName = pick(SUNFLOWER_NAMES);
      } else {
        give(api, user, {
          itemId: 0xA35A,
          name: 'Copper Wings',
          hue: rareHue || 1286,
          blessed: true,
          servuoClasses: ['Anniversary22GiftToken'],
        });
      }
      destroyItemBySerial({ world, items: api.items, ops: api.ops, game: api.game }, item.serial);
      user.client?.sendSystemMessage?.('You claim your 22nd Anniversary reward.');
      return true;
    },
  });

  itemScripts.register({
    name: 'copper-anniversary-deco',
    onCreate(_world, item) {
      if (!item.displayName) {
        item.displayName = item.servuoClass === 'CopperSunflower'
          ? pick(SUNFLOWER_NAMES)
          : pick(PORTRAIT_NAMES);
      }
    },
    onUse(_world, item, user) {
      user.client?.sendSystemMessage?.(`${item.name ?? 'Copper decoration'}: ${item.displayName ?? 'unnamed'}.`);
      return true;
    },
  });

  itemScripts.register({
    name: 'ancient-wall',
    onUse(_world, item, user) {
      const inside = (user.map ?? 1) === 3
        && (user.x | 0) >= 1808 && (user.x | 0) <= 1839
        && (user.y | 0) >= 1784 && (user.y | 0) <= 1815;
      if (!inside) {
        user.client?.sendSystemMessage?.('That is locked, but is usable from the inside.');
        return true;
      }
      if (item._ancientWallOpenUntil && Date.now() < item._ancientWallOpenUntil) return true;
      item._ancientWall = true;
      item._ancientWallOpenUntil = Date.now() + 60_000;
      item.z = (item.z | 0) - 50;
      sendItem(api, item);
      user.client?.sendSystemMessage?.('You hear a metallic click, and the ancient stone block rises up into the ceiling.');
      const timer = api.lifecycle?.setTimeout ?? setTimeout;
      timer(() => {
        item.z = (item.z | 0) + 50;
        delete item._ancientWallOpenUntil;
        sendItem(api, item);
      }, 60_000);
      return true;
    },
  });

  for (const name of ['anniversary-card', 'enchanted-timepiece', 'anniversary-22-token', 'copper-anniversary-deco', 'ancient-wall']) {
    disposers.push(() => itemScripts.unregister?.(name));
  }
}

function rewardDef(templateName, hue) {
  const t = SERVICE_TEMPLATES.find((x) => x.name === templateName);
  return {
    itemId: t.itemId,
    name: t.label,
    hue: hue || t.hue || 0,
    blessed: true,
    script: t.script,
    displayName: t.displayName,
    servuoClass: t.servuoClasses[0],
    servuoClasses: t.servuoClasses,
  };
}

function seedDailyRares(api) {
  let made = 0;
  for (const spawn of DAILY_RARES) {
    const tmpl = SERVICE_TEMPLATES.find((t) => t.name === spawn.template);
    if (!tmpl) continue;
    let exists = false;
    for (const it of allItems(api)) {
      if ((it.map ?? 1) !== spawn.map) continue;
      if ((it.x | 0) !== spawn.x || (it.y | 0) !== spawn.y || (it.z | 0) !== spawn.z) continue;
      if ((it.servuoClasses ?? []).some((cls) => tmpl.servuoClasses.includes(cls))) {
        exists = true;
        break;
      }
    }
    if (exists) continue;
    const item = createItem(api, api.world, {
      itemId: tmpl.itemId,
      name: tmpl.label,
      x: spawn.x, y: spawn.y, z: spawn.z, map: spawn.map,
      movable: true,
      _dailyRare: true,
      _noDecay: true,
      servuoClass: tmpl.servuoClasses[0],
      servuoClasses: tmpl.servuoClasses,
    });
    sendItem(api, item);
    made++;
  }
  return made;
}

function applySphynxFortune(mob) {
  const [typeValue, min, max, text] = pick(SPHYNX_EFFECTS);
  const value = rand(min, max);
  mob._sphynxFortune = {
    typeValue,
    value,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    servuoClass: 'SphynxFortune',
    servuoClasses: ['SphynxFortuneArray', 'SphynxFortune'],
  };
  mob.servuoClasses = [...new Set([...(mob.servuoClasses ?? []), 'SphynxFortuneArray', 'SphynxFortune'])];
  return { typeValue, value, text };
}

function sweepFortunes(api) {
  const now = Date.now();
  for (const mob of allMobiles(api)) {
    if (mob._sphynxFortune?.expiresAt && mob._sphynxFortune.expiresAt <= now) {
      delete mob._sphynxFortune;
      mob.client?.sendSystemMessage?.('The effects of the Sphynx have worn off.');
    }
    if (mob._assistantHandshakeUntil && mob._assistantHandshakeUntil <= now) {
      delete mob._assistantHandshakeUntil;
    }
  }
}

function registerCommands(api, disposers) {
  api.commands?.register?.({
    name: 'assistant',
    help: '[assistant status|disallow <feature>|allow <feature>|handshake',
    access: 'Player',
    run(ctx) {
      const sub = String(ctx.args[0] ?? 'status').toLowerCase();
      ctx.sender.servuoClasses = [...new Set([...(ctx.sender.servuoClasses ?? []), 'Assistants', 'Negotiator', 'BeginHandshake'])];
      if (sub === 'handshake') {
        ctx.sender._assistantHandshakeUntil = Date.now() + 30_000;
        ctx.sender._assistantFeatures ??= {};
        ctx.state.sendSystemMessage?.('Assistant handshake started.');
        return;
      }
      const feature = ctx.args[1];
      if ((sub === 'disallow' || sub === 'allow') && ASSISTANT_FEATURES[feature]) {
        ctx.sender._assistantFeatures ??= {};
        ctx.sender._assistantFeatures[feature] = sub !== 'disallow';
        ctx.state.sendSystemMessage?.(`Assistant feature ${feature}: ${sub === 'allow' ? 'allowed' : 'disallowed'}.`);
        return;
      }
      ctx.state.sendSystemMessage?.(`Assistant features known: ${Object.keys(ASSISTANT_FEATURES).join(', ')}.`);
    },
  });

  api.commands?.register?.({
    name: 'dailyrares',
    help: '[dailyrares seed — seed ServUO daily rare spawn points.',
    access: 'GM',
    run(ctx) {
      const count = seedDailyRares(api);
      ctx.state.sendSystemMessage?.(`Daily rares seeded: ${count}.`);
    },
  });

  api.commands?.register?.({
    name: 'sphynxfortune',
    help: '[sphynxfortune — apply a 24h Sphynx fortune to yourself.',
    access: 'Player',
    run(ctx) {
      const f = applySphynxFortune(ctx.sender);
      ctx.state.sendSystemMessage?.(`${f.text} (${f.typeValue} ${f.value > 0 ? '+' : ''}${f.value})`);
    },
  });

  api.commands?.register?.({
    name: 'testcenter',
    help: '[testcenter set <str|dex|int|skillId> <value>|fillbank',
    access: 'GM',
    run(ctx) {
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      const mob = ctx.sender;
      mob.servuoClasses = [...new Set([...(mob.servuoClasses ?? []), 'TestCenter'])];
      if (sub === 'set') {
        const name = String(ctx.args[1] ?? '').toLowerCase();
        const value = Number(ctx.args[2]);
        if (!Number.isFinite(value)) {
          ctx.state.sendSystemMessage?.('Usage: [testcenter set <str|dex|int|skillId> <value>');
          return;
        }
        if (name === 'str') mob.str = Math.max(10, Math.min(125, value | 0));
        else if (name === 'dex') mob.dex = Math.max(10, Math.min(125, value | 0));
        else if (name === 'int') mob.int = Math.max(10, Math.min(125, value | 0));
        else {
          const skillId = parseInt(name, 10);
          if (!Number.isFinite(skillId)) {
            ctx.state.sendSystemMessage?.('Unknown stat/skill.');
            return;
          }
          mob.skills ??= {};
          mob.skills[skillId] = Math.max(0, Math.min(120, value));
        }
        ctx.state.sendSystemMessage?.('Test Center value adjusted.');
        return;
      }
      if (sub === 'fillbank') {
        give(api, mob, { itemId: 0x0EED, amount: 60_000, name: 'gold', stackable: true });
        give(api, mob, { itemId: 0x14F0, name: 'House Placement Tool', script: 'house-deed' });
        give(api, mob, { itemId: 0x0FBB, amount: 1000, name: 'tinker tools' });
        give(api, mob, { itemId: 0x13E3, amount: 1000, name: 'smith hammer' });
        ctx.state.sendSystemMessage?.('Test Center pack filled.');
        return;
      }
      ctx.state.sendSystemMessage?.('Usage: [testcenter set <str|dex|int|skillId> <value>|fillbank');
    },
  });

  api.commands?.register?.({
    name: 'anniversary22',
    help: '[anniversary22 token|card|timepiece',
    access: 'GM',
    run(ctx) {
      const sub = String(ctx.args[0] ?? 'token').toLowerCase();
      if (sub === 'card') {
        const card = give(api, ctx.sender, rewardDef('anniversary-card', 124));
        if (card) card.args = `Ultima Online\t${ctx.sender.name ?? 'you'}`;
        ctx.state.sendSystemMessage?.('Anniversary card created.');
        return;
      }
      if (sub === 'timepiece') {
        give(api, ctx.sender, rewardDef('enchanted-timepiece', 0));
        ctx.state.sendSystemMessage?.('Enchanted timepiece created.');
        return;
      }
      give(api, ctx.sender, rewardDef('anniversary-22-gift-token', 1286));
      ctx.state.sendSystemMessage?.('22nd Anniversary token created.');
    },
  });

  disposers.push(() => {
    for (const name of ['assistant', 'dailyrares', 'sphynxfortune', 'testcenter', 'anniversary22']) {
      try { api.commands?.unregister?.(name); } catch {}
    }
  });
}

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  const disposers = [];
  for (const tmpl of SERVICE_TEMPLATES) upsertTemplate(disposers, api, tmpl);
  registerItemScripts(api, disposers);
  registerCommands(api, disposers);

  api.systems ??= {};
  const previous = api.systems.servuoP1Services;
  api.systems.servuoP1Services = {
    classes: SERVUO_P1_SERVICE_CLASSES,
    assistantFeatures: ASSISTANT_FEATURES,
    seedDailyRares: () => seedDailyRares(api),
    applySphynxFortune,
  };
  disposers.push(() => {
    if (previous) api.systems.servuoP1Services = previous;
    else delete api.systems.servuoP1Services;
  });

  const timer = api.lifecycle?.setInterval?.(() => sweepFortunes(api), 60_000)
    ?? setInterval(() => sweepFortunes(api), 60_000);
  timer.unref?.();
  disposers.push(() => clearInterval(timer));

  api.log?.(`servuo-p1-services: ${SERVICE_TEMPLATES.length} templates registered`);
  return () => {
    for (const d of disposers.reverse()) {
      try { d(); } catch {}
    }
  };
}
