import { allMobiles } from '../../_spatial.js';
import { mobileBySerial } from '../../_entities.js';
// FAZA FH — `[duel <name>` consensual PvP.
//
// ServUO's duel system pairs two players, drops their notoriety to
// 4 (criminal) for the duration, and tracks the winner. We expose
// the irreducible flow: challenge / accept / forfeit, with a 5-min
// timeout and friendly-fire override.

const DUEL_TIMEOUT_MS = 5 * 60 * 1000;
/** @type {Map<number, {opponent:number, startedAt:number}>} */
const duels = new Map();
/** @type {Map<number, {challenger:number, expiresAt:number}>} */
const pendingChallenges = new Map();

export default function register(api) {
  if (!api.commands) return () => {};

  function findPlayerByName(name) {
    const found = api.game?.findOnlineByName?.(name) ?? api.query?.findOnlineByName?.(name);
    if (found) return found;
    const lower = String(name ?? '').toLowerCase();
    for (const m of allMobiles(api)) {
      if (!m.client) continue;
      if ((m.name ?? '').toLowerCase() === lower) return m;
    }
    return null;
  }

  api.commands.register({
    name: 'duel',
    help: '[duel <name> — challenge a player to a duel.',
    access: 'Player',
    run(ctx) {
      const target = findPlayerByName(ctx.args[0] ?? '');
      if (!target) {
        ctx.state.sendSystemMessage('No such player online.');
        return;
      }
      if (target === ctx.sender) {
        ctx.state.sendSystemMessage('You cannot duel yourself.');
        return;
      }
      pendingChallenges.set(target.serial >>> 0, {
        challenger: ctx.sender.serial >>> 0,
        expiresAt: Date.now() + DUEL_TIMEOUT_MS,
      });
      target.client?.sendSystemMessage?.(
        `${ctx.sender.name} challenges you to a duel. Type [accept to fight or [decline to refuse.`,
      );
      ctx.state.sendSystemMessage(`Challenge sent to ${target.name}.`);
    },
  });

  api.commands.register({
    name: 'duelaccept',
    help: '[duelaccept — accept a pending duel challenge.',
    access: 'Player',
    run(ctx) {
      const slot = pendingChallenges.get(ctx.sender.serial >>> 0);
      if (!slot || slot.expiresAt < Date.now()) {
        ctx.state.sendSystemMessage('No pending challenge.');
        return;
      }
      pendingChallenges.delete(ctx.sender.serial >>> 0);
      const challengerSerial = slot.challenger;
      duels.set(ctx.sender.serial >>> 0, { opponent: challengerSerial, startedAt: Date.now() });
      duels.set(challengerSerial, { opponent: ctx.sender.serial >>> 0, startedAt: Date.now() });
      const challenger = mobileBySerial(api, challengerSerial);
      ctx.state.sendSystemMessage('The duel begins!');
      challenger?.client?.sendSystemMessage?.(`${ctx.sender.name} accepts. The duel begins!`);
    },
  });

  api.commands.register({
    name: 'dueldecline',
    help: '[dueldecline — decline a pending duel challenge.',
    access: 'Player',
    run(ctx) {
      pendingChallenges.delete(ctx.sender.serial >>> 0);
      ctx.state.sendSystemMessage('Challenge declined.');
    },
  });

  api.commands.register({
    name: 'forfeit',
    help: '[forfeit — surrender the active duel.',
    access: 'Player',
    run(ctx) {
      const d = duels.get(ctx.sender.serial >>> 0);
      if (!d) {
        ctx.state.sendSystemMessage('You are not in a duel.');
        return;
      }
      const opp = mobileBySerial(api, d.opponent);
      duels.delete(ctx.sender.serial >>> 0);
      if (opp) duels.delete(opp.serial >>> 0);
      opp?.client?.sendSystemMessage?.(`${ctx.sender.name} forfeits. You win!`);
      ctx.state.sendSystemMessage('You forfeit the duel.');
    },
  });

  return () => {
    for (const c of ['duel', 'accept', 'decline', 'forfeit']) api.commands.unregister(c);
    duels.clear();
    pendingChallenges.clear();
  };
}

export function isInDuel(serial) {
  return duels.has(serial >>> 0);
}
export function _resetDuelsForTest() {
  duels.clear();
  pendingChallenges.clear();
}
