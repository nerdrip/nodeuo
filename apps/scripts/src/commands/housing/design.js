// [design — House Customizer command surface. Mirrors ServUO
// HouseCustomizationGump (~2.1k LOC) verbs collapsed into chat.
// The owner enters design mode, mutates tiles via paint/replace/move/
// rotate/clear, then either commits or reverts.
//
// Usage:
//   [design start                     — enter editing mode (must be owner, in own house)
//   [design floor <0..3>              — switch active floor
//   [design replace <kind> <gid>      — overwrite tile under feet (kind=floor|wall|stairs|door)
//   [design paint   <kind> <gid> <w> <h> — paint a w×h rect from feet
//   [design move    <dx> <dy>         — move tile under feet by (dx,dy)
//   [design rotate                    — rotate tile under feet
//   [design clear                     — clear all editing tiles (start fresh)
//   [design backup                    — snapshot editing tiles
//   [design restore                   — restore from backup
//   [design commit                    — commit edits to live house
//   [design revert                    — discard all edits

export default function register(api) {
  if (!api.commands || !api.houses) {
    api.log?.('cmd/design: missing api deps; skipping');
    return () => {};
  }
  const HR = api.houses;

  api.commands.register({
    name: 'design',
    help: '[design start|floor|replace|paint|move|rotate|clear|backup|restore|commit|revert',
    access: 'Player',
    run(ctx) {
      const args = ctx.args ?? [];
      const sub = String(args[0] ?? '').toLowerCase();
      const sender = ctx.sender;

      const house = HR.houseAt?.(sender.x, sender.y, sender.map);
      if (!house) { ctx.state.sendSystemMessage('You are not standing in a house.'); return; }
      if (HR.roleOf?.(house, sender.serial) !== 'owner') {
        ctx.state.sendSystemMessage('Only the owner may design this house.');
        return;
      }

      switch (sub) {
        case 'start':
          house.editing = { tiles: house.tiles?.slice?.() ?? [], floor: 0, backup: null };
          ctx.state.sendSystemMessage('Design mode entered. Use [design commit when done.');
          return;

        case 'floor': {
          const f = parseInt(args[1], 10) | 0;
          if (HR.setEditingFloor?.(house, f)) {
            ctx.state.sendSystemMessage(`Active floor: ${f}.`);
          } else {
            ctx.state.sendSystemMessage('Not in design mode (try [design start).');
          }
          return;
        }
        case 'replace': {
          const kind = String(args[1] ?? 'floor').toLowerCase();
          const gid  = parseInt(args[2], 16) || 0;
          if (!gid) { ctx.state.sendSystemMessage('Usage: [design replace <kind> <hexGid>'); return; }
          const n = HR.replaceTileAt?.(house, kind, gid, sender.x, sender.y, sender.z) ?? 0;
          ctx.state.sendSystemMessage(`Replaced (${n} tile changes).`);
          return;
        }
        case 'paint': {
          const kind = String(args[1] ?? 'floor').toLowerCase();
          const gid  = parseInt(args[2], 16) || 0;
          const w    = Math.min(20, parseInt(args[3], 10) || 1);
          const h    = Math.min(20, parseInt(args[4], 10) || 1);
          if (!gid) { ctx.state.sendSystemMessage('Usage: [design paint <kind> <hexGid> <w> <h>'); return; }
          const n = HR.paintRect?.(house, kind, gid,
            sender.x, sender.y,
            sender.x + w - 1, sender.y + h - 1,
            sender.z) ?? 0;
          ctx.state.sendSystemMessage(`Painted ${n} tile(s).`);
          return;
        }
        case 'move': {
          const dx = parseInt(args[1], 10) | 0;
          const dy = parseInt(args[2], 10) | 0;
          const n = HR.moveTileAt?.(house, sender.x, sender.y, sender.x + dx, sender.y + dy, sender.z) ?? 0;
          ctx.state.sendSystemMessage(`Moved ${n} tile(s).`);
          return;
        }
        case 'rotate': {
          const n = HR.rotateTileAt?.(house, sender.x, sender.y, sender.z) ?? 0;
          ctx.state.sendSystemMessage(`Rotated ${n} tile(s).`);
          return;
        }
        case 'clear':
          HR.clearCustomTiles?.(house);
          ctx.state.sendSystemMessage('Cleared editing tiles.');
          return;
        case 'backup':
          if (HR.backupCustom?.(house)) ctx.state.sendSystemMessage('Snapshot saved.');
          else ctx.state.sendSystemMessage('Not in design mode.');
          return;
        case 'restore':
          if (HR.restoreCustom?.(house)) ctx.state.sendSystemMessage('Snapshot restored.');
          else ctx.state.sendSystemMessage('No snapshot.');
          return;
        case 'commit':
          if (HR.commitCustom?.(house)) ctx.state.sendSystemMessage(`Committed (revision ${house.revision}).`);
          else ctx.state.sendSystemMessage('Not in design mode.');
          return;
        case 'revert':
          if (HR.revertCustom?.(house)) ctx.state.sendSystemMessage('All edits discarded.');
          else ctx.state.sendSystemMessage('Not in design mode.');
          return;
        default:
          ctx.state.sendSystemMessage('Usage: [design start|floor|replace|paint|move|rotate|clear|backup|restore|commit|revert');
      }
    },
  });
  return () => {};
}
