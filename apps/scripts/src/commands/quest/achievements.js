// [achievements list|progress|titles|equip <id>|clear — browse and
// equip achievement titles. Mirrors ServUO `Engines/PointsSystems/`
// achievement gump.
//
// Faza H.3 UNIFICATION: `[achievements gump|ui|browse|overlay|panel`
// all route to the same client-side AchievementProgressGump overlay
// (richer than the legacy 0xB0 paginated browser, single canonical UI
// for players).

export default function register(api) {
  if (!api.commands || !api.systems?.achievements) {
    api.log?.('cmd/achievements: missing system');
    return () => {};
  }
  const A = api.systems.achievements;

  api.commands.register({
    name: 'achievements',
    help: '[achievements list|progress|titles|equip <titleId>|clear',
    access: 'Player',
    run(ctx, args) {
      const sub = (args?.[0] ?? '').toLowerCase();
      const account = ctx.state?.account;
      if (!account) { ctx.state.sendSystemMessage('No account.'); return; }

      switch (sub) {
        case 'gump':
        case 'ui':
        case 'browse':
        case 'overlay':
        case 'panel': {
          // Faza H.3 UNIFICATION: all 5 gump-opening aliases route to
          // the SAME AchievementProgressGump overlay (gump-ui-browse-
          // overlay-panel). The legacy 0xB0 paginated server-rendered
          // version was removed — one canonical UI for players.
          const all = A.listAchievements();
          const rows = all.slice(0, 60).map((a) => {
            const got = A.isUnlocked(account, a.id) ? 1 : 0;
            return `${a.id}|${(a.name ?? '?').replace(/[|;]/g, '_')}|${got}`;
          }).join(';');
          ctx.state.sendSystemMessage?.(`@@OPEN_ACHIEVEMENTS_GUMP@@${rows}`);
          return;
        }
        case '':
        case 'list': {
          const all = A.listAchievements();
          ctx.state.sendSystemMessage(`Achievements (${(account.achievements?.unlocked?.size) | 0}/${all.length}):`);
          for (const a of all) {
            const got = A.isUnlocked(account, a.id) ? '✓' : ' ';
            ctx.state.sendSystemMessage(`  [${got}] ${a.name.padEnd(28)} — ${a.description}`);
          }
          return;
        }
        case 'progress': {
          const p = account.achievements?.progress ?? {};
          ctx.state.sendSystemMessage('Progress:');
          for (const [k, v] of Object.entries(p)) {
            ctx.state.sendSystemMessage(`  ${k.padEnd(20)} ${v}`);
          }
          return;
        }
        case 'titles': {
          const all = A.listTitles();
          const unlocked = account.titles?.unlocked ?? new Set();
          if (Array.isArray(unlocked)) account.titles.unlocked = new Set(unlocked);
          ctx.state.sendSystemMessage('Titles:');
          for (const t of all) {
            const got = (account.titles?.unlocked?.has?.(t.id)) ? '✓' : ' ';
            const eq  = account.titles?.active === t.id ? '★' : ' ';
            ctx.state.sendSystemMessage(`  [${got}]${eq} ${t.id.padEnd(28)} "${t.display}"`);
          }
          return;
        }
        case 'equip': {
          const id = args?.[1];
          if (!id) { ctx.state.sendSystemMessage('Usage: [achievements equip <titleId>'); return; }
          const ok = A.setActiveTitle(account, id);
          ctx.state.sendSystemMessage(ok ? `Now styled "${A.activeTitleDisplay(account)}".` : 'You have not earned that title.');
          return;
        }
        case 'clear': {
          A.setActiveTitle(account, null);
          ctx.state.sendSystemMessage('Title cleared.');
          return;
        }
        default:
          ctx.state.sendSystemMessage('Usage: [achievements list|progress|titles|equip <id>|clear');
      }
    },
  });
  return () => {};
}
