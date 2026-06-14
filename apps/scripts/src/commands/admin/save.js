// [save — force an immediate world save without waiting for the 5-min
// auto-save interval. Mirrors ServUO `Save.cs` admin command. Coalesces
// with any save already in flight via `requestSave`.

export default function (api) {
  const { commands, world, persistence } = api;
  if (!persistence) return;

  commands.register({
    name: 'save',
    help: 'Force an immediate world save.',
    access: 'Admin',
    run: (ctx) => {
      const t0 = Date.now();
      try {
        const p = persistence.requestSave?.(world, persistence.saveDir);
        if (!p) {
          // Fallback: synchronous path.
          persistence.saveWorldSync?.(world, persistence.saveDir);
          ctx.state.sendSystemMessage(`World saved (sync) in ${Date.now() - t0}ms.`);
          return;
        }
        ctx.state.sendSystemMessage('Save scheduled…');
        p.then(({ bytes, ms }) => {
          ctx.state.sendSystemMessage?.(`World saved (${bytes}B, ${ms}ms).`);
        }).catch((e) => {
          ctx.state.sendSystemMessage?.(`Save failed: ${e.message}`);
        });
      } catch (e) {
        ctx.state.sendSystemMessage(`Save failed: ${e.message}`);
      }
    },
  });

  return () => commands.unregister('save');
}
