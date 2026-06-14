// `[pvp` — unified status command across all 3 coexisting PvP systems
// (factions, VvV, ethics) and PvP arena queues.
//
//   [pvp           — full report: your faction / VvV side / ethics tier /
//                    arena status + active sigil corruption + VvV city
//                    holders + ethics power list.
//   [pvp leave     — opt out of every PvP system at once (clean slate).
//   [pvp factions  — show only the factions snapshot.
//   [pvp vvv       — show only the VvV snapshot.
//   [pvp ethics    — show only the ethics snapshot.
//
// This is a *reporting* surface. Each underlying system has its own
// join/leave commands; this command just makes the three-system mess
// legible at a glance.

function showFactions(ctx, mob, factions) {
  const rank = factions.rankOf(mob);
  const fk = mob.factionKey ?? null;
  if (!fk) { ctx.state.sendSystemMessage?.('  Factions: not enlisted'); return; }
  const cfg = factions.FACTIONS[fk];
  ctx.state.sendSystemMessage?.(
    `  Factions: ${cfg?.name ?? fk}  rank ${rank ?? '-'}  kills ${mob.factionKills ?? 0}`,
  );
}

function showVvV(ctx, mob, vvv) {
  const side = vvv.sideOf(mob);
  if (!side) { ctx.state.sendSystemMessage?.('  VvV: not signed up'); return; }
  ctx.state.sendSystemMessage?.(`  VvV side: ${side}  points: ${vvv.points(mob) ?? 0}`);
  // Cities currently held.
  try {
    const holders = vvv.VVV_CONST.cities
      ? vvv.VVV_CONST.cities.map((c) => `${c}:${vvv.holderOf(c) ?? '-'}`).join(' / ')
      : '(no city table)';
    ctx.state.sendSystemMessage?.(`  Cities: ${holders}`);
  } catch { /* tolerate */ }
}

function showEthics(ctx, mob, ethics) {
  const align = ethics.alignmentOf(mob);
  const tier = ethics.tierOf(mob);
  if (!align) { ctx.state.sendSystemMessage?.('  Ethics: unaligned'); return; }
  ctx.state.sendSystemMessage?.(`  Ethics: ${align}  tier ${tier ?? '-'}`);
}

function showArena(ctx, mob, arena) {
  const s = arena.status();
  ctx.state.sendSystemMessage?.(
    `  Arena: queue 1v1=${s.queue1v1.length}, 2v2=${s.queue2v2.length}, active matches=${s.matches.length}`,
  );
  ctx.state.sendSystemMessage?.(
    `  Your status: ${arena.isInMatch(mob) ? 'IN MATCH' : 'not in a match'}`,
  );
}

export default function register(api) {
  if (!api.commands) return () => {};
  const factions = api.systems?.factions ?? {
    FACTIONS: {},
    rankOf: () => ({ rank: '-', name: '-' }),
    leaveFaction: () => false,
  };
  const vvv = api.systems?.vvv ?? {
    sideOf: () => null,
    points: () => 0,
    citiesUnderSide: () => [],
    leave: () => false,
    VVV_CONST: { cities: [] },
  };
  const ethics = api.systems?.ethics ?? {
    alignmentOf: () => null,
    tierOf: () => null,
    leave: () => false,
  };
  const arena = api.systems?.pvpArena ?? {
    status: () => ({ queue1v1: [], queue2v2: [], matches: [] }),
    isInMatch: () => false,
    leave: () => false,
  };

  api.commands.register({
    name: 'pvp',
    help: '[pvp / [pvp factions|vvv|ethics|leave — unified PvP status across all systems.',
    access: 'Player',
    run(ctx) {
      const sub = String(ctx.args[0] ?? '').toLowerCase();
      const mob = ctx.sender;

      if (sub === 'leave') {
        try { factions.leaveFaction?.(mob, { force: true }); } catch { /* ignore */ }
        try { vvv.leave?.(mob); } catch { /* ignore */ }
        try { ethics.leave?.(mob); } catch { /* ignore */ }
        try { arena.leave(mob); } catch { /* ignore */ }
        ctx.state.sendSystemMessage?.('You have opted out of all PvP systems.');
        return;
      }

      if (sub === 'factions') { showFactions(ctx, mob, factions); return; }
      if (sub === 'vvv')      { showVvV(ctx, mob, vvv); return; }
      if (sub === 'ethics')   { showEthics(ctx, mob, ethics); return; }
      // Faza H.2 — `[pvp gump <view>` opens the rich VvV overlay.
      // Views: battle (default) / members / stats / rewards / missions / standard.
      if (sub === 'gump') {
        const view = String(ctx.args[1] ?? 'battle').toLowerCase();
        const side = vvv.sideOf?.(mob) ?? 'none';
        const pts  = vvv.points?.(mob) ?? 0;
        const cities = vvv.citiesUnderSide?.(side)?.join(',') ?? '';
        ctx.state.sendSystemMessage?.(`@@OPEN_VVV_GUMP@@${view}|${side}|${pts}|${cities}`);
        return;
      }

      // Default — full report.
      ctx.state.sendSystemMessage?.(`PvP status for ${mob.name ?? '?'}:`);
      showFactions(ctx, mob, factions);
      showVvV(ctx, mob, vvv);
      showEthics(ctx, mob, ethics);
      showArena(ctx, mob, arena);
    },
  });

  return () => api.commands.unregister('pvp');
}
