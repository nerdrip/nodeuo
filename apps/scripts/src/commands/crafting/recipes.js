// `[recipes [skill]` — list ServUO-extracted recipes available for a
// skill (or summary of all skills with recipes when called bare).
// Sourced from `data/config/recipes.json` via `api.systems.crafting`.
//
// This is reference content — players can see what's craftable in
// principle even before scripts have wired authored recipes for those
// items. Exceptional+itemId data is missing here; once authored
// recipes overlap, the runtime prefers the authored entry.

export default function (api) {
  const { commands, systems } = api;
  if (!commands || !systems?.crafting?.extractedRecipesForSkill) return () => {};

  commands.register({
    name: 'recipes',
    help: '[recipes [skill] — list ServUO craft recipes for a skill or summary',
    access: 'Player',
    run(ctx) {
      const skill = String(ctx.args[0] ?? '').toLowerCase();
      if (!skill) {
        const skills = systems.crafting.extractedRecipeSkills();
        const total = systems.crafting.extractedRecipeCount();
        ctx.state.sendSystemMessage([
          `Recipes catalog: ${total} entries across ${skills.length} skills.`,
          `Available skills: ${skills.join(', ')}`,
          'Try `[recipes <skill>` for the per-skill list.',
        ].join('\n'));
        return;
      }
      const rows = systems.crafting.extractedRecipesForSkill(skill);
      if (!rows.length) {
        ctx.state.sendSystemMessage(`No recipes recorded for skill "${skill}".`);
        return;
      }
      const lines = [`Recipes for ${skill} (${rows.length}):`];
      // Page-aware: cap to 30 entries to avoid blowing past the
      // 64KB chat-cap-per-message gate.
      const cap = 30;
      const sample = rows.slice(0, cap);
      for (const r of sample) {
        const res = (r.resources ?? [])
          .map((res) => `${res.qty}× ${res.type}`)
          .join(', ');
        lines.push(`  ${r.result.padEnd(28)} (skill ${r.minSkill}–${r.maxSkill})  ${res}`);
      }
      if (rows.length > cap) {
        lines.push(`… ${rows.length - cap} more entries omitted.`);
      }
      ctx.state.sendSystemMessage(lines.join('\n'));
    },
  });

  return () => commands.unregister('recipes');
}
