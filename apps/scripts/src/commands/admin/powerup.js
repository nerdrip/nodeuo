// `[powerup` — instant stat + skill maxout for testing/dev.
//
// Sets all 58 ServUO skills to 100.0 on the runtime 0..120 scale,
// boosts str/dex/int to 125 each, refills HP/mana/stam,
// and broadcasts a full skill snapshot + status packet so the client
// reflects everything immediately.

const SKILL_COUNT = 58;
const SKILL_VALUE = 100;
const STAT_VALUE  = 125;

export default function register(api) {
  if (!api.commands || !api.world) return () => {};

  api.commands.register({
    name: 'powerup',
    help: '[powerup — set every skill to 100.0 and stats to 125 (GM only).',
    access: 'GM',
    run(ctx) {
      const mob = ctx.sender;
      if (!mob) return;
      // Skills — fill all 58 slots so untrained ones don't sit at 0.
      mob.skills = mob.skills ?? {};
      for (let id = 1; id <= SKILL_COUNT; id++) {
        mob.skills[id] = SKILL_VALUE;
      }
      // Stats — bump str/dex/int caps + current. ServUO `Mobile.RawStr`
      // and friends; max for normal gameplay is 125 each (700-cap
      // composite is enforced elsewhere but [powerup ignores it).
      mob.str    = STAT_VALUE;
      mob.dex    = STAT_VALUE;
      mob.intel  = STAT_VALUE;
      mob.strMax = STAT_VALUE;
      mob.dexMax = STAT_VALUE;
      mob.intMax = STAT_VALUE;
      // Derived hp/stam/mana — UO formulas: hp = 50 + (str/2),
      // stam = dex, mana = int. Bumped to the new stat values.
      mob.hpMax   = 50 + Math.floor(STAT_VALUE / 2);
      mob.stamMax = STAT_VALUE;
      mob.manaMax = STAT_VALUE;
      mob.hp     = mob.hpMax;
      mob.stam   = mob.stamMax;
      mob.mana   = mob.manaMax;
      // Push fresh skill list (type 0x02 = full snapshot with caps).
      const skills = [];
      for (let id = 1; id <= SKILL_COUNT; id++) {
        skills.push({ id, value: SKILL_VALUE, base: SKILL_VALUE, cap: 100 });
      }
      const proto = api.protocol;
      if (proto?.sendSkills) {
        ctx.state.send(proto.sendSkills({ skills, type: 0x02 }));
      }
      // Status packet — version 0x06 (extended) so str/dex/int
      // numbers refresh in the player's status gump.
      if (proto?.mobileStatus) {
        ctx.state.send(proto.mobileStatus({
          serial: mob.serial, name: mob.name, hp: mob.hp, hpMax: mob.hpMax,
          str: mob.str, dex: mob.dex, intel: mob.intel,
          stam: mob.stam, stamMax: mob.stamMax,
          mana: mob.mana, manaMax: mob.manaMax,
          gold: mob.gold ?? 0, ar: mob.ar ?? 0, weight: mob.weight ?? 0,
          weightMax: 700, gender: mob.body === 0x191 || mob.body === 0x193 ? 1 : 0,
          version: 6,
        }));
      }
      // Refresh bars on observers too (HP only — stats are private).
      if (proto?.healthUpdate && proto?.staminaUpdate && proto?.manaUpdate) {
        const hp = proto.healthUpdate({ serial: mob.serial, current: mob.hp, max: mob.hpMax });
        const st = proto.staminaUpdate({ serial: mob.serial, current: mob.stam, max: mob.stamMax });
        const mn = proto.manaUpdate({ serial: mob.serial, current: mob.mana, max: mob.manaMax });
        ctx.state.send(hp); ctx.state.send(st); ctx.state.send(mn);
      }
      ctx.state.sendSystemMessage('All skills set to 100.0 and stats to 125.');
    },
  });

  return () => {
    api.commands.unregister('powerup');
  };
}
