// `[questbook` — quest log gump.
//
// Phase H.3 UNIFICATION: previously this command sent a server-rendered
// 0xB0 gump (`api.gumps.send`) while `[questbook overlay` emitted a
// sentinel for the client-side overlay. Two gumps for the same data —
// confusing. Now `[questbook` ALSO emits the sentinel so both verbs
// route to the SAME MLQuestsGump overlay. The richer overlay wins.
//
// Active/abandon/accept actions are dispatched by the overlay via
// `[quest accept <id>` / `[quest abandon <id>` (existing commands).

import { questsSystem } from '../../_quests.js';
import { destroyItemBySerial } from '../../_items.js';

export default function register(api) {
  if (!api.commands) return () => {};
  const quests = questsSystem(api);
  const ml = api.mlQuests ?? api.systems?.mlQuests;
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
      const mlActive = ml?.listActive?.(player) ?? [];
      const available = quests.allQuests().filter((q) =>
        !active.some((a) => a.id === q.id),
      );
      const source = active.length ? active : (mlActive.length ? mlActive : available);
      const rows = source.slice(0, 30).map((q) => {
        const def = quests.allQuests().find((d) => d.id === q.id) ?? q;
        return `${def.id}|${(def.name ?? def.title ?? '?').replace(/[|;]/g, '_')}|${def.expansion ?? ''}`;
      }).join(';');
      ctx.state.sendSystemMessage?.(`@@OPEN_MLQUESTS_GUMP@@${rows}`);
    },
  });

  // The ML quest engine is separate from the older authored quest registry.
  // Give both enhanced and classic clients a complete, text-command fallback
  // for status, abandon and reward collection.
  if (ml) api.commands.register({
    name: 'mlquest',
    help: '[mlquest status|abandon|turn <id> [choice] — manage Mondain quests.',
    access: 'Player',
    run(ctx) {
      const action = String(ctx.args?.[0] ?? 'status').toLowerCase();
      const id = String(ctx.args?.[1] ?? '');
      if (action === 'status') {
        const rows = ml.listActive?.(ctx.sender) ?? [];
        if (!rows.length) return ctx.state.sendSystemMessage?.('You have no active Mondain quests.');
        ctx.state.sendSystemMessage?.(rows.map((q) =>
          `${q.id}: ${q.title ?? q.id}${q.turnedIn ? ' [claimed]' : q.completed ? ' [complete]' : ''}`,
        ).join('\n'));
        return;
      }
      const progress = ctx.sender.mlQuests?.find?.((q) => q.id === id);
      if (!progress) return ctx.state.sendSystemMessage?.('That Mondain quest is not active.');
      if (action === 'abandon') {
        ml.abandon?.(ctx.sender, id);
        ctx.state.sendSystemMessage?.(`Quest abandoned: ${id}.`);
        return;
      }
      if (action !== 'turn') {
        ctx.state.sendSystemMessage?.('Usage: [mlquest status|abandon|turn <id> [choice]');
        return;
      }
      if (!progress.completed || progress.turnedIn) {
        ctx.state.sendSystemMessage?.(progress.turnedIn
          ? 'That reward has already been claimed.' : 'The objectives are not complete.');
        return;
      }
      const def = ml.getQuest?.(id);
      const choiceKey = String(ctx.args?.[2] ?? '');
      let chosen = null;
      if (def?.rewardChoices?.length) {
        chosen = def.rewardChoices.find((row) => row.key === choiceKey);
        if (!chosen) {
          ctx.state.sendSystemMessage?.(`Choose one: ${def.rewardChoices.map((row) => row.key).join(', ')}`);
          return;
        }
      }
      const itemRewards = [
        ...(def?.rewards ?? []).filter((row) => row.type === 'item'),
        ...(chosen?.item ? [{ type: 'item', ...chosen.item }] : []),
      ];
      if (itemRewards.length && !api.game?.mobile?.giveItem) {
        ctx.state.sendSystemMessage?.('Item reward delivery is unavailable; nothing was consumed.');
        return;
      }
      const delivered = [];
      try {
        for (const reward of itemRewards) {
          const item = api.game.mobile.giveItem(ctx.sender, {
            type: reward.itemType ?? reward.typeId ?? reward.template
              ?? (reward.type !== 'item' ? reward.type : undefined),
            definitionId: reward.definitionId,
            itemId: reward.itemId,
            name: reward.name,
            hue: reward.hue ?? 0,
            amount: reward.amount ?? 1,
          }, { randomGrid: true });
          if (!item) throw new Error(`cannot create ${reward.itemType ?? reward.name ?? 'item reward'}`);
          delivered.push(item);
        }
        const rewards = ml.turnIn?.(ctx.sender, id) ?? [];
        if (!rewards.length && !(def?.rewards?.length === 0)) throw new Error('quest turn-in was rejected');
        if (chosen) progress.rewardChoice = chosen.key;
        ctx.state.sendSystemMessage?.(`Quest complete: ${def?.title ?? id}. Reward delivered.`);
      } catch (error) {
        for (const item of delivered) destroyItemBySerial(api, item);
        ctx.state.sendSystemMessage?.(`Reward delivery failed; the quest remains claimable (${error.message}).`);
      }
    },
  });

  return () => {
    api.commands.unregister('questbook');
    if (ml) api.commands.unregister('mlquest');
  };
}
