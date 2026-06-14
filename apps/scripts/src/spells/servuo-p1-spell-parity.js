// ServUO P1 spell parity bridge.
//
// ServUO exposes one C# class per spell/timer/context. Our Node server uses
// data-driven spell definitions plus timestamped state. This module connects
// the two worlds: exact ServUO class aliases, missing mastery spell wrappers,
// gargoyle flight, ArcaneFiend summon data, and a small script-facing API.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

import { SPELLS } from './index.js';
import { mobileBySerial } from '../_entities.js';
import { createMobile, destroyMobileBySerial } from '../_mobiles.js';
import { allMobiles, sendToClientsNear } from '../_spatial.js';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const PARITY_PATH = path.resolve(HERE, '../data/config/servuo-spell-parity.json');
const FLY_BIT = 0x10;

function loadParityRows() {
  try {
    const rows = JSON.parse(fs.readFileSync(PARITY_PATH, 'utf8'));
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export const SERVUO_P1_SPELL_PARITY = Object.freeze(loadParityRows());
export const SERVUO_P1_SPELL_CLASSES = Object.freeze(
  SERVUO_P1_SPELL_PARITY.map((row) => row.servuoClass).filter(Boolean),
);

function norm(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function classAliases(row) {
  const cls = row.servuoClass ?? '';
  const base = cls.replace(/Spell$/i, '');
  return [
    cls,
    base,
    row.slug,
    ...(row.aliases ?? []),
  ].map(norm).filter(Boolean);
}

function upsertRegistry(disposers, registry, entry) {
  if (!registry?.register || !entry?.kind) return;
  const old = registry.get?.(entry.kind);
  registry.register(entry);
  disposers.push(() => {
    if (old) registry.register(old);
    else registry.unregister?.(entry.kind);
  });
}

function notify(mob, line) {
  mob?.client?.sendSystemMessage?.(line);
}

function sendMobileRefresh(api, world, mob) {
  if (!mob || !api.protocol) return;
  if (mob.client && api.protocol.mobileUpdate) {
    mob.client.send(api.protocol.mobileUpdate({
      serial: mob.serial,
      body: mob.body,
      hue: mob.hue ?? 0,
      flags: mob.flags ?? 0,
      x: mob.x,
      y: mob.y,
      z: mob.z,
      direction: mob.direction ?? 0,
    }));
  }
  if (api.protocol.mobileMoving) {
    const pkt = api.protocol.mobileMoving({
      serial: mob.serial,
      body: mob.body,
      x: mob.x,
      y: mob.y,
      z: mob.z,
      direction: mob.direction ?? 0,
      hue: mob.hue ?? 0,
      flags: mob.flags ?? 0,
      notoriety: mob.notoriety ?? 1,
    });
    sendToClientsNear({ world }, mob, pkt, mob, 18);
  }
}

function playSound(api, world, center, soundId) {
  if (!api.protocol?.playSound || !center) return;
  const pkt = api.protocol.playSound({
    soundId,
    volume: 0xFF,
    x: center.x,
    y: center.y,
    z: center.z,
  });
  sendToClientsNear({ world }, center, pkt, null, 18);
}

function toggleGargoyleFlight(api, ctx) {
  const caster = ctx.caster;
  if (!caster) return;
  if (caster.race && caster.race !== 'gargoyle' && !caster.racial?.canFly) {
    notify(caster, 'Only gargoyles may fly.');
    return;
  }
  if ((caster.hp ?? 0) <= 0 || caster.dead || caster.ghost) {
    notify(caster, 'You may not fly while dead.');
    return;
  }
  if (caster._origBody || caster.transformUntil || caster.animalFormUntil || caster.stoneFormUntil) {
    notify(caster, "You can't fly in your current form.");
    return;
  }
  caster.flying = !caster.flying;
  caster._gargoyleFlying = caster.flying;
  caster.flags = caster.flying ? ((caster.flags | 0) | FLY_BIT) : ((caster.flags | 0) & ~FLY_BIT);
  if (caster.flying) {
    notify(caster, 'You are flying.');
    try { ctx.deps?.animate?.(ctx.world, caster, 0x13, { frameCount: 5, repeatCount: 1 }); } catch {}
  } else {
    notify(caster, 'You land.');
    try { ctx.deps?.animate?.(ctx.world, caster, 0x14, { frameCount: 5, repeatCount: 1 }); } catch {}
  }
  playSound(api, ctx.world, caster, caster.flying ? 0x24A : 0x249);
  sendMobileRefresh(api, ctx.world, caster);
}

function invokeMasteryEffect(api, masteryName) {
  return (ctx) => {
    const caster = ctx.caster;
    if (!caster) return;
    const target = ctx.target ?? caster;
    const result = api.systems?.masteryAbilities?.invokeMastery?.(
      ctx.world ?? api.world,
      caster,
      target,
      masteryName,
    );
    if (!result?.ok) {
      notify(caster, `Mastery failed: ${result?.reason ?? 'unavailable'}.`);
      return;
    }
    caster._servuoLastMastery = masteryName;
    caster._servuoLastMasteryAt = Date.now();
    notify(caster, `${masteryName} invoked.`);
    sendMobileRefresh(api, ctx.world ?? api.world, caster);
  };
}

const EXTRA_SPELL_EFFECTS = {
  FlySpell: (api) => (ctx) => toggleGargoyleFlight(api, ctx),
};

function extraSpellDef(api, row) {
  if (row.servuoClass === 'FlySpell') {
    return {
      id: row.spellId,
      name: 'Gargoyle Flight',
      school: 'gargoyle',
      skillId: 58,
      minSkill: 0,
      mana: 0,
      delayMs: 0,
      soundId: 0x24A,
      requiresTarget: false,
      servuoClass: row.servuoClass,
      servuoClasses: [row.servuoClass],
      servuoRegistryId: row.servuoRegistryId,
      effect: EXTRA_SPELL_EFFECTS.FlySpell(api),
    };
  }
  if (!row.mastery) return null;
  return {
    id: row.spellId,
    name: row.servuoClass.replace(/Spell$/i, '').replace(/([a-z])([A-Z])/g, '$1 $2'),
    school: 'mastery',
    skillId: 28,
    minSkill: 0,
    mana: 0,
    delayMs: 0,
    requiresTarget: ['CalledShot', 'Conduit', 'DeathRay', 'FocusedEye', 'Onslaught', 'Stagger', 'Thrust'].includes(row.mastery),
    targetKind: row.mastery === 'Conduit' ? 'location' : 'object',
    servuoClass: row.servuoClass,
    servuoClasses: [row.servuoClass],
    servuoRegistryId: row.servuoRegistryId,
    effect: invokeMasteryEffect(api, row.mastery),
  };
}

function addCastAlias(row, spellLike) {
  if (!spellLike) return;
  for (const alias of classAliases(row)) {
    if (!SPELLS[alias]) SPELLS[alias] = spellLike;
  }
}

function legacyCastEntry(api, def, row) {
  return {
    id: def.id,
    name: def.name,
    slug: row.slug,
    school: def.school,
    mana: def.mana ?? 0,
    minSkill: 0,
    maxSkill: 120,
    needsTarget: !!def.requiresTarget,
    requiresTarget: !!def.requiresTarget,
    targetKind: def.targetKind ?? 'object',
    reagents: [],
    servuoClass: row.servuoClass,
    cast(callApi, scriptCtx, target) {
      const caster = scriptCtx.sender;
      const world = callApi.world ?? api.world;
      callApi.systems?.spells?.castSpell?.({
        world,
        caster,
        target,
        spellId: def.id,
        instant: true,
        accessLevel: scriptCtx.state?.account?.accessLevel,
        deps: callApi.ctx?.handlers?.spellDeps ?? undefined,
      });
    },
  };
}

function registerArcaneFiend(api, disposers) {
  upsertRegistry(disposers, api.monsters, {
    kind: 'arcane-fiend',
    name: 'an imp',
    body: 74,
    baseSoundId: 422,
    ai: 'mage',
    hp: 48,
    hpMax: 48,
    str: 55,
    dex: 40,
    int: 60,
    damageMin: 10,
    damageMax: 14,
    controlSlots: 1,
    summoned: true,
    dispelDifficulty: 70,
    dispelFocus: 20,
    bleedImmune: true,
    resist: { physical: 30, fire: 45, cold: 25, poison: 35, energy: 35 },
    skills: { 17: 25, 26: 65, 27: 40, 28: 46, 44: 42 },
    servuoClass: 'ArcaneFiend',
    servuoClasses: ['ArcaneFiend'],
  });
}

function installSpellMetadata(api, disposers) {
  const spellSys = api.systems?.spells;
  if (!spellSys?.registerSpell || !spellSys?.getSpell) return new Map();
  const byAlias = new Map();
  for (const row of SERVUO_P1_SPELL_PARITY) {
    const extra = row.spellId ? extraSpellDef(api, row) : null;
    if (extra) {
      // Re-register on every script reload so the effect closure points at
      // the current ScriptAPI instance.
      spellSys.registerSpell(extra);
    }
    const def = row.spellId ? spellSys.getSpell(row.spellId) : null;
    if (def) {
      def.servuoClass ??= row.servuoClass;
      def.servuoClasses = [...new Set([...(def.servuoClasses ?? []), row.servuoClass].filter(Boolean))];
      def.servuoRegistryId ??= row.servuoRegistryId;
      def.servuoSlug ??= row.slug;
      addCastAlias(row, SPELLS[row.slug] ?? legacyCastEntry(api, def, row));
      for (const alias of classAliases(row)) byAlias.set(alias, { row, def });
    } else {
      for (const alias of classAliases(row)) byAlias.set(alias, { row, def: null });
    }
  }
  return byAlias;
}

function castServuoSpell(api, byAlias, caster, classOrAlias, target = null, opts = {}) {
  const found = byAlias.get(norm(classOrAlias));
  if (!found?.def) return { ok: false, reason: 'unknown-servuo-spell' };
  return api.systems?.spells?.castSpell?.({
    world: opts.world ?? api.world,
    caster,
    target,
    spellId: found.def.id,
    accessLevel: opts.accessLevel,
    instant: opts.instant,
    scroll: opts.scroll,
    deps: opts.deps,
  }) ?? { ok: false, reason: 'spell-system-unavailable' };
}

function registerCommands(api, byAlias, disposers) {
  const commands = api.commands;
  if (!commands?.register) return;
  commands.register({
    name: 'servuospells',
    access: 'GameMaster',
    help: '[servuospells list|cast <class-or-alias> [targetSerial]',
    run(ctx, rawArgs = null) {
      const args = rawArgs ?? ctx.args ?? [];
      const action = norm(args[0] ?? 'list');
      if (action === 'list') {
        const names = SERVUO_P1_SPELL_PARITY
          .filter((row) => row.spellId)
          .map((row) => row.servuoClass)
          .sort();
        ctx.state?.sendSystemMessage?.(`ServUO spell aliases: ${names.join(', ')}`);
        return;
      }
      if (action === 'cast') {
        const token = args[1];
        const target = args[2] ? mobileBySerial(api, Number.parseInt(args[2], 0)) : null;
        const result = castServuoSpell(api, byAlias, ctx.sender, token, target, {
          accessLevel: ctx.state?.account?.accessLevel,
          instant: true,
        });
        ctx.state?.sendSystemMessage?.(result?.ok ? 'Spell cast.' : `Spell failed: ${result?.reason ?? 'unknown'}.`);
        return;
      }
      ctx.state?.sendSystemMessage?.('Usage: [servuospells list|cast <class-or-alias> [targetSerial]');
    },
  });
  disposers.push(() => commands.unregister?.('servuospells'));
}

function sweepSpellParity(api) {
  const now = Date.now();
  for (const mob of allMobiles(api)) {
    if (mob._whiteTigerUntil && mob._whiteTigerUntil <= now) {
      if (mob._formBackup) {
        mob.body = mob._formBackup.body ?? mob.body;
        if (mob._formBackup.hue != null) mob.hue = mob._formBackup.hue;
        if (mob._formBackup.name != null) mob.name = mob._formBackup.name;
      }
      delete mob._whiteTigerUntil;
      delete mob._formBackup;
      sendMobileRefresh(api, api.world, mob);
      notify(mob, 'Your white tiger form fades.');
    }
    if (mob.summoned && mob.summonedUntil && mob.summonedUntil <= now) {
      destroyMobileBySerial(api, mob.serial);
    }
  }
}

/** @param {import('@uo/server/src/scripts.js').ScriptAPI} api */
export default function register(api) {
  const disposers = [];
  registerArcaneFiend(api, disposers);
  const byAlias = installSpellMetadata(api, disposers);
  registerCommands(api, byAlias, disposers);

  api.systems ??= {};
  const previous = api.systems.servuoSpells;
  api.systems.servuoSpells = {
    classes: SERVUO_P1_SPELL_CLASSES,
    rows: SERVUO_P1_SPELL_PARITY,
    resolve: (name) => byAlias.get(norm(name)) ?? null,
    cast: (caster, classOrAlias, target, opts) => castServuoSpell(api, byAlias, caster, classOrAlias, target, opts),
    summonArcaneFiend(caster, seconds = 120) {
      if (!caster) return null;
      const mob = createMobile(api, {
        kind: 'arcane-fiend',
        name: 'an imp',
        body: 74,
        x: caster.x + 1,
        y: caster.y,
        z: caster.z,
        map: caster.map ?? 1,
        hp: 48,
        hpMax: 48,
        controlMaster: caster.serial,
        notoriety: 1,
        summoned: true,
        summonedUntil: Date.now() + Math.max(10, seconds) * 1000,
        servuoClass: 'ArcaneFiend',
        servuoClasses: ['ArcaneFiend'],
      });
      if (mob) api.ai?.attach?.(mob, 'pet', { command: 'follow', targetSerial: caster.serial });
      return mob;
    },
  };
  disposers.push(() => { api.systems.servuoSpells = previous; });

  const interval = setInterval(() => sweepSpellParity(api), 1000);
  interval.unref?.();
  disposers.push(() => clearInterval(interval));

  api.log?.(`servuo-p1-spell-parity: mapped ${byAlias.size} aliases for ${SERVUO_P1_SPELL_CLASSES.length} classes`);
  return () => {
    for (let i = disposers.length - 1; i >= 0; i--) {
      try { disposers[i]?.(); } catch {}
    }
  };
}
