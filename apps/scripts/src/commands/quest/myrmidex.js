// `[myrmidex` — Eodon Tribesmen vs Myrmidex invasion event.
//
//   [myrmidex start          — (Admin) begin a new event cycle
//   [myrmidex status         — display phase + capture-point ownership
//   [myrmidex capture <pt>   — flag the caller's contribution at a point
//                              (Player; spawns count for whichever side
//                              you've allied with via [eodon side <s>)
//   [myrmidex side tribe|myrm  — pick your side
//   [myrmidex reward         — claim end-of-event reward (winners only)
//
// ServUO drives the event off a once-per-day scheduler. We expose
// admin start + per-minute tick wired into a setInterval (60s). The
// state machine has 3 phases (prep / active / cleanup); side score
// only counts during `active`.

import { sendToOnline } from '../../_spatial.js';
// Reward pool — ServUO `Engines\MyrmidexInvasion\Rewards.cs` has 8
// minor artifacts split between tribe-aligned and myrm-aligned items.
const TRIBE_REWARDS = [
  { name: 'Tribal Headdress',    itemId: 0x1542, hue: 0x59 },
  { name: 'Tribal Spear',        itemId: 0x1403, hue: 0x59 },
  { name: 'Britches of Warding', itemId: 0x152E, hue: 0x59 },
  { name: 'Voodoo Doll',         itemId: 0x12FA, hue: 0x59 },
];
const MYRM_REWARDS = [
  { name: 'Myrmidex Carapace',   itemId: 0x1B72, hue: 0x44E },
  { name: 'Insect-Eyed Ring',    itemId: 0x108A, hue: 0x44E },
  { name: 'Drone-Wing Cloak',    itemId: 0x1515, hue: 0x44E },
  { name: 'Queen\'s Pheromone',  itemId: 0x183B, hue: 0x44E },
];

// Per-mob "I picked a side" stamp + claimed flag for the current
// event. Cleared when a new event starts.
const _sides = new Map();        // mobSerial → 'tribe' | 'myrm'
const _claimed = new Set();      // mobSerial — already-claimed reward this run

export default function register(api) {
  if (!api.commands || !api.world) return () => {};
  const myrmidex = api.systems?.myrmidexInvasion;
  if (!myrmidex) {
    api.log?.('myrmidex: invasion system unavailable');
    return () => {};
  }

  // Tick the event clock once per minute. The system handles its own
  // phase transitions; we just keep it ticking.
  const tickMyrmidex = () => {
    try { myrmidex.tick(); } catch (e) { console.error('[myrmidex] tick threw:', e); }
  };
  const interval = api.lifecycle?.setInterval?.(tickMyrmidex, 60 * 1000)
    ?? setInterval(tickMyrmidex, 60 * 1000);
  interval.unref?.();

  api.commands.register({
    name: 'myrmidex',
    help: '[myrmidex start|status|capture|side|reward — Tribesmen vs Myrmidex invasion.',
    access: 'Player',
    run(ctx) {
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      const arg1 = String(ctx.args[1] ?? '').toLowerCase();
      const mob = ctx.sender;

      if (sub === 'start') {
        const access = ctx.state?.account?.accessLevel ?? 'Player';
        if (access !== 'GM' && access !== 'Admin') {
          ctx.state.sendSystemMessage('GM/Admin only.');
          return;
        }
        const s = myrmidex.startEvent();
        _sides.clear();
        _claimed.clear();
        // Shard-wide announcement.
        const pkt = api.protocol?.unicodeMessage?.({
          text: 'The Myrmidex stir in Eodon! Tribesmen rally — choose your side with [myrmidex side <tribe|myrm>.',
          hue: 0x35, font: 3, name: 'System',
        });
        if (pkt) sendToOnline(api, pkt);
        ctx.state.sendSystemMessage(
          `Event started. Phase: ${s.phase}, transitions in ~${((s.nextPhaseAt - Date.now())/60000)|0} min.`,
        );
        return;
      }

      if (sub === 'status') {
        const s = myrmidex.snapshot();
        if (!s) { ctx.state.sendSystemMessage('No active event.'); return; }
        ctx.state.sendSystemMessage(
          `Phase: ${s.phase}, transitions in ~${((s.nextPhaseAt - Date.now())/60000)|0} min`,
        );
        for (const pt of Object.keys(s.captures)) {
          const c = s.captures[pt];
          ctx.state.sendSystemMessage(
            `  ${pt.padEnd(14)} — tribe ${c.tribe} / myrm ${c.myrm} → owner: ${c.owner ?? 'contested'}`,
          );
        }
        if (s.winner) {
          ctx.state.sendSystemMessage(`Event over. WINNER: ${s.winner.toUpperCase()}.`);
        }
        return;
      }

      if (sub === 'side') {
        if (arg1 !== 'tribe' && arg1 !== 'myrm') {
          ctx.state.sendSystemMessage('Usage: [myrmidex side tribe|myrm');
          return;
        }
        _sides.set(mob.serial, arg1);
        ctx.state.sendSystemMessage(`You align with the ${arg1=== 'tribe' ? 'Tribesmen' : 'Myrmidex'}.`);
        return;
      }

      if (sub === 'capture') {
        if (!myrmidex.isActive()) {
          ctx.state.sendSystemMessage('No active event phase to capture in.');
          return;
        }
        const side = _sides.get(mob.serial);
        if (!side) {
          ctx.state.sendSystemMessage('Pick a side first: [myrmidex side tribe|myrm');
          return;
        }
        const pt = arg1;
        const valid = ['plateau', 'temple', 'gateway', 'amphitheater'];
        if (!valid.includes(pt)) {
          ctx.state.sendSystemMessage(`Usage: [myrmidex capture ${valid.join('|')}`);
          return;
        }
        myrmidex.tallyCapture(pt, side);
        ctx.state.sendSystemMessage(`Captured ${pt} for the ${side === 'tribe' ? 'Tribesmen' : 'Myrmidex'}!`);
        return;
      }

      if (sub === 'reward') {
        const s = myrmidex.snapshot();
        if (!s?.winner) {
          ctx.state.sendSystemMessage('No reward yet — event not concluded.');
          return;
        }
        if (s.winner === 'draw') {
          ctx.state.sendSystemMessage('The event ended in a draw — no rewards.');
          return;
        }
        if (_claimed.has(mob.serial)) {
          ctx.state.sendSystemMessage('You already claimed your reward for this event.');
          return;
        }
        const side = _sides.get(mob.serial);
        if (side !== s.winner) {
          ctx.state.sendSystemMessage('Only the winning side may claim a reward.');
          return;
        }
        const pool = s.winner === 'tribe' ? TRIBE_REWARDS : MYRM_REWARDS;
        const pick = pool[(Math.random() * pool.length) | 0];
        const item = api.game?.mobile?.giveItem?.(mob, {
          itemId: pick.itemId, hue: pick.hue, name: pick.name,
          movable: true,
        }, { randomGrid: true });
        if (!item) { ctx.state.sendSystemMessage('You have no backpack.'); return; }
        if (item) item.artifact = pick.name;
        _claimed.add(mob.serial);
        ctx.state.sendSystemMessage(`You receive: ${pick.name}.`);
        return;
      }

      ctx.state.sendSystemMessage('Usage: [myrmidex start|status|capture <pt>|side tribe|myrm|reward');
    },
  });

  return () => {
    clearInterval(interval);
    api.commands.unregister('myrmidex');
  };
}
