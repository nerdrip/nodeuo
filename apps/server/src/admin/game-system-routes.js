/** Live operations for the data-driven activity runtime. Authentication,
 * CSRF checks, mutation rank, and audit logging are centralized by the admin
 * server just like every other route module. */
export function registerGameSystemRoutes(routes, { sharedCtx }) {
  const runtime = () => sharedCtx?.systems?.gameSystems;
  const unavailable = () => ({ ok: false, error: 'Game-system runtime is unavailable.' });

  routes.push({
    method: 'GET', path: '/api/game-systems/catalog',
    run: ({ query }) => runtime()?.catalogSnapshot?.({
      category: query.get('category') ?? '', query: query.get('query') ?? '', includeDisabled: true,
    }) ?? unavailable(),
  });
  routes.push({
    method: 'GET', path: '/api/game-systems/catalog/:id',
    run: ({ params }) => {
      const definition = runtime()?.definition?.(params.id);
      return definition ? { ok: true, system: definition } : { ok: false, error: 'Game system not found.' };
    },
  });
  routes.push({
    method: 'GET', path: '/api/game-systems/instances',
    run: () => {
      const service = runtime();
      if (!service) return unavailable();
      return {
        ok: true,
        instances: service.serialize().instances,
        history: service.history.slice(-100),
      };
    },
  });
  routes.push({
    method: 'GET', path: '/api/game-systems/telemetry',
    run: ({ query }) => runtime()?.telemetrySnapshot?.(query.get('systemId') ?? '') ?? unavailable(),
  });
  routes.push({
    method: 'POST', path: '/api/game-systems/reload',
    run: () => runtime()?.reloadCatalog?.() ?? unavailable(),
  });
  routes.push({
    method: 'POST', path: '/api/game-systems/instances',
    run: ({ body }) => runtime()?.start?.(body?.systemId, {
      status: body?.status, startedBy: 0,
    }) ?? unavailable(),
  });
  routes.push({
    method: 'POST', path: '/api/game-systems/instances/:id/transition',
    run: ({ params, body }) => runtime()?.transition?.(params.id, body?.status) ?? unavailable(),
  });
  routes.push({
    method: 'POST', path: '/api/game-systems/simulate',
    run: ({ body }) => {
      const definition = runtime()?.definition?.(body?.systemId);
      if (!definition) return { ok: false, error: 'Game system not found.' };
      const skill = Math.max(0, Math.min(120, Number(body?.skill) || 50));
      const baseChance = 0.45 + (skill - definition.difficulty * 10) / 150;
      const tactics = [
        { id: 'execute', chanceBonus: 0, multiplier: 1.2 },
        { id: 'support', chanceBonus: 0.07, multiplier: 0.8 },
        { id: 'prepare', chanceBonus: 0.14, multiplier: 0.5 },
      ].map((tactic) => {
        const chance = Math.max(0.10, Math.min(0.98, baseChance + tactic.chanceBonus));
        return { tactic: tactic.id, successChance: Number(chance.toFixed(3)),
          expectedContribution: Number((chance * (1 + skill / 100) * tactic.multiplier).toFixed(3)) };
      });
      return {
        ok: true, dryRun: true, systemId: definition.id, skill,
        successChance: tactics[0].successChance,
        expectedContribution: tactics[0].expectedContribution,
        tactics,
        stageGoals: definition.stages.map((stage) => ({ id: stage.id, goal: stage.goal, event: stage.event })),
        entry: definition.entry,
        availability: definition.availability,
        antiExploit: definition.antiExploit,
        specializedCommands: definition.specializedCommands,
        reward: definition.reward,
      };
    },
  });
}
