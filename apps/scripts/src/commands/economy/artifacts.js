// `[artifacts` — admin/info command for the artifact registry.
//
// Subcommands:
//   [artifacts list                — count + first 30 unique-spawned names
//   [artifacts catalog [filter]    — list artifact profiles (cap 30)
//   [artifacts release <name>      — admin: free a name from the spawned set
//   [artifacts spawn <name>        — admin: spawn the named artifact in pack
//   [artifacts clear               — admin: forget every spawned name
//
// Uses `api.artifactUniqueness` (registry) and `api.systems.loot` if
// exposed; falls back to direct loot.js helpers via api.loot.

export default function (api) {
  const { commands } = api;
  if (!commands) return () => {};
  const uniq = api.artifactUniqueness;

  commands.register({
    name: 'artifacts',
    help: '[artifacts <list|catalog|release|spawn|clear> — manage artifact registry',
    access: 'Player',
    run(ctx) {
      const sub = String(ctx.args[0] ?? 'list').toLowerCase();
      const arg = ctx.args.slice(1).join(' ');
      const access = ctx.state?.account?.accessLevel;
      const isStaff = access === 'GM' || access === 'GameMaster'
        || access === 'Admin' || access === 'Administrator';

      if (sub === 'list') {
        if (!uniq) {
          ctx.state.sendSystemMessage('Artifact registry not available.');
          return;
        }
        const names = uniq.list();
        const cap = 30;
        const head = `Unique artifacts spawned: ${names.length}.`;
        if (!names.length) { ctx.state.sendSystemMessage(head); return; }
        const sample = names.slice(0, cap).map((n) => `  ${n}`);
        const tail = names.length > cap ? [`  … ${names.length - cap} more.`] : [];
        ctx.state.sendSystemMessage([head, ...sample, ...tail].join('\n'));
        return;
      }

      if (sub === 'catalog') {
        // Loot-side helper: api.loot doesn't expose allArtifacts; we
        // import via api.systems.loot when present.
        const arts = api.systems?.loot?.allArtifacts?.() ?? api.loot?.allArtifacts?.();
        if (!arts) {
          ctx.state.sendSystemMessage('Artifact catalog not loaded.');
          return;
        }
        const filter = arg ? new RegExp(arg, 'i') : null;
        const matches = filter ? arts.filter((a) => filter.test(a.name)) : arts;
        const cap = 30;
        const head = `Artifact catalog: ${arts.length} entries${filter ? ` (${matches.length} match)` : ''}.`;
        const sample = matches.slice(0, cap).map((a) => `  ${a.name}${a.base ? ` <${a.base}>` : ''}`);
        const tail = matches.length > cap ? [`  … ${matches.length - cap} more.`] : [];
        ctx.state.sendSystemMessage([head, ...sample, ...tail].join('\n'));
        return;
      }

      if (sub === 'release') {
        if (!isStaff) { ctx.state.sendSystemMessage('GM only.'); return; }
        if (!uniq || !arg) { ctx.state.sendSystemMessage('Usage: [artifacts release <name>'); return; }
        uniq.release(arg);
        ctx.state.sendSystemMessage(`Released "${arg}" from the unique-spawned set.`);
        return;
      }

      if (sub === 'clear') {
        if (!isStaff) { ctx.state.sendSystemMessage('GM only.'); return; }
        if (!uniq) return;
        const before = uniq.size();
        uniq.clear();
        ctx.state.sendSystemMessage(`Cleared ${before} entries from the unique-spawned set.`);
        return;
      }

      if (sub === 'spawn') {
        if (!isStaff) { ctx.state.sendSystemMessage('GM only.'); return; }
        if (!arg) { ctx.state.sendSystemMessage('Usage: [artifacts spawn <name>'); return; }
        const arts = api.systems?.loot?.allArtifacts?.() ?? api.loot?.allArtifacts?.();
        if (!arts) { ctx.state.sendSystemMessage('Artifact catalog not loaded.'); return; }
        const target = arts.find((a) => a.name === arg)
                    ?? arts.find((a) => a.name.toLowerCase() === arg.toLowerCase());
        if (!target) { ctx.state.sendSystemMessage(`No such artifact: ${arg}`); return; }
        // Resolve base graphic via itemTypes resolver.
        const r = api.itemTypes?.resolve?.(target.base ?? target.name)
               ?? api.itemTypes?.resolve?.(target.name);
        const itemId = r?.itemId ?? 0x1F1C;
        const mob = ctx.sender;
        // Spawn into the GM's pack.
        const item = api.game?.mobile?.giveItem?.(mob, {
          itemId,
          hue: 0,
          amount: 1,
          name: target.name,
        }, { requireBackpack: false, randomGrid: true });
        if (!item) { ctx.state.sendSystemMessage('Spawn failed.'); return; }
        item._artifact = target.name;
        item._magicProps = [
          ...(target.skillBonuses ?? []).map((b) => ({ kind: 'skill', skill: b.skill, value: b.value })),
          ...Object.entries(target.attributes ?? {}).map(([k, v]) => ({ kind: 'attr', attribute: k, intensity: v })),
        ];
        if (target.resists) item._magicResists = target.resists;
        uniq?.recordSpawn(target.name);
        ctx.state.sendSystemMessage(`Spawned ${target.name} into your pack.`);
        return;
      }

      ctx.state.sendSystemMessage('Usage: [artifacts <list|catalog|release|spawn|clear>');
    },
  });

  return () => commands.unregister('artifacts');
}
