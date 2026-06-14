// Summon Familiar — spawns a Necro companion. ServUO offers 5 forms;
// we pick the highest available by skill: Vampire Bat (60+) > Death Adder
// (50+) > Dark Wolf (40+) > Horde Minion (30+) > Bake Kitsune (30+).
import { broadcastSound, skillValue } from '../_helpers.js';
function pickFamiliar(skill) {
  if (skill >= 60) return 'vampire-bat-familiar';
  if (skill >= 50) return 'death-adder';
  if (skill >= 40) return 'dark-wolf-familiar';
  if (skill >= 30) return 'horde-minion';
  return 'horde-minion';
}
export default {
  name: 'summon-familiar', school: 'necromancy', circle: 3, mana: 17,
  cast(api, ctx) {
    const caster = ctx.sender;
    const factory = api.ctx?.spawnFactory;
    if (!factory) return ctx.state.sendSystemMessage('Familiar summoning unavailable.');
    const necro = skillValue(caster, 50);
    const kind = pickFamiliar(necro);
    const minion = factory(api.world, kind, { x: caster.x + 1, y: caster.y, z: caster.z, map: caster.map });
    if (!minion) return ctx.state.sendSystemMessage('Your familiar refuses to manifest.');
    minion.controlMaster = caster.serial >>> 0;
    minion.notoriety = 1;
    api.ai?.attach?.(minion, 'pet', { command: 'follow', targetSerial: 0 });
    broadcastSound(api, api.world, caster, 0x217);
    ctx.state.sendSystemMessage(`A ${kind.replace(/-/g, ' ')} appears.`);
  },
};
