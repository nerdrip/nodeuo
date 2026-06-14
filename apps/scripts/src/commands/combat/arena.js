// `[arena` — PVP Arena queue, matches, and single-elimination tournaments.
//
//   [arena queue 1v1           → enrol in 1v1 queue
//   [arena queue 2v2           → enrol your party in 2v2 queue
//   [arena leave               → leave queue (1v1 + your party's 2v2)
//   [arena status              → show queues + active matches + tournaments
//   [arena t create <name>     → open a new tournament with `name`
//   [arena t join <name>       → join the open tournament
//   [arena t start <name>      → close registration + draw the bracket
//   [arena t status            → list active tournaments + your bracket
//
// Match flow: pair-up tick (every 2 s) teleports queued combatants to
// the canonical arena pads at Jhelom Pits (1407, 3837), heals them
// to full, and gates damage between sides via `canArenaAttack` so the
// normal PvP / criminal / guard rules don't apply inside the match.
// Death in-arena auto-resurrects; first team to die loses.

import { mobileBySerial } from '../../_entities.js';

export default function register(api) {
  if (!api.commands) return () => {};
  const arena = api.systems?.pvpArena;
  if (!arena) {
    api.log?.('arena: PvP arena system unavailable');
    return () => {};
  }

  // One-time wire — installs the kill hook + the 2 s pairing/timeout
  // interval. Safe to re-call across hot reloads (idempotent).
  arena.init({
    world: api.world,
    corpse: api.corpse,
    partyRegistry: api.party,
    itemsApi: api.items,
  });

  api.commands.register({
    name: 'arena',
    help: '[arena queue 1v1|2v2 / [arena leave / [arena status / [arena t create|join|start|status — PvP arena.',
    access: 'Player',
    run(ctx) {
      const sub  = String(ctx.args[0] ?? '').toLowerCase();
      const arg1 = String(ctx.args[1] ?? '').toLowerCase();
      const arg2 = String(ctx.args[2] ?? '');

      if (sub === 'queue') {
        if (arg1 === '1v1') {
          if (arena.isInMatch(ctx.sender)) {
            ctx.state.sendSystemMessage('You are mid-match.');
            return;
          }
          const ok = arena.enrol1v1(ctx.sender);
          ctx.state.sendSystemMessage(
            ok ? 'Enrolled in the 1v1 queue. Stand by for pair-up.'
               : 'Already queued.',
          );
          return;
        }
        if (arg1 === '2v2') {
          const party = api.party?.getParty?.(ctx.sender);
          if (!party) { ctx.state.sendSystemMessage('You need a party for 2v2.'); return; }
          const ok = arena.enrol2v2(party);
          ctx.state.sendSystemMessage(
            ok ? 'Party enrolled in the 2v2 queue.' : 'Party already queued.',
          );
          return;
        }
        ctx.state.sendSystemMessage('Usage: [arena queue 1v1|2v2');
        return;
      }

      if (sub === 'leave') {
        arena.leave(ctx.sender);
        const party = api.party?.getParty?.(ctx.sender);
        if (party) arena.leaveParty(party);
        ctx.state.sendSystemMessage('You have left the arena queues.');
        return;
      }

      if (sub === 'status') {
        const s = arena.status();
        ctx.state.sendSystemMessage(
          `Queues — 1v1:${s.queue1v1.length} 2v2:${s.queue2v2.length} matches:${s.matches.length} tournaments:${s.tournaments.length}`,
        );
        for (const t of s.tournaments) {
          ctx.state.sendSystemMessage(
            `  Tournament "${t.name}" — ${t.entrants} entrants, ${t.started ? `round ${t.round}` : 'open for joining'}`,
          );
        }
        return;
      }

      if (sub === 't' || sub === 'tournament') {
        const tsub = arg1;
        const tname = arg2 || '';
        if (tsub === 'create') {
          if (!tname) { ctx.state.sendSystemMessage('Usage: [arena t create <name>'); return; }
          const t = arena.tournamentCreate(tname, ctx.sender);
          if (!t) { ctx.state.sendSystemMessage(`A tournament named "${tname}" already exists.`); return; }
          ctx.state.sendSystemMessage(`Tournament "${tname}" created. Players use [arena t join ${tname} to enter.`);
          return;
        }
        if (tsub === 'join') {
          if (!tname) { ctx.state.sendSystemMessage('Usage: [arena t join <name>'); return; }
          const r = arena.tournamentJoin(tname, ctx.sender);
          if (!r.ok) {
            const msg = {
              'no-tournament':    `No tournament named "${tname}".`,
              'already-started':  'That tournament has already started.',
              'already-joined':   'You are already entered.',
            }[r.reason] ?? `Cannot join: ${r.reason}`;
            ctx.state.sendSystemMessage(msg);
            return;
          }
          ctx.state.sendSystemMessage(
            `Entered "${r.tournament.name}". ${r.tournament.entrants.length} entrants — wait for [arena t start.`,
          );
          return;
        }
        if (tsub === 'start') {
          if (!tname) { ctx.state.sendSystemMessage('Usage: [arena t start <name>'); return; }
          const access = ctx.state?.account?.accessLevel ?? 'Player';
          // Either GM/Admin OR the tournament creator can start.
          const s = arena.status();
          const t = s.tournaments.find((x) => x.name.toLowerCase() === tname.toLowerCase());
          if (!t) { ctx.state.sendSystemMessage(`No tournament named "${tname}".`); return; }
          const isStaff = access === 'GM' || access === 'Admin';
          if (!isStaff) {
            ctx.state.sendSystemMessage('Only the creator or staff can start a tournament.');
            return;
          }
          const r = arena.tournamentStart(api.world, tname);
          if (!r.ok) {
            const msg = {
              'no-tournament':       `No tournament named "${tname}".`,
              'already-started':     'Already started.',
              'not-enough-entrants': 'Need at least 2 entrants.',
            }[r.reason] ?? `Cannot start: ${r.reason}`;
            ctx.state.sendSystemMessage(msg);
            return;
          }
          // Broadcast to all participants.
          for (const s of r.tournament.entrants) {
            const m = mobileBySerial(api, s);
            if (m?.client) {
              try { m.client.sendSystemMessage?.(`Tournament "${r.tournament.name}" begins! Round 1 starting.`); }
              catch { /* advisory */ }
            }
          }
          ctx.state.sendSystemMessage(`Tournament "${tname}" started with ${r.tournament.entrants.length} entrants.`);
          return;
        }
        if (tsub === 'status') {
          const s = arena.status();
          if (s.tournaments.length === 0) {
            ctx.state.sendSystemMessage('No active tournaments.');
            return;
          }
          for (const t of s.tournaments) {
            const state = t.started ? `round ${t.round}` : 'open for joining';
            const champ = t.champion ? ` (champion: ${mobileBySerial(api, t.champion)?.name ?? '?'})` : '';
            ctx.state.sendSystemMessage(`  ${t.name} — ${t.entrants} entrants, ${state}${champ}`);
          }
          return;
        }
        ctx.state.sendSystemMessage('Usage: [arena t create|join|start|status <name>');
        return;
      }

      ctx.state.sendSystemMessage(
        'Usage: [arena queue 1v1|2v2 / leave / status / t create|join|start|status <name>',
      );
    },
  });

  return () => api.commands.unregister('arena');
}
