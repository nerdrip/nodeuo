// `[questbook` — quest log gump.
//
// Faza H.3 UNIFICATION: previously this command sent a server-rendered
// 0xB0 gump (`api.gumps.send`) while `[questbook overlay` emitted a
// sentinel for the client-side overlay. Two gumps for the same data —
// confusing. Now `[questbook` ALSO emits the sentinel so both verbs
// route to the SAME MLQuestsGump overlay. The richer overlay wins.
//
// Active/abandon/accept actions are dispatched by the overlay via
// `[quest accept <id>` / `[quest abandon <id>` (existing commands).

import { questsSystem } from '../../_quests.js';

export default function register(api) {
  if (!api.commands) return () => {};
  const quests = questsSystem(api);
  if (!quests) {
    api.log?.('questbook: quests system unavailable');
    return () => {};
  }

  api.commands.register({
    name: 'questbook',
    help: '[questbook — open the quest log overlay.',
    access: 'Player',
    run(ctx) {
      const player = ctx.sender;
      const active = player.activeQuests ?? [];
      const available = quests.allQuests().filter((q) =>
        !active.some((a) => a.id === q.id),
      );
      const rows = (active.length ? active : available).slice(0, 30).map((q) => {
        const def = quests.allQuests().find((d) => d.id === q.id) ?? q;
        return `${def.id}|${(def.name ?? '?').replace(/[|;]/g, '_')}|${def.expansion ?? ''}`;
      }).join(';');
      ctx.state.sendSystemMessage?.(`@@OPEN_MLQUESTS_GUMP@@${rows}`);
    },
  });

  return () => api.commands.unregister('questbook');
}
