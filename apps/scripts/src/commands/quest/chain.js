// `[chain` — interact with major quest chains loaded from
// data/world/quest-chains.json by quests/chain-loader.js.

import { normalizeSkillValue } from '../../_rules.js';

export default function register(api) {
  if (!api.commands) return () => {};

  api.commands.register({
    name: 'chain',
    help: '[chain list|start <id>|status [id]|advance <id>',
    access: 'Player',
    run(ctx, args) {
      const sys = api.systems?.questChains;
      if (!sys) { ctx.state.sendSystemMessage('Chain system unavailable.'); return; }
      const sub = args?.[0] ?? 'list';

      if (sub === 'list') {
        const all = sys.list();
        ctx.state.sendSystemMessage(`Quest chains (${all.length}):`);
        for (const c of all) {
          const myProg = sys.status(ctx.sender, c.id);
          const mark = myProg?.completed ? '✓'
                     : myProg ? `(${myProg.stage + 1}/${c.stages.length})`
                     : '';
          ctx.state.sendSystemMessage(`  ${c.id} — ${c.title} ${mark}`);
        }
        return;
      }

      if (sub === 'start') {
        const id = args?.[1];
        if (!id) { ctx.state.sendSystemMessage('Usage: [chain start <id>'); return; }
        const r = sys.start(ctx.sender, id);
        if (!r.ok) {
          ctx.state.sendSystemMessage(`Cannot start: ${r.reason}`);
          return;
        }
        ctx.state.sendSystemMessage(`Accepted: ${r.def.title}`);
        ctx.state.sendSystemMessage(r.def.intro);
        const stage = r.def.stages[0];
        ctx.state.sendSystemMessage(`Stage 1/${r.def.stages.length}: ${stage.title}`);
        for (const obj of stage.objectives ?? []) {
          ctx.state.sendSystemMessage(`  • ${JSON.stringify(obj)}`);
        }
        return;
      }

      if (sub === 'status') {
        const id = args?.[1];
        if (id) {
          const def = sys.get(id);
          const prog = sys.status(ctx.sender, id);
          if (!prog) { ctx.state.sendSystemMessage('Not accepted.'); return; }
          ctx.state.sendSystemMessage(`${def.title} — stage ${prog.stage + 1}/${def.stages.length}${prog.completed ? ' (DONE)' : ''}`);
          const stage = def.stages[prog.stage];
          if (stage) {
            ctx.state.sendSystemMessage(`Current: ${stage.title}`);
            for (const obj of stage.objectives ?? []) {
              let counter = '?';
              if (obj.kind === 'slay') counter = `${prog.counters[`slay:${obj.target}`] ?? 0}/${obj.count ?? 1}`;
              else if (obj.kind === 'collect') counter = `${prog.counters[`collect:${obj.resource}`] ?? 0}/${obj.count ?? 1}`;
              else if (obj.kind === 'talk') counter = prog.counters[`talk:${obj.npc}`] ? 'done' : 'pending';
              else if (obj.kind === 'visit') counter = prog.counters[`visit:${obj.region}`] ? 'done' : 'pending';
              else counter = 'tracking';
              ctx.state.sendSystemMessage(`  • ${obj.kind} ${obj.target ?? obj.resource ?? obj.npc ?? obj.region ?? ''} [${counter}]`);
            }
          }
        } else {
          // List active
          const all = ctx.sender._chainQuests ?? {};
          const active = Object.entries(all).filter(([, p]) => !p.completed);
          if (!active.length) { ctx.state.sendSystemMessage('No active chains.'); return; }
          for (const [id, p] of active) {
            const def = sys.get(id);
            ctx.state.sendSystemMessage(`  ${id}: ${def?.title} — stage ${p.stage + 1}/${def?.stages?.length}`);
          }
        }
        return;
      }

      if (sub === 'advance') {
        const id = args?.[1];
        if (!id) { ctx.state.sendSystemMessage('Usage: [chain advance <id>'); return; }
        const r = sys.advance(ctx.sender, id);
        if (!r.ok) {
          ctx.state.sendSystemMessage(`Cannot advance: ${r.reason}`);
          return;
        }
        ctx.state.sendSystemMessage(`Stage cleared! Reward: ${JSON.stringify(r.reward)}`);
        // Apply reward shorthand.
        const rw = r.reward;
        if (rw.gold) ctx.sender.gold = (ctx.sender.gold | 0) + rw.gold;
        if (rw.fame) ctx.sender.fame = (ctx.sender.fame | 0) + rw.fame;
        if (rw.skill) {
          const sid = rw.skill.id | 0;
          ctx.sender.skills ??= {};
          const cur = normalizeSkillValue(ctx.sender.skills[sid] ?? ctx.sender.skills[String(sid)] ?? 0);
          ctx.sender.skills[sid] = cur + (rw.skill.amount | 0);
        }
        if (rw.virtue) {
          ctx.sender.virtues ??= {};
          const v = (ctx.sender.virtues[rw.virtue] ?? 0) + (rw.virtueAmount ?? 100);
          ctx.sender.virtues[rw.virtue] = Math.min(20000, v);
        }
        if (Array.isArray(rw.items) && api.game?.mobile?.giveItem) {
          if (!api.game.inventory?.findBackpack?.(ctx.sender)) {
            ctx.state.sendSystemMessage('You have no backpack for the reward.');
            return;
          }
          for (const tag of rw.items) {
            try {
              const tmpl = api.templates?.getTemplate?.(tag);
              const spawn = tmpl
                ? { itemId: tmpl.itemId, hue: tmpl.hue ?? 0, name: tmpl.label ?? tag }
                : { itemId: 0x14F0, name: tag };
              api.game.mobile.giveItem(ctx.sender, spawn, { randomGrid: true });
            } catch { /* no pack */ }
          }
        }
        if (rw.mastery) {
          ctx.sender.masteryUnlocked ??= new Set();
          if (Array.isArray(ctx.sender.masteryUnlocked)) ctx.sender.masteryUnlocked = new Set(ctx.sender.masteryUnlocked);
          ctx.sender.masteryUnlocked.add(`${rw.mastery.school}:${rw.mastery.spell}`);
        }
        if (r.completedChain) {
          ctx.state.sendSystemMessage('★ CHAIN COMPLETE ★');
        }
        return;
      }
    },
  });

  // Hook events to track progress automatically.
  api.lifecycle?.event?.(api.events, 'mobile:killed', (ev) => {
    const killer = ev.killer; const victim = ev.victim;
    if (!killer?._chainQuests || !victim) return;
    const sys = api.systems?.questChains;
    if (!sys) return;
    const advanced = sys.recordKill(killer, victim.kind ?? victim.template ?? '');
    for (const a of advanced) {
      killer.client?.sendSystemMessage?.(`Chain ${a.chainId} — stage ${a.stage + 1} objectives complete. Use [chain advance ${a.chainId}.`);
    }
  });

  return () => api.commands.unregister('chain');
}
